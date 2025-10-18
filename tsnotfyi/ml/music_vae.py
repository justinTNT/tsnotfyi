"""
Music VAE Module
Adapted from agent-vomit for tsnotfyi music exploration

Provides VAE model definition and utilities for music feature learning.
"""

import torch
import torch.nn as nn
from typing import Dict, List, Tuple, Optional
import numpy as np
from sklearn.preprocessing import StandardScaler


class MusicVAE(nn.Module):
    """
    Variational Autoencoder optimized for music feature learning.
    Based on AutoEncoder from agent-vomit but specialized for 18D music features.
    """
    
    def __init__(
        self,
        input_dim: int = 18,
        latent_dim: int = 8,
        hidden_dims: List[int] = None,
        beta: float = 4.0,
        dropout: float = 0.1
    ):
        super().__init__()
        
        self.input_dim = input_dim
        self.latent_dim = latent_dim
        self.beta = beta
        
        if hidden_dims is None:
            hidden_dims = [64, 32]  # Default architecture: 18 → 64 → 32 → 8
        
        self.hidden_dims = hidden_dims
        
        # Encoder network
        encoder_layers = []
        prev_dim = input_dim
        for dim in hidden_dims:
            encoder_layers.extend([
                nn.Linear(prev_dim, dim),
                nn.GELU(),  # GELU works better than ReLU for music data
                nn.Dropout(dropout)
            ])
            prev_dim = dim
        self.encoder = nn.Sequential(*encoder_layers)
        
        # Variational latent space projections
        self.latent_mu = nn.Linear(hidden_dims[-1], latent_dim)
        self.latent_logvar = nn.Linear(hidden_dims[-1], latent_dim)
        
        # Decoder network
        decoder_layers = []
        prev_dim = latent_dim
        for dim in reversed(hidden_dims):
            decoder_layers.extend([
                nn.Linear(prev_dim, dim),
                nn.GELU(),
                nn.Dropout(dropout)
            ])
            prev_dim = dim
        decoder_layers.append(nn.Linear(prev_dim, input_dim))
        self.decoder = nn.Sequential(*decoder_layers)
    
    def encode(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """Encode input to latent parameters (mu, logvar)."""
        if x.dim() == 1:
            x = x.unsqueeze(0)  # Add batch dimension if needed
            
        encoded = self.encoder(x)
        mu = self.latent_mu(encoded)
        logvar = self.latent_logvar(encoded)
        return mu, logvar
    
    def reparameterize(self, mu: torch.Tensor, logvar: torch.Tensor) -> torch.Tensor:
        """Reparameterization trick for VAE training."""
        std = torch.exp(0.5 * logvar)
        eps = torch.randn_like(std)
        return mu + eps * std
    
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        """Decode latent vector to feature reconstruction."""
        if z.dim() == 1:
            z = z.unsqueeze(0)  # Add batch dimension if needed
            
        return self.decoder(z)
    
    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        """Full forward pass for training."""
        mu, logvar = self.encode(x)
        z = self.reparameterize(mu, logvar)
        reconstruction = self.decode(z)
        
        return {
            'reconstruction': reconstruction,
            'mu': mu,
            'logvar': logvar,
            'z': z
        }
    
    def encode_deterministic(self, x: torch.Tensor) -> torch.Tensor:
        """Deterministic encoding (using mu only, no sampling)."""
        mu, _ = self.encode(x)
        return mu


class MusicVAEInference:
    """
    Inference wrapper for the Music VAE model.
    Handles model loading, preprocessing, and inference operations.
    """
    
    def __init__(self, device: str = 'auto'):
        if device == 'auto':
            self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        else:
            self.device = torch.device(device)
            
        self.model = None
        self.scaler = None
        self.feature_names = None
        self.model_config = None
        self.is_loaded = False
        
        print(f"MusicVAE inference using device: {self.device}")
    
    def load_model(self, model_path: str) -> Dict:
        """Load trained VAE model and preprocessing components."""
        try:
            # Load model checkpoint
            checkpoint = torch.load(model_path, map_location=self.device)
            
            # Extract components
            model_state = checkpoint['model_state_dict']
            self.scaler = checkpoint['scaler']
            self.feature_names = checkpoint['core_features']
            self.model_config = checkpoint['model_config']
            
            # Initialize model with saved configuration
            self.model = MusicVAE(**self.model_config)
            self.model.load_state_dict(model_state)
            self.model.to(self.device)
            self.model.eval()
            
            self.is_loaded = True
            
            return {
                'status': 'success',
                'model_info': {
                    'input_dim': self.model_config['input_dim'],
                    'latent_dim': self.model_config['latent_dim'],
                    'hidden_dims': self.model_config.get('hidden_dims', [64, 32]),
                    'feature_names': self.feature_names,
                    'device': str(self.device)
                }
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f"Failed to load model: {str(e)}"
            }
    
    def preprocess_features(self, features: List[float]) -> torch.Tensor:
        """Preprocess raw features for model input."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        if len(features) != len(self.feature_names):
            raise ValueError(f"Expected {len(self.feature_names)} features, got {len(features)}")
        
        # Convert to numpy and reshape for scaler
        features_np = np.array(features).reshape(1, -1)
        
        # Apply normalization
        features_scaled = self.scaler.transform(features_np)
        
        # Convert to tensor
        return torch.FloatTensor(features_scaled).to(self.device)
    
    def postprocess_features(self, features_tensor: torch.Tensor) -> List[float]:
        """Postprocess model output back to original feature space."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        # Convert to numpy
        features_np = features_tensor.detach().cpu().numpy()
        
        # Inverse transform normalization
        features_original = self.scaler.inverse_transform(features_np)
        
        # Return as list
        return features_original.flatten().tolist()
    
    def encode(self, features: List[float]) -> List[float]:
        """Encode features to latent space."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        with torch.no_grad():
            # Preprocess
            x = self.preprocess_features(features)
            
            # Encode (deterministic)
            latent = self.model.encode_deterministic(x)
            
            # Return as list
            return latent.cpu().numpy().flatten().tolist()
    
    def decode(self, latent: List[float]) -> List[float]:
        """Decode latent vector to features."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        if len(latent) != self.model.latent_dim:
            raise ValueError(f"Expected {self.model.latent_dim}D latent vector, got {len(latent)}")
        
        with torch.no_grad():
            # Convert to tensor
            z = torch.FloatTensor(latent).unsqueeze(0).to(self.device)
            
            # Decode
            reconstruction = self.model.decode(z)
            
            # Postprocess
            return self.postprocess_features(reconstruction)
    
    def interpolate(self, features_a: List[float], features_b: List[float], steps: int = 10) -> List[List[float]]:
        """Interpolate between two tracks in latent space."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        with torch.no_grad():
            # Encode both tracks
            latent_a = torch.FloatTensor(self.encode(features_a)).to(self.device)
            latent_b = torch.FloatTensor(self.encode(features_b)).to(self.device)
            
            # Create interpolation steps
            alphas = torch.linspace(0, 1, steps).to(self.device)
            
            interpolation = []
            for alpha in alphas:
                # Linear interpolation in latent space
                latent_interp = (1 - alpha) * latent_a + alpha * latent_b
                
                # Decode back to features
                features_interp = self.decode(latent_interp.cpu().numpy().tolist())
                interpolation.append(features_interp)
            
            return interpolation
    
    def flow(self, features: List[float], direction: List[float], amount: float = 1.0) -> List[float]:
        """Move in latent space from starting point."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded")
            
        if len(direction) != self.model.latent_dim:
            raise ValueError(f"Direction must be {self.model.latent_dim}D, got {len(direction)}")
        
        with torch.no_grad():
            # Encode starting point
            latent_start = torch.FloatTensor(self.encode(features)).to(self.device)
            direction_tensor = torch.FloatTensor(direction).to(self.device)
            
            # Move in direction
            latent_moved = latent_start + amount * direction_tensor
            
            # Decode result
            return self.decode(latent_moved.cpu().numpy().tolist())
    
    def get_info(self) -> Dict:
        """Get model and latent space information."""
        if not self.is_loaded:
            return {'error': 'Model not loaded'}
        
        return {
            'model_config': self.model_config,
            'feature_names': self.feature_names,
            'device': str(self.device),
            'latent_dim': self.model.latent_dim,
            'input_dim': self.model.input_dim,
            'architecture': f"{self.model.input_dim} → {' → '.join(map(str, self.model.hidden_dims))} → {self.model.latent_dim}"
        }


def create_random_direction(latent_dim: int = 8, normalize: bool = True) -> List[float]:
    """Create a random direction vector in latent space."""
    direction = torch.randn(latent_dim)
    
    if normalize:
        direction = direction / torch.norm(direction)
    
    return direction.tolist()


def interpolate_in_latent_space(latent_a: List[float], latent_b: List[float], steps: int = 10) -> List[List[float]]:
    """Pure latent space interpolation (no model required)."""
    latent_a = torch.FloatTensor(latent_a)
    latent_b = torch.FloatTensor(latent_b)
    
    alphas = torch.linspace(0, 1, steps)
    
    interpolation = []
    for alpha in alphas:
        latent_interp = (1 - alpha) * latent_a + alpha * latent_b
        interpolation.append(latent_interp.tolist())
    
    return interpolation