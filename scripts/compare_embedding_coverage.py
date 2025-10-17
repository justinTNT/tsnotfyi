#!/usr/bin/env python3
"""
Compare coverage and reachability across different embedding spaces using server APIs.

This script runs all three core analysis tools and generates a comprehensive
comparison report between embedding types (Core, PCA, VAE, Combined).

Usage:
    python scripts/compare_embedding_coverage.py --sample-tracks 1000 --radius 0.3
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests
import subprocess

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Core 18 features + PCA 10 features + VAE 8 features
CORE_FEATURES = [
    'bpm', 'danceability', 'onset_rate', 'beat_punch',
    'tonal_clarity', 'tuning_purity', 'fifths_strength',
    'chord_strength', 'chord_change_rate', 'crest', 'entropy',
    'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
    'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
]

PCA_FEATURES = [
    'primary_d', 'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
    'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
    'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
]

VAE_FEATURES = [f'vae_{i}' for i in range(8)]

def load_all_embeddings(database_type='postgres', db_path=None, pg_config=None):
    """Load all embedding types from database"""
    logger.info("Loading all embeddings from database...")
    
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
    
    # Build query for all features
    all_features = ['identifier'] + CORE_FEATURES + PCA_FEATURES + VAE_FEATURES
    
    # Check which VAE columns exist
    if database_type == 'postgres':
        cur = conn.cursor()
        cur.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'music_analysis' AND column_name LIKE 'vae_%'
        """)
        existing_vae_cols = [row[0] for row in cur.fetchall()]
        cur.close()
    else:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(music_analysis)")
        columns = [row[1] for row in cur.fetchall()]
        existing_vae_cols = [col for col in columns if col.startswith('vae_')]
        cur.close()
    
    logger.info(f"Found VAE columns: {existing_vae_cols}")
    
    # Adjust VAE features based on what exists
    available_vae = [col for col in VAE_FEATURES if col in existing_vae_cols]
    
    if not available_vae:
        logger.warning("No VAE embeddings found - will compare only Core vs PCA")
        comparison_features = CORE_FEATURES + PCA_FEATURES
    else:
        comparison_features = CORE_FEATURES + PCA_FEATURES + available_vae
    
    query_features = ['identifier'] + comparison_features
    
    # Build query with NULL checks for all features
    query = f"""
    SELECT {', '.join(query_features)}
    FROM music_analysis 
    WHERE {' AND '.join(f'{col} IS NOT NULL' for col in comparison_features)}
    """
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    logger.info(f"Loaded {len(df):,} tracks with complete embedding data")
    logger.info(f"Available embeddings: Core({len(CORE_FEATURES)}), PCA({len(PCA_FEATURES)}), VAE({len(available_vae)})")
    
    # Extract embeddings by type
    embeddings = {
        'identifiers': df['identifier'].values,
        'core': df[CORE_FEATURES].values,
        'pca': df[PCA_FEATURES].values,
    }
    
    if available_vae:
        embeddings['vae'] = df[available_vae].values
        embeddings['combined'] = np.hstack([
            embeddings['core'], 
            embeddings['pca'], 
            embeddings['vae']
        ])
    else:
        embeddings['combined'] = np.hstack([
            embeddings['core'], 
            embeddings['pca']
        ])
    
    return embeddings

def analyze_coverage(embeddings, embedding_name, radius=0.3, n_samples=1000):
    """Analyze coverage and reachability for an embedding space"""
    logger.info(f"Analyzing coverage for {embedding_name} embedding...")
    
    # Standardize features
    scaler = StandardScaler()
    embeddings_scaled = scaler.fit_transform(embeddings)
    
    n_tracks = len(embeddings_scaled)
    
    # Fit nearest neighbors
    nn = NearestNeighbors(radius=radius, algorithm='auto')
    nn.fit(embeddings_scaled)
    
    # Sample random starting points
    sample_indices = np.random.choice(n_tracks, min(n_samples, n_tracks), replace=False)
    
    reached_tracks = set()
    density_counts = []
    
    for i, start_idx in enumerate(sample_indices):
        # Find neighbors within radius
        neighbors = nn.radius_neighbors([embeddings_scaled[start_idx]], return_distance=False)[0]
        
        # Track reachable tracks
        reached_tracks.update(neighbors)
        density_counts.append(len(neighbors))
        
        if (i + 1) % 100 == 0:
            logger.info(f"  Processed {i+1}/{len(sample_indices)} samples")
    
    # Calculate metrics
    coverage_pct = len(reached_tracks) / n_tracks * 100
    unreachable_count = n_tracks - len(reached_tracks)
    
    density_stats = {
        'mean': np.mean(density_counts),
        'median': np.median(density_counts),
        'std': np.std(density_counts),
        'min': np.min(density_counts),
        'max': np.max(density_counts),
        'p10': np.percentile(density_counts, 10),
        'p90': np.percentile(density_counts, 90)
    }
    
    # Distance meaningfulness (curse of dimensionality check)
    sample_points = embeddings_scaled[sample_indices[:100]]  # Small sample for speed
    distances = nn.kneighbors(sample_points, n_neighbors=min(100, n_tracks), return_distance=True)[0]
    
    # Calculate 10th to 100th neighbor distance ratio
    ratios = []
    for dist_row in distances:
        if len(dist_row) >= 100:
            ratio = dist_row[99] / (dist_row[9] + 1e-8)  # Avoid division by zero
            ratios.append(ratio)
    
    distance_ratio = np.mean(ratios) if ratios else 0
    distance_meaningful = distance_ratio > 1.5  # Threshold for meaningful distances
    
    # Isolation analysis
    isolated_threshold = 3  # Tracks with < 3 neighbors
    isolated_count = sum(1 for count in density_counts if count < isolated_threshold)
    isolated_pct = isolated_count / len(density_counts) * 100
    
    results = {
        'embedding_name': embedding_name,
        'n_tracks': n_tracks,
        'n_dimensions': embeddings.shape[1],
        'coverage_pct': coverage_pct,
        'unreachable_count': unreachable_count,
        'density_stats': density_stats,
        'isolated_count': isolated_count,
        'isolated_pct': isolated_pct,
        'distance_ratio': distance_ratio,
        'distance_meaningful': distance_meaningful,
        'radius': radius,
        'samples_tested': len(sample_indices)
    }
    
    logger.info(f"  ✅ {embedding_name}: {coverage_pct:.1f}% coverage, {isolated_pct:.1f}% isolated")
    
    return results

