#!/usr/bin/env python3
"""
Standalone VAE Training Script for tsnotfyi
Phase 1 of VAE Integration

Trains a Variational Autoencoder on 18D music features from PostgreSQL
and writes the learned 8D latent embeddings back to the database.

Usage:
    python train_music_vae.py --config tsnotfyi-config.json
    python train_music_vae.py --host localhost --port 5432 --database music --user postgres
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import logging

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler
import psycopg2
import psycopg2.extras

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class MusicVAE(nn.Module):
    """
    Variational Autoencoder for music feature learning.
    Based on AutoEncoder from agent-vomit but optimized for music data.
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
            hidden_dims = [64, 32]  # Compress gradually: 18 -> 64 -> 32 -> 8
        
        # Encoder
        encoder_layers = []
        prev_dim = input_dim
        for dim in hidden_dims:
            encoder_layers.extend([
                nn.Linear(prev_dim, dim),
                nn.GELU(),  # Better than ReLU for music data
                nn.Dropout(dropout)
            ])
            prev_dim = dim
        self.encoder = nn.Sequential(*encoder_layers)
        
        # Variational latent space
        self.latent_mu = nn.Linear(hidden_dims[-1], latent_dim)
        self.latent_logvar = nn.Linear(hidden_dims[-1], latent_dim)
        
        # Decoder
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
        """Encode input to latent parameters."""
        encoded = self.encoder(x)
        mu = self.latent_mu(encoded)
        logvar = self.latent_logvar(encoded)
        return mu, logvar
    
    def reparameterize(self, mu: torch.Tensor, logvar: torch.Tensor) -> torch.Tensor:
        """Reparameterization trick for VAE."""
        std = torch.exp(0.5 * logvar)
        eps = torch.randn_like(std)
        return mu + eps * std
    
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        """Decode latent vector to reconstruction."""
        return self.decoder(z)
    
    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        """Forward pass returning all components."""
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
        """Encode to latent space deterministically (using mu only)."""
        mu, _ = self.encode(x)
        return mu

