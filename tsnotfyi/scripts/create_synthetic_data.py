#!/usr/bin/env python3
"""
Create synthetic music analysis data for VAE POC demonstration.

This generates realistic 18D feature data that mimics real music analysis,
allowing us to test the VAE approach without requiring a full music database.
"""

import argparse
import logging
import sqlite3
import numpy as np
import pandas as pd
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Core 18 features with realistic ranges
FEATURE_SPECS = {
    # Rhythmic features
    'bpm': {'min': 60, 'max': 200, 'distribution': 'normal', 'mean': 120, 'std': 25},
    'danceability': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 2, 'beta': 2},
    'onset_rate': {'min': 0.5, 'max': 8.0, 'distribution': 'gamma', 'shape': 2, 'scale': 1},
    'beat_punch': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 1.5, 'beta': 3},
    
    # Tonal features
    'tonal_clarity': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 3, 'beta': 2},
    'tuning_purity': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 4, 'beta': 2},
    'fifths_strength': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 2, 'beta': 3},
    'chord_strength': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 2.5, 'beta': 2},
    'chord_change_rate': {'min': 0.0, 'max': 5.0, 'distribution': 'gamma', 'shape': 1.5, 'scale': 0.8},
    'crest': {'min': 1.0, 'max': 20.0, 'distribution': 'lognormal', 'mean': 2, 'sigma': 0.5},
    'entropy': {'min': 0.0, 'max': 8.0, 'distribution': 'gamma', 'shape': 3, 'scale': 1.5},
    
    # Spectral features
    'spectral_centroid': {'min': 500, 'max': 8000, 'distribution': 'lognormal', 'mean': 8.5, 'sigma': 0.3},
    'spectral_rolloff': {'min': 1000, 'max': 15000, 'distribution': 'lognormal', 'mean': 9, 'sigma': 0.2},
    'spectral_kurtosis': {'min': 0, 'max': 100, 'distribution': 'gamma', 'shape': 2, 'scale': 8},
    'spectral_energy': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 2, 'beta': 3},
    'spectral_flatness': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 1, 'beta': 4},
    'sub_drive': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 1.5, 'beta': 4},
    'air_sizzle': {'min': 0.0, 'max': 1.0, 'distribution': 'beta', 'alpha': 1, 'beta': 5},
}

CORE_FEATURES = list(FEATURE_SPECS.keys())

def generate_feature_value(feature_name, n_samples):
    """Generate realistic values for a specific feature"""
    spec = FEATURE_SPECS[feature_name]
    
    if spec['distribution'] == 'normal':
        values = np.random.normal(spec['mean'], spec['std'], n_samples)
        values = np.clip(values, spec['min'], spec['max'])
        
    elif spec['distribution'] == 'beta':
        values = np.random.beta(spec['alpha'], spec['beta'], n_samples)
        values = values * (spec['max'] - spec['min']) + spec['min']
        
    elif spec['distribution'] == 'gamma':
        values = np.random.gamma(spec['shape'], spec['scale'], n_samples)
        values = np.clip(values, spec['min'], spec['max'])
        
    elif spec['distribution'] == 'lognormal':
        values = np.random.lognormal(spec['mean'], spec['sigma'], n_samples)
        values = np.clip(values, spec['min'], spec['max'])
        
    else:
        # Fallback to uniform
        values = np.random.uniform(spec['min'], spec['max'], n_samples)
    
    return values

def add_genre_correlations(data):
    """Add realistic genre-based correlations between features"""
    n_samples = len(data)
    
    # Create genre-like clusters
    genre_assignments = np.random.choice(5, n_samples)  # 5 genres
    
    for i, genre in enumerate(genre_assignments):
        if genre == 0:  # Electronic/Dance
            data.loc[i, 'bpm'] = np.clip(np.random.normal(128, 8), 120, 140)
            data.loc[i, 'danceability'] = np.clip(np.random.beta(4, 1), 0.7, 1.0)
            data.loc[i, 'sub_drive'] = np.clip(np.random.beta(3, 1), 0.6, 1.0)
            
        elif genre == 1:  # Rock/Metal
            data.loc[i, 'crest'] = np.clip(np.random.lognormal(2.5, 0.3), 3, 15)
            data.loc[i, 'spectral_energy'] = np.clip(np.random.beta(4, 1), 0.6, 1.0)
            data.loc[i, 'air_sizzle'] = np.clip(np.random.beta(3, 1), 0.4, 1.0)
            
        elif genre == 2:  # Classical
            data.loc[i, 'tonal_clarity'] = np.clip(np.random.beta(5, 1), 0.7, 1.0)
            data.loc[i, 'chord_strength'] = np.clip(np.random.beta(4, 1), 0.6, 1.0)
            data.loc[i, 'spectral_centroid'] = np.clip(np.random.normal(2500, 500), 1500, 4000)
            
        elif genre == 3:  # Jazz
            data.loc[i, 'chord_change_rate'] = np.clip(np.random.gamma(2, 1), 2, 5)
            data.loc[i, 'entropy'] = np.clip(np.random.gamma(4, 1), 4, 8)
            data.loc[i, 'spectral_flatness'] = np.clip(np.random.beta(2, 2), 0.3, 0.8)
            
        elif genre == 4:  # Ambient
            data.loc[i, 'beat_punch'] = np.clip(np.random.beta(1, 4), 0.0, 0.3)
            data.loc[i, 'onset_rate'] = np.clip(np.random.gamma(1, 0.5), 0.5, 2)
            data.loc[i, 'crest'] = np.clip(np.random.lognormal(1.5, 0.2), 1, 5)
    
    return data