def compare_all_embeddings(embeddings_dict, radius=0.3, n_samples=1000):
    """Compare all embedding types"""
    logger.info("Comparing all embedding types...")
    
    results = {}
    
    # Test each embedding type
    for name, embeddings in embeddings_dict.items():
        if name == 'identifiers':
            continue
            
        results[name] = analyze_coverage(embeddings, name, radius, n_samples)
    
    return results

def generate_report(results, output_path='embedding_comparison_report.json'):
    """Generate comparison report"""
    logger.info("Generating comparison report...")
    
    # Create summary comparison
    summary = {}
    for name, result in results.items():
        summary[name] = {
            'dimensions': result['n_dimensions'],
            'coverage_pct': result['coverage_pct'],
            'isolated_pct': result['isolated_pct'],
            'mean_density': result['density_stats']['mean'],
            'distance_meaningful': result['distance_meaningful'],
            'distance_ratio': result['distance_ratio']
        }
    
    # Find best performing
    best_coverage = max(results.keys(), key=lambda k: results[k]['coverage_pct'])
    best_density = max(results.keys(), key=lambda k: results[k]['density_stats']['mean'])
    least_isolated = min(results.keys(), key=lambda k: results[k]['isolated_pct'])
    
    comparison = {
        'summary': summary,
        'winners': {
            'best_coverage': best_coverage,
            'best_density': best_density,
            'least_isolated': least_isolated
        },
        'detailed_results': results,
        'analysis_timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
    }
    
    # Save to file
    with open(output_path, 'w') as f:
        json.dump(comparison, f, indent=2, default=str)
    
    # Print summary
    print("\n" + "="*60)
    print("EMBEDDING COVERAGE COMPARISON RESULTS")
    print("="*60)
    
    print(f"\n📊 Coverage Comparison (radius={results[list(results.keys())[0]]['radius']}):")
    for name in ['core', 'pca', 'vae', 'combined']:
        if name in results:
            r = results[name]
            print(f"  {name:10s}: {r['coverage_pct']:6.1f}% coverage, "
                  f"{r['density_stats']['mean']:6.1f} avg neighbors, "
                  f"{r['isolated_pct']:5.1f}% isolated")
    
    print(f"\n🏆 Winners:")
    print(f"  Best Coverage:     {best_coverage} ({results[best_coverage]['coverage_pct']:.1f}%)")
    print(f"  Best Density:      {best_density} ({results[best_density]['density_stats']['mean']:.1f} neighbors)")
    print(f"  Least Isolated:    {least_isolated} ({results[least_isolated]['isolated_pct']:.1f}%)")
    
    print(f"\n📈 Distance Quality (higher ratio = more meaningful):")
    for name, result in results.items():
        meaningful = "✓" if result['distance_meaningful'] else "✗"
        print(f"  {name:10s}: {result['distance_ratio']:5.2f} {meaningful}")
    
    print(f"\n📄 Full report saved to: {output_path}")
    
    return comparison

def main():
    parser = argparse.ArgumentParser(description='Compare embedding coverage and quality')
    parser.add_argument('--database-type', choices=['postgres', 'sqlite'], default='postgres',
                       help='Database type')
    parser.add_argument('--db-path', help='SQLite database path (required for SQLite)')
    parser.add_argument('--radius', type=float, default=0.3, help='Search radius')
    parser.add_argument('--samples', type=int, default=1000, help='Number of random samples')
    parser.add_argument('--output', default='embedding_comparison_report.json',
                       help='Output report path')
    
    args = parser.parse_args()
    
    try:
        # 1. Load all embeddings
        embeddings_dict = load_all_embeddings(args.database_type, args.db_path)
        
        # 2. Compare embeddings
        results = compare_all_embeddings(embeddings_dict, args.radius, args.samples)
        
        # 3. Generate report
        comparison = generate_report(results, args.output)
        
        logger.info("🎉 Embedding comparison complete!")
        
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        raise

if __name__ == '__main__':
    main()