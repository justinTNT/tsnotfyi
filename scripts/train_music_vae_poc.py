#!/usr/bin/env python3
"""
Train Music VAE and generate embeddings for all tracks in the database.

This script:
1. Extracts 18D features from the database
2. Trains a VAE (18D -> 8D latent)
3. Generates VAE embeddings for all tracks
4. Updates the database with VAE columns

Usage:
    python scripts/train_music_vae_poc.py --database-type postgres
    python scripts/train_music_vae_poc.py --database-type sqlite --db-path ./path/to/db.db
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler

# Add parent directory to path to import services
sys.path.insert(0, str(Path(__file__).parent.parent / 'tsnotfyi' / 'services'))
from musicVAE import MusicVAE, MusicVAETrainer, save_model

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Core 18 features (must match beets2tsnot.py order)
CORE_FEATURES = [
    'bpm', 'danceability', 'onset_rate', 'beat_punch',
    'tonal_clarity', 'tuning_purity', 'fifths_strength',
    'chord_strength', 'chord_change_rate', 'crest', 'entropy',
    'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
    'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
]

def load_training_data(database_type='postgres', db_path=None, pg_config=None):
    """Load 18D feature data from database"""
    logger.info("Loading training data from database...")
    
    if database_type == 'postgres':
        try:
            import psycopg2
        except ImportError:
            raise ImportError("psycopg2 not installed. Install with: pip install psycopg2-binary")
        
        pg_config = pg_config or {
            'host': 'localhost',
            'port': 5432,
            'database': 'tsnotfyi',
            'user': os.environ.get('POSTGRES_USER', 'postgres'),
            'password': os.environ.get('POSTGRES_PASSWORD', '')
        }
        
        logger.info(f"Connecting to PostgreSQL: {pg_config['host']}:{pg_config['port']}/{pg_config['database']}")
        
        try:
            conn = psycopg2.connect(**pg_config)
        except psycopg2.OperationalError as e:
            logger.error(f"Failed to connect to PostgreSQL: {e}")
            logger.info("Ensure PostgreSQL is running and accessible")
            logger.info("You can start PostgreSQL with: brew services start postgresql")
            raise
        
    elif database_type == 'sqlite':
        import sqlite3
        if not db_path:
            raise ValueError("SQLite database path required")
        conn = sqlite3.connect(db_path)
        
    else:
        raise ValueError(f"Unsupported database type: {database_type}")
    
    # Build query for 18 core features + identifier
    columns = ['identifier'] + CORE_FEATURES
    query = f"""
    SELECT {', '.join(columns)} 
    FROM music_analysis 
    WHERE {' AND '.join(f'{col} IS NOT NULL' for col in CORE_FEATURES)}
    """
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    logger.info(f"Loaded {len(df):,} tracks with complete feature data")
    
    if len(df) < 100:
        logger.warning(f"Only {len(df)} tracks available - may be insufficient for VAE training")
    
    # Extract features and identifiers
    identifiers = df['identifier'].values
    features = df[CORE_FEATURES].values
    
    # Check for any remaining NaN/inf values
    if np.any(np.isnan(features)) or np.any(np.isinf(features)):
        logger.warning("Found NaN/inf values in features - cleaning...")
        features = np.nan_to_num(features, nan=0.0, posinf=1e6, neginf=-1e6)
    
    return identifiers, features

def prepare_data(features, train_split=0.8, batch_size=64):
    """Prepare data for VAE training"""
    logger.info("Preparing training data...")
    
    # Standardize features
    scaler = StandardScaler()
    features_scaled = scaler.fit_transform(features)
    
    # Convert to torch tensors
    features_tensor = torch.FloatTensor(features_scaled)
    
    # Train/validation split
    n_train = int(len(features_scaled) * train_split)
    train_features = features_tensor[:n_train]
    val_features = features_tensor[n_train:]
    
    # Create data loaders
    train_dataset = TensorDataset(train_features)
    val_dataset = TensorDataset(val_features)
    
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)
    
    logger.info(f"Training set: {len(train_features):,} samples")
    logger.info(f"Validation set: {len(val_features):,} samples")
    
    return train_loader, val_loader, scaler

def train_vae(train_loader, val_loader, epochs=100, lr=1e-3, beta=4.0, device='cpu'):
    """Train the Music VAE"""
    logger.info("Initializing Music VAE...")
    
    model = MusicVAE(
        input_dim=18,
        latent_dim=8,
        hidden_dims=[64, 32],
        beta=beta
    )
    
    trainer = MusicVAETrainer(model, lr=lr, device=device)
    
    logger.info(f"Training VAE for {epochs} epochs (β={beta}, lr={lr})...")
    logger.info(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")
    
    best_val_loss = float('inf')
    patience = 15
    patience_counter = 0
    
    for epoch in range(epochs):
        # Training
        train_metrics = trainer.train_epoch(train_loader)
        
        # Validation
        val_metrics = trainer.validate(val_loader)
        
        # Logging
        if epoch % 10 == 0 or epoch == epochs - 1:
            logger.info(f"Epoch {epoch+1:3d}/{epochs} | "
                       f"Train Loss: {train_metrics['loss']:.4f} "
                       f"(Recon: {train_metrics['recon_loss']:.4f}, "
                       f"KL: {train_metrics['kl_loss']:.4f}) | "
                       f"Val Loss: {val_metrics['loss']:.4f}")
        
        # Early stopping
        if val_metrics['loss'] < best_val_loss:
            best_val_loss = val_metrics['loss']
            patience_counter = 0
            # Save best model
            best_model_state = model.state_dict().copy()
        else:
            patience_counter += 1
            if patience_counter >= patience:
                logger.info(f"Early stopping at epoch {epoch+1} (patience={patience})")
                break
        
        # Update learning rate
        trainer.scheduler.step(val_metrics['loss'])
    
    # Load best model
    model.load_state_dict(best_model_state)
    logger.info(f"Training complete. Best validation loss: {best_val_loss:.4f}")
    
    return model

def generate_embeddings(model, identifiers, features, scaler, batch_size=256):
    """Generate VAE embeddings for all tracks"""
    logger.info("Generating VAE embeddings for all tracks...")
    
    model.eval()
    device = next(model.parameters()).device
    
    # Standardize features using training scaler
    features_scaled = scaler.transform(features)
    features_tensor = torch.FloatTensor(features_scaled)
    
    # Generate embeddings in batches
    all_embeddings = []
    with torch.no_grad():
        for i in range(0, len(features_tensor), batch_size):
            batch = features_tensor[i:i+batch_size].to(device)
            mu, _ = model.encode(batch)  # Use mean for deterministic embeddings
            all_embeddings.append(mu.cpu().numpy())
    
    embeddings = np.vstack(all_embeddings)
    logger.info(f"Generated {len(embeddings):,} VAE embeddings (8D)")
    
    return embeddings

def save_embeddings_to_database(identifiers, embeddings, database_type='postgres', db_path=None, pg_config=None):
    """Save VAE embeddings back to database"""
    logger.info("Saving VAE embeddings to database...")
    
    if database_type == 'postgres':
        import psycopg2
        pg_config = pg_config or {
            'host': 'localhost',
            'port': 5432,
            'database': 'tsnotfyi',
            'user': 'postgres',
            'password': os.environ.get('POSTGRES_PASSWORD')
        }
        conn = psycopg2.connect(**pg_config)
        
    elif database_type == 'sqlite':
        import sqlite3
        if not db_path:
            raise ValueError("SQLite database path required")
        conn = sqlite3.connect(db_path)
    
    # Prepare update data
    vae_columns = [f'vae_{i}' for i in range(8)]
    
    if database_type == 'postgres':
        with conn.cursor() as cur:
            for i, identifier in enumerate(identifiers):
                embedding = embeddings[i]
                
                # Build update query
                set_clause = ', '.join(f'{col} = %s' for col in vae_columns)
                query = f"UPDATE music_analysis SET {set_clause} WHERE identifier = %s"
                
                cur.execute(query, list(embedding) + [identifier])
                
                if (i + 1) % 1000 == 0:
                    logger.info(f"Updated {i+1:,}/{len(identifiers):,} tracks")
        
        conn.commit()
        
    elif database_type == 'sqlite':
        cur = conn.cursor()
        
        for i, identifier in enumerate(identifiers):
            embedding = embeddings[i]
            
            # Build update query
            set_clause = ', '.join(f'{col} = ?' for col in vae_columns)
            query = f"UPDATE music_analysis SET {set_clause} WHERE identifier = ?"
            
            cur.execute(query, list(embedding) + [identifier])
            
            if (i + 1) % 1000 == 0:
                logger.info(f"Updated {i+1:,}/{len(identifiers):,} tracks")
        
        conn.commit()
    
    conn.close()
    logger.info(f"✅ Saved {len(identifiers):,} VAE embeddings to database")

def check_database_connection(database_type='postgres', db_path=None, pg_config=None):
    """Check database connection and show data summary"""
    logger.info("Checking database connection and data availability...")
    
    try:
        if database_type == 'postgres':
            import psycopg2
            pg_config = pg_config or {
                'host': 'localhost',
                'port': 5432,
                'database': 'tsnotfyi',
                'user': os.environ.get('POSTGRES_USER', 'postgres'),
                'password': os.environ.get('POSTGRES_PASSWORD', '')
            }
            
            conn = psycopg2.connect(**pg_config)
            
            with conn.cursor() as cur:
                # Check if music_analysis table exists
                cur.execute("""
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = 'music_analysis'
                    )
                """)
                table_exists = cur.fetchone()[0]
                
                if not table_exists:
                    logger.error("music_analysis table does not exist")
                    return False
                
                # Check total tracks
                cur.execute("SELECT COUNT(*) FROM music_analysis")
                total_tracks = cur.fetchone()[0]
                
                # Check tracks with complete core features
                feature_check = f"SELECT COUNT(*) FROM music_analysis WHERE {' AND '.join(f'{col} IS NOT NULL' for col in CORE_FEATURES)}"
                cur.execute(feature_check)
                complete_tracks = cur.fetchone()[0]
                
                # Check VAE columns
                cur.execute("""
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = 'music_analysis' AND column_name LIKE 'vae_%'
                    ORDER BY column_name
                """)
                vae_columns = [row[0] for row in cur.fetchall()]
                
            conn.close()
            
        elif database_type == 'sqlite':
            import sqlite3
            if not db_path or not Path(db_path).exists():
                logger.error(f"SQLite database not found: {db_path}")
                return False
                
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            
            # Check table
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='music_analysis'")
            if not cur.fetchone():
                logger.error("music_analysis table does not exist")
                return False
            
            # Check counts
            cur.execute("SELECT COUNT(*) FROM music_analysis")
            total_tracks = cur.fetchone()[0]
            
            feature_check = f"SELECT COUNT(*) FROM music_analysis WHERE {' AND '.join(f'{col} IS NOT NULL' for col in CORE_FEATURES)}"
            cur.execute(feature_check)
            complete_tracks = cur.fetchone()[0]
            
            # Check VAE columns
            cur.execute("PRAGMA table_info(music_analysis)")
            columns = [row[1] for row in cur.fetchall()]
            vae_columns = [col for col in columns if col.startswith('vae_')]
            
            conn.close()
        
        # Report findings
        logger.info(f"✅ Database connection successful")
        logger.info(f"   Total tracks: {total_tracks:,}")
        logger.info(f"   Complete feature data: {complete_tracks:,}")
        logger.info(f"   VAE columns: {len(vae_columns)} ({', '.join(vae_columns)})")
        
        if complete_tracks < 100:
            logger.warning(f"Only {complete_tracks} tracks with complete data - may be insufficient for VAE training")
        
        return complete_tracks > 0
        
    except Exception as e:
        logger.error(f"❌ Database check failed: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Train Music VAE and generate embeddings')
    parser.add_argument('--database-type', choices=['postgres', 'sqlite'], default='postgres',
                       help='Database type')
    parser.add_argument('--db-path', help='SQLite database path (required for SQLite)')
    parser.add_argument('--check-db', action='store_true', help='Just check database connection and exit')
    parser.add_argument('--epochs', type=int, default=100, help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=64, help='Batch size')
    parser.add_argument('--lr', type=float, default=1e-3, help='Learning rate')
    parser.add_argument('--beta', type=float, default=4.0, help='β-VAE parameter')
    parser.add_argument('--device', default='cpu', help='Training device (cpu/cuda)')
    parser.add_argument('--model-save-path', default='./models/music_vae.pt',
                       help='Path to save trained model')
    
    args = parser.parse_args()
    
    # Just check database connection if requested
    if args.check_db:
        success = check_database_connection(args.database_type, args.db_path)
        if success:
            logger.info("🎉 Database check completed successfully!")
        else:
            logger.error("❌ Database check failed")
            sys.exit(1)
        return
    
    # Create models directory
    models_dir = Path(args.model_save_path).parent
    models_dir.mkdir(exist_ok=True)
    
    # Check device
    device = args.device
    if device == 'cuda' and not torch.cuda.is_available():
        logger.warning("CUDA not available, using CPU")
        device = 'cpu'
    
    try:
        # 0. Check database first
        if not check_database_connection(args.database_type, args.db_path):
            logger.error("Database check failed - cannot proceed")
            sys.exit(1)
        
        # 1. Load training data
        identifiers, features = load_training_data(args.database_type, args.db_path)
        
        # 2. Prepare data
        train_loader, val_loader, scaler = prepare_data(features, batch_size=args.batch_size)
        
        # 3. Train VAE
        model = train_vae(train_loader, val_loader, 
                         epochs=args.epochs, lr=args.lr, beta=args.beta, device=device)
        
        # 4. Save model
        metadata = {
            'scaler_mean': scaler.mean_.tolist(),
            'scaler_scale': scaler.scale_.tolist(),
            'feature_names': CORE_FEATURES,
            'training_samples': len(features),
            'hidden_dims': [64, 32]
        }
        save_model(model, args.model_save_path, metadata)
        logger.info(f"✅ Model saved to {args.model_save_path}")
        
        # 5. Generate embeddings for all tracks
        embeddings = generate_embeddings(model, identifiers, features, scaler)
        
        # 6. Save embeddings to database
        save_embeddings_to_database(identifiers, embeddings, args.database_type, args.db_path)
        
        logger.info("🎉 VAE training and embedding generation complete!")
        
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        raise

if __name__ == '__main__':
    main()