class MusicVAETrainer:
    """Handles training and database operations for Music VAE."""
    
    def __init__(self, db_config: Dict):
        self.db_config = db_config
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        logger.info(f"Using device: {self.device}")
        
        # Core 18 features matching the analysis document
        self.core_features = [
            'bpm', 'danceability', 'onset_rate', 'beat_punch',
            'tonal_clarity', 'tuning_purity', 'fifths_strength',
            'chord_strength', 'chord_change_rate', 'crest', 'entropy',
            'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
            'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
        ]
        
        self.scaler = StandardScaler()
        self.model = None
        
    def connect_db(self):
        """Connect to PostgreSQL database."""
        return psycopg2.connect(
            host=self.db_config['host'],
            port=self.db_config['port'],
            database=self.db_config['database'],
            user=self.db_config['user'],
            password=self.db_config.get('password') or os.getenv('PGPASSWORD')
        )
    
    def load_training_data(self) -> Tuple[np.ndarray, List[str]]:
        """Load 18D features from PostgreSQL for training."""
        logger.info("Loading training data from PostgreSQL...")
        
        conn = self.connect_db()
        try:
            # Build query for core features
            columns = ['identifier'] + self.core_features
            query = f"""
                SELECT {', '.join(columns)}
                FROM music_analysis 
                WHERE identifier IS NOT NULL
                AND {' IS NOT NULL AND '.join(self.core_features)} IS NOT NULL
                ORDER BY identifier
            """
            
            df = pd.read_sql_query(query, conn)
            logger.info(f"Loaded {len(df):,} tracks with complete feature data")
            
            if len(df) < 1000:
                logger.warning(f"Only {len(df)} tracks available - VAE may be unstable (recommend 1000+)")
            
            # Extract features and identifiers
            identifiers = df['identifier'].tolist()
            features = df[self.core_features].values
            
            # Check for NaN values
            nan_mask = np.isnan(features).any(axis=1)
            if nan_mask.any():
                logger.warning(f"Removing {nan_mask.sum()} tracks with NaN values")
                features = features[~nan_mask]
                identifiers = [id for i, id in enumerate(identifiers) if not nan_mask[i]]
            
            logger.info(f"Final training dataset: {len(identifiers):,} tracks x {len(self.core_features)} features")
            return features, identifiers
            
        finally:
            conn.close()
    
    def train_vae(self, features: np.ndarray, epochs: int = 100, batch_size: int = 128) -> MusicVAE:
        """Train the VAE on music features."""
        logger.info("Training VAE on music features...")
        
        # Normalize features
        features_scaled = self.scaler.fit_transform(features)
        
        # Create PyTorch dataset
        dataset = TensorDataset(torch.FloatTensor(features_scaled))
        dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
        
        # Initialize model
        self.model = MusicVAE(
            input_dim=len(self.core_features),
            latent_dim=8,
            hidden_dims=[64, 32],
            beta=4.0,  # β-VAE for disentanglement
            dropout=0.1
        ).to(self.device)
        
        # Optimizer
        optimizer = optim.Adam(self.model.parameters(), lr=1e-3)
        
        # Training loop
        self.model.train()
        for epoch in range(epochs):
            total_loss = 0
            total_recon_loss = 0
            total_kl_loss = 0
            
            for batch_idx, (data,) in enumerate(dataloader):
                data = data.to(self.device)
                
                optimizer.zero_grad()
                
                # Forward pass
                outputs = self.model(data)
                
                # Compute losses
                recon_loss = nn.MSELoss()(outputs['reconstruction'], data)
                kl_loss = -0.5 * torch.sum(1 + outputs['logvar'] - outputs['mu'].pow(2) - outputs['logvar'].exp(), dim=1).mean()
                loss = recon_loss + self.model.beta * kl_loss
                
                # Backward pass
                loss.backward()
                optimizer.step()
                
                total_loss += loss.item()
                total_recon_loss += recon_loss.item()
                total_kl_loss += kl_loss.item()
            
            # Log progress
            if (epoch + 1) % 10 == 0:
                avg_loss = total_loss / len(dataloader)
                avg_recon = total_recon_loss / len(dataloader)
                avg_kl = total_kl_loss / len(dataloader)
                logger.info(f"Epoch {epoch+1:3d}/{epochs}: Loss={avg_loss:.4f} (Recon={avg_recon:.4f}, KL={avg_kl:.4f})")
        
        logger.info("VAE training completed")
        return self.model
    
    def compute_embeddings(self, features: np.ndarray, identifiers: List[str]) -> Dict[str, np.ndarray]:
        """Compute VAE embeddings for all tracks."""
        logger.info("Computing VAE embeddings...")
        
        self.model.eval()
        embeddings = {}
        
        with torch.no_grad():
            # Process in batches
            batch_size = 1000
            features_scaled = self.scaler.transform(features)
            
            for i in range(0, len(features_scaled), batch_size):
                batch_features = torch.FloatTensor(features_scaled[i:i+batch_size]).to(self.device)
                batch_identifiers = identifiers[i:i+batch_size]
                
                # Get deterministic embeddings (using mu, not sampling)
                batch_embeddings = self.model.encode_deterministic(batch_features).cpu().numpy()
                
                # Store embeddings by identifier
                for identifier, embedding in zip(batch_identifiers, batch_embeddings):
                    embeddings[identifier] = embedding
        
        logger.info(f"Computed embeddings for {len(embeddings):,} tracks")
        return embeddings
    
    def save_embeddings_to_db(self, embeddings: Dict[str, np.ndarray], model_version: str):
        """Save VAE embeddings back to PostgreSQL."""
        logger.info("Saving embeddings to database...")
        
        conn = self.connect_db()
        try:
            cursor = conn.cursor()
            
            # Prepare update query
            update_query = """
                UPDATE music_analysis SET
                    vae_latent_0 = %s, vae_latent_1 = %s, vae_latent_2 = %s, vae_latent_3 = %s,
                    vae_latent_4 = %s, vae_latent_5 = %s, vae_latent_6 = %s, vae_latent_7 = %s,
                    vae_model_version = %s, vae_computed_at = CURRENT_TIMESTAMP
                WHERE identifier = %s
            """
            
            # Batch update
            update_data = []
            for identifier, embedding in embeddings.items():
                row = list(embedding) + [model_version, identifier]
                update_data.append(row)
            
            cursor.executemany(update_query, update_data)
            conn.commit()
            
            logger.info(f"Successfully saved {len(embeddings):,} embeddings to database")
            
            # Verify the update
            cursor.execute("SELECT COUNT(*) FROM music_analysis WHERE vae_latent_0 IS NOT NULL")
            count = cursor.fetchone()[0]
            logger.info(f"Database now contains {count:,} tracks with VAE embeddings")
            
        except Exception as e:
            conn.rollback()
            logger.error(f"Failed to save embeddings: {e}")
            raise
        finally:
            conn.close()
    
    def save_model(self, model_path: str):
        """Save trained model and scaler."""
        logger.info(f"Saving model to {model_path}")
        
        model_path = Path(model_path)
        model_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save model state and metadata
        torch.save({
            'model_state_dict': self.model.state_dict(),
            'scaler': self.scaler,
            'core_features': self.core_features,
            'model_config': {
                'input_dim': len(self.core_features),
                'latent_dim': 8,
                'hidden_dims': [64, 32],
                'beta': 4.0
            }
        }, model_path)
        
        logger.info("Model saved successfully")

