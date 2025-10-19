#!/usr/bin/env python3
"""
Music VAE for learning non-linear embeddings from 18D Essentia features.

This VAE learns an 8-dimensional latent representation from the 18 core audio features,
providing a non-linear alternative to PCA for music similarity search.

Architecture:
- Input: 18D feature vector (Essentia analysis)
- Latent: 8D embedding (different from PCA's 10D to avoid duplication)
- Encoder: 18 -> 64 -> 32 -> 16 (mu/logvar)
- Decoder: 8 -> 16 -> 32 -> 64 -> 18
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import json
import argparse
import sys
import os
from pathlib import Path

class MusicVAE(nn.Module):
    def __init__(self, input_dim=18, latent_dim=8, hidden_dims=[64, 32], beta=4.0):
        super().__init__()
        self.input_dim = input_dim
        self.latent_dim = latent_dim
        self.beta = beta
        
        # Encoder
        encoder_layers = []
        in_dim = input_dim
        for hidden_dim in hidden_dims:
            encoder_layers.extend([
                nn.Linear(in_dim, hidden_dim),
                nn.ReLU(),
                nn.Dropout(0.1)
            ])
            in_dim = hidden_dim
        
        self.encoder = nn.Sequential(*encoder_layers)
        
        # Latent space projections
        self.fc_mu = nn.Linear(hidden_dims[-1], latent_dim)
        self.fc_logvar = nn.Linear(hidden_dims[-1], latent_dim)
        
        # Decoder
        decoder_layers = []
        in_dim = latent_dim
        for hidden_dim in reversed(hidden_dims):
            decoder_layers.extend([
                nn.Linear(in_dim, hidden_dim),
                nn.ReLU(),
                nn.Dropout(0.1)
            ])
            in_dim = hidden_dim
        
        # Final reconstruction layer (no activation - raw features)
        decoder_layers.append(nn.Linear(in_dim, input_dim))
        self.decoder = nn.Sequential(*decoder_layers)
        
    def encode(self, x):
        """Encode input to latent distribution parameters"""
        h = self.encoder(x)
        mu = self.fc_mu(h)
        logvar = self.fc_logvar(h)
        return mu, logvar
    
    def reparameterize(self, mu, logvar):
        """Reparameterization trick for differentiable sampling"""
        if self.training:
            std = torch.exp(0.5 * logvar)
            eps = torch.randn_like(std)
            return mu + eps * std
        else:
            return mu  # Use mean during inference
    
    def decode(self, z):
        """Decode latent vector to reconstruction"""
        return self.decoder(z)
    
    def forward(self, x):
        """Full VAE forward pass"""
        mu, logvar = self.encode(x)
        z = self.reparameterize(mu, logvar)
        x_recon = self.decode(z)
        
        return {
            'reconstruction': x_recon,
            'mu': mu,
            'logvar': logvar,
            'latent': z
        }
    
    def compute_loss(self, x, output):
        """Compute β-VAE loss"""
        x_recon = output['reconstruction']
        mu = output['mu']
        logvar = output['logvar']
        
        # Reconstruction loss (MSE for continuous features)
        recon_loss = F.mse_loss(x_recon, x, reduction='mean')
        
        # KL divergence loss
        kl_loss = -0.5 * torch.mean(1 + logvar - mu.pow(2) - logvar.exp())
        
        # β-VAE total loss
        total_loss = recon_loss + self.beta * kl_loss
        
        return {
            'loss': total_loss,
            'recon_loss': recon_loss,
            'kl_loss': kl_loss
        }
    
    def encode_features(self, features):
        """Encode music features to latent space (inference only)"""
        self.eval()
        with torch.no_grad():
            if isinstance(features, np.ndarray):
                features = torch.FloatTensor(features)
            if features.dim() == 1:
                features = features.unsqueeze(0)
            
            mu, _ = self.encode(features)
            return mu.cpu().numpy()

class MusicVAETrainer:
    def __init__(self, model, lr=1e-3, device='cpu'):
        self.model = model.to(device)
        self.device = device
        self.optimizer = torch.optim.Adam(model.parameters(), lr=lr)
        try:
            self.scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
                self.optimizer, mode='min', factor=0.8, patience=10, verbose=True
            )
        except TypeError:
            # PyTorch <1.4 does not accept the verbose kwarg on ReduceLROnPlateau
            self.scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
                self.optimizer, mode='min', factor=0.8, patience=10
            )
        
    def train_epoch(self, dataloader):
        """Train for one epoch"""
        self.model.train()
        total_loss = 0
        total_recon = 0
        total_kl = 0
        
        for batch in dataloader:
            if isinstance(batch, (list, tuple)):
                x = batch[0].to(self.device)
            else:
                x = batch.to(self.device)
            
            self.optimizer.zero_grad()
            
            output = self.model(x)
            loss_dict = self.model.compute_loss(x, output)
            
            loss_dict['loss'].backward()
            
            # Gradient clipping for stability
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), max_norm=1.0)
            
            self.optimizer.step()
            
            total_loss += loss_dict['loss'].item()
            total_recon += loss_dict['recon_loss'].item()
            total_kl += loss_dict['kl_loss'].item()
        
        n_batches = len(dataloader)
        return {
            'loss': total_loss / n_batches,
            'recon_loss': total_recon / n_batches,
            'kl_loss': total_kl / n_batches
        }
    
    def validate(self, dataloader):
        """Validate model"""
        self.model.eval()
        total_loss = 0
        total_recon = 0
        total_kl = 0
        
        with torch.no_grad():
            for batch in dataloader:
                if isinstance(batch, (list, tuple)):
                    x = batch[0].to(self.device)
                else:
                    x = batch.to(self.device)
                
                output = self.model(x)
                loss_dict = self.model.compute_loss(x, output)
                
                total_loss += loss_dict['loss'].item()
                total_recon += loss_dict['recon_loss'].item()
                total_kl += loss_dict['kl_loss'].item()
        
        n_batches = len(dataloader)
        return {
            'loss': total_loss / n_batches,
            'recon_loss': total_recon / n_batches,
            'kl_loss': total_kl / n_batches
        }

def load_model(model_path, device='cpu'):
    """Load trained VAE model"""
    checkpoint = torch.load(model_path, map_location=device)
    
    model = MusicVAE(
        input_dim=checkpoint.get('input_dim', 18),
        latent_dim=checkpoint.get('latent_dim', 8),
        hidden_dims=checkpoint.get('hidden_dims', [64, 32]),
        beta=checkpoint.get('beta', 4.0)
    )
    
    model.load_state_dict(checkpoint['model_state_dict'])
    model.eval()
    return model

def save_model(model, model_path, metadata=None):
    """Save VAE model with metadata"""
    checkpoint = {
        'model_state_dict': model.state_dict(),
        'input_dim': model.input_dim,
        'latent_dim': model.latent_dim,
        'beta': model.beta,
    }
    
    if metadata:
        checkpoint.update(metadata)
    
    torch.save(checkpoint, model_path)

def encode_batch(model, features_batch):
    """Encode a batch of features to latent space"""
    model.eval()
    with torch.no_grad():
        if isinstance(features_batch, np.ndarray):
            features_batch = torch.FloatTensor(features_batch)
        
        mu, _ = model.encode(features_batch)
        return mu.cpu().numpy()

# JSON-RPC Interface for VAE Service
def json_rpc_handler():
    """Handle JSON-RPC requests for VAE encoding"""
    line = sys.stdin.readline()
    if not line:
        return
    
    try:
        request = json.loads(line.strip())
        action = request.get('action')
        
        if action == 'encode':
            features = np.array(request['features'])
            if features.ndim == 1:
                features = features.reshape(1, -1)
            
            # Load model (you'd cache this in production)
            model_path = request.get('model_path', 'models/music_vae.pt')
            model = load_model(model_path)
            
            # Encode features
            latent = encode_batch(model, features)
            
            response = {
                'result': latent.tolist(),
                'status': 'success'
            }
        else:
            response = {
                'error': f'Unknown action: {action}',
                'status': 'error'
            }
    
    except Exception as e:
        response = {
            'error': str(e),
            'status': 'error'
        }
    
    print(json.dumps(response))
    sys.stdout.flush()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Music VAE Service')
    parser.add_argument('--mode', choices=['train', 'encode', 'jsonrpc'], 
                       default='jsonrpc', help='Operation mode')
    parser.add_argument('--model-path', default='models/music_vae.pt',
                       help='Path to VAE model')
    parser.add_argument('--data-path', help='Path to training data')
    parser.add_argument('--epochs', type=int, default=100, help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=64, help='Batch size')
    parser.add_argument('--lr', type=float, default=1e-3, help='Learning rate')
    parser.add_argument('--beta', type=float, default=4.0, help='β-VAE parameter')
    
    args = parser.parse_args()
    
    if args.mode == 'jsonrpc':
        json_rpc_handler()
    elif args.mode == 'train':
        print("Training mode not implemented in this POC")
        sys.exit(1)
    elif args.mode == 'encode':
        print("Encode mode not implemented in this POC")  
        sys.exit(1)