def generate_synthetic_data(n_tracks=5000, with_correlations=True):
    """Generate synthetic music analysis data"""
    logger.info(f"Generating {n_tracks:,} synthetic tracks...")
    
    # Generate identifiers (MD5-like)
    identifiers = [f"{np.random.randint(10**15, 10**16-1):016x}" + 
                  f"{np.random.randint(10**15, 10**16-1):016x}" for _ in range(n_tracks)]
    
    # Generate base features
    data = pd.DataFrame({'identifier': identifiers})
    
    for feature in CORE_FEATURES:
        data[feature] = generate_feature_value(feature, n_tracks)
    
    # Add realistic correlations
    if with_correlations:
        data = add_genre_correlations(data)
    
    # Add some noise and natural correlations
    # BPM affects other rhythmic features
    bpm_factor = (data['bpm'] - 120) / 80  # Normalized around 120 BPM
    data['danceability'] += bpm_factor * 0.1
    data['onset_rate'] += bpm_factor * 0.5
    
    # Spectral centroid affects other spectral features  
    centroid_factor = (data['spectral_centroid'] - 3000) / 5000
    data['spectral_rolloff'] += centroid_factor * 2000
    data['air_sizzle'] += centroid_factor * 0.2
    
    # Clip all values to valid ranges
    for feature in CORE_FEATURES:
        spec = FEATURE_SPECS[feature]
        data[feature] = np.clip(data[feature], spec['min'], spec['max'])
    
    logger.info(f"Generated {len(data):,} tracks with {len(CORE_FEATURES)} features")
    
    return data

def add_pca_columns(data):
    """Add PCA columns (will be computed by PCA system later)"""
    n_tracks = len(data)
    
    # Add empty PCA columns that would be computed by the real PCA system
    pca_columns = [
        'primary_d', 'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
        'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
        'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
    ]
    
    for col in pca_columns:
        data[col] = np.random.normal(0, 1, n_tracks)  # Placeholder values
    
    return data

def create_database(data, db_path):
    """Create SQLite database with synthetic data"""
    logger.info(f"Creating database at {db_path}")
    
    # Remove existing database
    if Path(db_path).exists():
        Path(db_path).unlink()
    
    conn = sqlite3.connect(db_path)
    
    # Create music_analysis table
    create_table_sql = """
    CREATE TABLE music_analysis (
        identifier TEXT PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- Core 18 features
        bpm REAL,
        danceability REAL,
        onset_rate REAL,
        beat_punch REAL,
        tonal_clarity REAL,
        tuning_purity REAL,
        fifths_strength REAL,
        chord_strength REAL,
        chord_change_rate REAL,
        crest REAL,
        entropy REAL,
        spectral_centroid REAL,
        spectral_rolloff REAL,
        spectral_kurtosis REAL,
        spectral_energy REAL,
        spectral_flatness REAL,
        sub_drive REAL,
        air_sizzle REAL,
        
        -- PCA 10 features
        primary_d REAL,
        tonal_pc1 REAL,
        tonal_pc2 REAL,
        tonal_pc3 REAL,
        spectral_pc1 REAL,
        spectral_pc2 REAL,
        spectral_pc3 REAL,
        rhythmic_pc1 REAL,
        rhythmic_pc2 REAL,
        rhythmic_pc3 REAL,
        
        -- VAE 8 features (will be populated by VAE training)
        vae_0 REAL,
        vae_1 REAL,
        vae_2 REAL,
        vae_3 REAL,
        vae_4 REAL,
        vae_5 REAL,
        vae_6 REAL,
        vae_7 REAL
    )
    """
    
    conn.execute(create_table_sql)
    
    # Insert data
    data.to_sql('music_analysis', conn, if_exists='append', index=False)
    
    # Create indexes
    conn.execute("CREATE INDEX idx_bpm ON music_analysis(bpm)")
    conn.execute("CREATE INDEX idx_spectral_centroid ON music_analysis(spectral_centroid)")
    conn.execute("CREATE INDEX idx_primary_d ON music_analysis(primary_d)")
    
    conn.commit()
    conn.close()
    
    logger.info(f"✅ Database created with {len(data):,} tracks")

def main():
    parser = argparse.ArgumentParser(description='Generate synthetic music data for VAE POC')
    parser.add_argument('--tracks', type=int, default=5000, help='Number of tracks to generate')
    parser.add_argument('--output', default='synthetic_music.db', help='Output database path')
    parser.add_argument('--no-correlations', action='store_true', 
                       help='Disable genre-based correlations')
    
    args = parser.parse_args()
    
    try:
        # Generate data
        data = generate_synthetic_data(args.tracks, not args.no_correlations)
        
        # Add PCA columns
        data = add_pca_columns(data)
        
        # Create database
        create_database(data, args.output)
        
        # Show sample
        print("\nSample data (first 3 rows):")
        print(data[CORE_FEATURES[:5]].head(3).to_string())
        
        print(f"\n🎉 Synthetic dataset created: {args.output}")
        print(f"   Tracks: {len(data):,}")
        print(f"   Features: {len(CORE_FEATURES)} core + 10 PCA + 8 VAE (empty)")
        print(f"   Ready for VAE training!")
        
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        raise

if __name__ == '__main__':
    main()