def load_config(config_path: str) -> Dict:
    """Load database configuration from tsnotfyi config file."""
    with open(config_path, 'r') as f:
        config = json.load(f)
    
    # Extract PostgreSQL config
    pg_config = config['database']['postgresql']
    return {
        'host': pg_config['host'],
        'port': pg_config['port'],
        'database': pg_config['database'],
        'user': pg_config['user'],
        'password': pg_config.get('password')
    }

def main():
    parser = argparse.ArgumentParser(description='Train VAE on music features')
    parser.add_argument('--config', help='Path to tsnotfyi-config.json')
    parser.add_argument('--host', default='localhost', help='PostgreSQL host')
    parser.add_argument('--port', type=int, default=5432, help='PostgreSQL port')
    parser.add_argument('--database', default='music', help='PostgreSQL database')
    parser.add_argument('--user', default='postgres', help='PostgreSQL user')
    parser.add_argument('--password', help='PostgreSQL password (or use PGPASSWORD env var)')
    parser.add_argument('--epochs', type=int, default=100, help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=128, help='Batch size')
    parser.add_argument('--model-path', default='./models/music_vae.pt', help='Path to save trained model')
    
    args = parser.parse_args()
    
    # Get database config
    if args.config:
        db_config = load_config(args.config)
    else:
        db_config = {
            'host': args.host,
            'port': args.port,
            'database': args.database,
            'user': args.user,
            'password': args.password
        }
    
    # Initialize trainer
    trainer = MusicVAETrainer(db_config)
    
    try:
        # Load training data
        features, identifiers = trainer.load_training_data()
        
        # Train VAE
        model = trainer.train_vae(features, epochs=args.epochs, batch_size=args.batch_size)
        
        # Compute embeddings
        embeddings = trainer.compute_embeddings(features, identifiers)
        
        # Save to database
        model_version = f"v1.0_{int(time.time())}"
        trainer.save_embeddings_to_db(embeddings, model_version)
        
        # Save model
        trainer.save_model(args.model_path)
        
        logger.info("VAE training and database update completed successfully!")
        logger.info(f"Model saved to: {args.model_path}")
        logger.info(f"Model version: {model_version}")
        
    except Exception as e:
        logger.error(f"Training failed: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()