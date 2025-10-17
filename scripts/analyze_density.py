#!/usr/bin/env python3
"""
Analyze local density distribution across different embedding spaces.

This tool measures:
1. Local density: How many neighbors each track has within radius
2. Isolation: Tracks with very few neighbors (potential dead zones)
3. Distance meaningfulness: Curse of dimensionality assessment
4. Coverage comparison: How each embedding space distributes tracks

Usage:
    python scripts/analyze_density.py --radius 0.3 --sample-tracks 1000
"""

import argparse
import json
import logging
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy import stats

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DensityAnalyzer:
    def __init__(self, server_url='http://localhost:3001'):
        self.server_url = server_url
        self.session = requests.Session()
        self.embedding_types = ['core', 'pca', 'vae', 'auto']
        
    def initialize(self):
        """Check server connection and available embeddings"""
        logger.info("Initializing density analyzer...")
        
        try:
            response = self.session.get(f"{self.server_url}/api/dimensions/stats")
            response.raise_for_status()
            stats = response.json()
            
            # Check which embedding types have data
            available_embeddings = []
            if stats['complete_data_counts']['core'] > 0:
                available_embeddings.append('core')
            if stats['complete_data_counts']['pca'] > 0:
                available_embeddings.append('pca')
            if stats['complete_data_counts']['vae'] > 0:
                available_embeddings.append('vae')
            
            # Auto uses the best available (PCA > VAE > core)
            if 'pca' in available_embeddings:
                available_embeddings.append('auto')
            
            self.embedding_types = available_embeddings
            
            logger.info(f"Available embeddings: {', '.join(self.embedding_types)}")
            logger.info(f"Total tracks with complete data: {stats['complete_data_counts']['all_dimensions']}")
            
            return stats
            
        except requests.RequestException as e:
            logger.error(f"Failed to connect to server: {e}")
            raise
    
    def get_sample_tracks(self, sample_size=1000):
        """Get random sample of tracks for analysis"""
        logger.info(f"Getting random sample of {sample_size} tracks...")
        
        try:
            response = self.session.get(
                f"{self.server_url}/api/kd-tree/random-tracks",
                params={'count': sample_size}
            )
            response.raise_for_status()
            data = response.json()
            
            track_ids = [track['id'] for track in data['tracks']]
            logger.info(f"Loaded {len(track_ids)} track IDs")
            
            return track_ids
            
        except requests.RequestException as e:
            logger.error(f"Failed to get sample tracks: {e}")
            raise
    
    def analyze_density_for_embedding(self, track_ids, embedding_type, radius=0.3):
        """Analyze density distribution for a specific embedding type"""
        logger.info(f"Analyzing density for {embedding_type} embedding (radius={radius})...")
        
        density_counts = []
        distances_for_meaningfulness = []
        isolation_threshold = 3  # Tracks with < 3 neighbors are considered isolated
        
        for i, track_id in enumerate(track_ids):
            try:
                # Get neighbors for this track
                response = self.session.get(
                    f"{self.server_url}/api/kd-tree/neighbors/{track_id}",
                    params={
                        'radius': radius,
                        'limit': 200,  # Get more neighbors to assess distance distribution
                        'embedding': embedding_type,
                        'include_distances': 'true'
                    }
                )
                
                if response.status_code != 200:
                    logger.warning(f"Failed to get neighbors for track {track_id}")
                    continue
                
                neighbors_data = response.json()
                neighbor_count = neighbors_data.get('count', 0)
                neighbors = neighbors_data.get('neighbors', [])
                
                # Record density (neighbor count)
                density_counts.append(neighbor_count)
                
                # Collect distances for meaningfulness analysis
                if neighbors and len(neighbors) >= 20:  # Need enough neighbors for ratio calculation
                    distances = [n.get('distance', 0) for n in neighbors if 'distance' in n]
                    distances.sort()
                    
                    if len(distances) >= 20:
                        # Calculate 10th to 100th neighbor distance ratio
                        # (or use available range if fewer neighbors)
                        tenth_distance = distances[min(9, len(distances)-1)]  # 10th neighbor (0-indexed)
                        hundredth_distance = distances[min(99, len(distances)-1)]  # 100th neighbor
                        
                        if tenth_distance > 0:
                            ratio = hundredth_distance / tenth_distance
                            distances_for_meaningfulness.append(ratio)
                
                if (i + 1) % 100 == 0:
                    logger.info(f"  Processed {i+1}/{len(track_ids)} tracks")
                    
            except Exception as e:
                logger.warning(f"Error processing track {track_id}: {e}")
                continue
        
        # Calculate statistics
        if not density_counts:
            logger.warning(f"No density data collected for {embedding_type}")
            return None
        
        density_stats = {
            'mean': np.mean(density_counts),
            'median': np.median(density_counts),
            'std': np.std(density_counts),
            'min': np.min(density_counts),
            'max': np.max(density_counts),
            'percentiles': {
                '10': np.percentile(density_counts, 10),
                '25': np.percentile(density_counts, 25),
                '50': np.percentile(density_counts, 50),
                '75': np.percentile(density_counts, 75),
                '90': np.percentile(density_counts, 90)
            }
        }
        
        # Isolation analysis
        isolated_count = sum(1 for count in density_counts if count < isolation_threshold)
        isolated_fraction = isolated_count / len(density_counts)
        
        # Distance meaningfulness
        distance_meaningfulness = {
            'avg_ratio': np.mean(distances_for_meaningfulness) if distances_for_meaningfulness else 0,
            'samples': len(distances_for_meaningfulness),
            'interpretation': 'unknown'
        }
        
        if distance_meaningfulness['avg_ratio'] > 0:
            if distance_meaningfulness['avg_ratio'] > 3.0:
                distance_meaningfulness['interpretation'] = 'distances_meaningful'
            elif distance_meaningfulness['avg_ratio'] > 1.5:
                distance_meaningfulness['interpretation'] = 'moderate_structure'
            else:
                distance_meaningfulness['interpretation'] = 'curse_of_dimensionality'
        
        result = {
            'embedding_type': embedding_type,
            'radius': radius,
            'sample_size': len(density_counts),
            'density_stats': density_stats,
            'isolation': {
                'threshold': isolation_threshold,
                'isolated_count': isolated_count,
                'isolated_fraction': isolated_fraction
            },
            'distance_meaningfulness': distance_meaningfulness
        }
        
        logger.info(f"  ✅ {embedding_type}: Mean density {density_stats['mean']:.1f}, "
                   f"isolated {isolated_fraction:.1%}, "
                   f"distance ratio {distance_meaningfulness['avg_ratio']:.2f}")
        
        return result
    
    def compare_embeddings(self, track_ids, radius=0.3):
        """Compare density across all available embedding types"""
        logger.info(f"Comparing density across {len(self.embedding_types)} embedding types...")
        
        results = {}
        
        for embedding_type in self.embedding_types:
            result = self.analyze_density_for_embedding(track_ids, embedding_type, radius)
            if result:
                results[embedding_type] = result
        
        return results
    
    def generate_density_report(self, results, output_path):
        """Generate comprehensive density analysis report"""
        logger.info("Generating density analysis report...")
        
        # Create comparison summary
        comparison = {}
        for embedding_type, result in results.items():
            comparison[embedding_type] = {
                'mean_density': result['density_stats']['mean'],
                'median_density': result['density_stats']['median'],
                'isolated_fraction': result['isolation']['isolated_fraction'],
                'distance_ratio': result['distance_meaningfulness']['avg_ratio'],
                'distance_quality': result['distance_meaningfulness']['interpretation']
            }
        
        # Find winners
        if comparison:
            best_density = max(comparison.keys(), key=lambda k: comparison[k]['mean_density'])
            least_isolated = min(comparison.keys(), key=lambda k: comparison[k]['isolated_fraction'])
            best_distance_ratio = max(comparison.keys(), key=lambda k: comparison[k]['distance_ratio'])
        else:
            best_density = least_isolated = best_distance_ratio = None
        
        # Create full report
        report = {
            'analysis_params': {
                'radius': results[list(results.keys())[0]]['radius'] if results else 0.3,
                'sample_size': results[list(results.keys())[0]]['sample_size'] if results else 0,
                'embedding_types_analyzed': list(results.keys()),
                'analysis_timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
            },
            'comparison_summary': comparison,
            'winners': {
                'best_density': best_density,
                'least_isolated': least_isolated,
                'best_distance_ratio': best_distance_ratio
            },
            'detailed_results': results
        }
        
        # Save report
        with open(output_path, 'w') as f:
            json.dump(report, f, indent=2, default=str)
        
        # Print summary
        print("\n" + "="*80)
        print("DENSITY ANALYSIS RESULTS")
        print("="*80)
        
        if results:
            print(f"\n📊 Analysis Summary:")
            print(f"  Sample size: {report['analysis_params']['sample_size']:,} tracks")
            print(f"  Search radius: {report['analysis_params']['radius']}")
            print(f"  Embeddings tested: {', '.join(results.keys())}")
            
            print(f"\n📈 Density Comparison:")
            for embedding_type in ['core', 'pca', 'vae', 'auto']:
                if embedding_type in comparison:
                    c = comparison[embedding_type]
                    quality_icon = {
                        'distances_meaningful': '✅',
                        'moderate_structure': '⚠️',
                        'curse_of_dimensionality': '❌',
                        'unknown': '❓'
                    }.get(c['distance_quality'], '❓')
                    
                    print(f"  {embedding_type:4s}: {c['mean_density']:6.1f} avg neighbors, "
                          f"{c['isolated_fraction']:5.1%} isolated, "
                          f"ratio {c['distance_ratio']:4.2f} {quality_icon}")
            
            print(f"\n🏆 Winners:")
            if best_density:
                print(f"  Best Density:     {best_density} ({comparison[best_density]['mean_density']:.1f} avg neighbors)")
            if least_isolated:
                print(f"  Least Isolated:   {least_isolated} ({comparison[least_isolated]['isolated_fraction']:.1%} isolated)")
            if best_distance_ratio:
                print(f"  Best Distances:   {best_distance_ratio} (ratio {comparison[best_distance_ratio]['distance_ratio']:.2f})")
            
            print(f"\n🎯 Recommendations:")
            
            # Determine best overall embedding
            scores = {}
            for emb_type, data in comparison.items():
                score = (
                    data['mean_density'] / 100 +  # Normalize density
                    (1 - data['isolated_fraction']) +  # Lower isolation is better
                    min(data['distance_ratio'] / 3, 1)  # Distance ratio, capped at 3
                )
                scores[emb_type] = score
            
            if scores:
                best_overall = max(scores.keys(), key=lambda k: scores[k])
                print(f"  Best Overall: {best_overall} (composite score: {scores[best_overall]:.2f})")
                
                if 'vae' in scores and 'pca' in scores:
                    vae_improvement = ((scores['vae'] - scores['pca']) / scores['pca']) * 100
                    if vae_improvement > 10:
                        print(f"  🎉 VAE shows {vae_improvement:.1f}% improvement over PCA!")
                    elif vae_improvement > 0:
                        print(f"  📈 VAE shows modest {vae_improvement:.1f}% improvement over PCA")
                    else:
                        print(f"  📉 PCA outperforms VAE by {-vae_improvement:.1f}%")
        
        print(f"\n💾 Full report saved to: {output_path}")
        
        return report

def main():
    parser = argparse.ArgumentParser(description='Analyze density distribution across embedding spaces')
    parser.add_argument('--radius', type=float, default=0.3, help='Search radius')
    parser.add_argument('--sample-tracks', type=int, default=1000, help='Number of tracks to sample')
    parser.add_argument('--server-url', default='http://localhost:3001', help='Server URL')
    parser.add_argument('--output', default='density_analysis_report.json', help='Output path')
    
    args = parser.parse_args()
    
    try:
        # Initialize analyzer
        analyzer = DensityAnalyzer(args.server_url)
        analyzer.initialize()
        
        # Get sample tracks
        track_ids = analyzer.get_sample_tracks(args.sample_tracks)
        
        # Run density analysis
        results = analyzer.compare_embeddings(track_ids, args.radius)
        
        # Generate report
        report = analyzer.generate_density_report(results, args.output)
        
        logger.info("🎉 Density analysis complete!")
        
    except Exception as e:
        logger.error(f"❌ Analysis failed: {e}")
        raise

if __name__ == '__main__':
    main()