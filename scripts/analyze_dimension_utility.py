#!/usr/bin/env python3
"""
Analyze dimension utility across all 36 available dimensions.

This is the primary analysis tool that identifies:
- Workhorses: Dimensions useful everywhere (high utility across all neighborhoods)
- Specialists: Dimensions useful in specific contexts (high utility in some neighborhoods)
- Redundant: Dimensions rarely useful (low utility everywhere)

The goal is to understand which of the 36 dimensions (18 core + 10 PCA + 8 VAE)
should be prioritized for adaptive dimension selection.

Usage:
    python scripts/analyze_dimension_utility.py --sample-tracks 1000 --radius 0.3
"""

import argparse
import json
import logging
import time
from collections import defaultdict

import numpy as np
import pandas as pd
import requests
from sklearn.metrics import silhouette_score

try:
    import warnings
    from urllib3.exceptions import NotOpenSSLWarning
    warnings.filterwarnings("ignore", category=NotOpenSSLWarning)
except Exception:
    # Silently continue if urllib3 or the warning class is unavailable
    pass

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DimensionUtilityAnalyzer:
    def __init__(self, server_url='http://localhost:3001', embedding='vae', resolution='magnifying_glass', discriminator='primary_d', radius=None):
        self.server_url = server_url
        self.session = requests.Session()
        self.all_dimensions = []
        self.dimension_names = {}
        self.tracks_data = None
        self.track_cache = {}
        self.neighborhoods_processed = 0
        self.embedding_mode = embedding
        self.resolution = resolution
        self.discriminator = discriminator
        self.radius = radius
        
    def initialize(self):
        """Initialize by fetching dimension information from server"""
        logger.info("Fetching dimension information from server...")
        
        try:
            response = self.session.get(f"{self.server_url}/api/dimensions/stats")
            response.raise_for_status()
            stats = response.json()
            
            self.dimension_names = stats['dimension_names']
            self.all_dimensions = (
                stats['dimension_names']['core'] + 
                stats['dimension_names']['pca'] + 
                stats['dimension_names']['vae']
            )
            
            logger.info(f"Found {len(self.all_dimensions)} total dimensions:")
            logger.info(f"  Core: {len(stats['dimension_names']['core'])}")
            logger.info(f"  PCA: {len(stats['dimension_names']['pca'])}")
            logger.info(f"  VAE: {len(stats['dimension_names']['vae'])}")
            logger.info(f"Complete data available for {stats['complete_data_counts']['all_dimensions']} tracks")
            
            return stats
            
        except requests.RequestException as e:
            logger.error(f"Failed to connect to server: {e}")
            logger.info("Make sure the tsnotfyi server is running on port 3001")
            raise

    def _flatten_track_dimensions(self, track_payload):
        flattened = {'identifier': track_payload['track_id']}

        for space in ('core', 'pca', 'vae'):
            dims = track_payload['dimensions'].get(space, {})
            if dims:
                flattened.update(dims)

        return flattened

    def _is_complete_track(self, flattened):
        for dim in self.all_dimensions:
            if dim not in flattened or pd.isna(flattened[dim]):
                return False
        return True

    def ensure_track_cached(self, track_id):
        if track_id in self.track_cache:
            return True

        try:
            response = self.session.get(
                f"{self.server_url}/api/dimensions/track/{track_id}",
                timeout=10
            )
            response.raise_for_status()
            track_payload = response.json()
            flattened = self._flatten_track_dimensions(track_payload)

            if not self._is_complete_track(flattened):
                logger.debug(f"Skipping track {track_id} due to incomplete dimension data")
                return False

            self.track_cache[track_id] = flattened

            if self.tracks_data is not None:
                new_row = pd.DataFrame([flattened])
                self.tracks_data = pd.concat([self.tracks_data, new_row], ignore_index=True)
                self.tracks_data = self.tracks_data.drop_duplicates(subset='identifier', keep='last')

            return True

        except requests.RequestException as e:
            logger.warning(f"Failed to fetch dimension data for track {track_id}: {e}")
            return False
    
    def load_sample_tracks(self, sample_size=1000):
        """Load a random sample of tracks for analysis"""
        logger.info(f"Loading random sample of {sample_size} tracks...")
        
        try:
            response = self.session.get(
                f"{self.server_url}/api/kd-tree/random-tracks",
                params={'count': sample_size}
            )
            response.raise_for_status()
            data = response.json()
            
            track_ids = [track['id'] for track in data['tracks']]
            logger.info(f"Loaded {len(track_ids)} track IDs")
            
            # Now fetch detailed dimension data for each track
            logger.info("Fetching dimension data for sample tracks...")
            tracks_data = []
            
            for i, track_id in enumerate(track_ids):
                if self.ensure_track_cached(track_id):
                    tracks_data.append(self.track_cache[track_id])

                if (i + 1) % 100 == 0:
                    logger.info(f"  Processed {i+1}/{len(track_ids)} tracks")
            
            # Convert to DataFrame
            self.tracks_data = pd.DataFrame(tracks_data)

            # Remove tracks with missing data in any dimension
            if not self.tracks_data.empty:
                before_count = len(self.tracks_data)
                self.tracks_data = self.tracks_data.dropna(subset=self.all_dimensions)
                after_count = len(self.tracks_data)

                if before_count != after_count:
                    logger.warning(f"Removed {before_count - after_count} tracks with missing dimension data")

                # Keep cache aligned with filtered dataset
                valid_ids = set(self.tracks_data['identifier'])
                self.track_cache = {tid: self.track_cache[tid] for tid in valid_ids}

            logger.info(f"Final dataset: {len(self.tracks_data)} tracks with complete {len(self.all_dimensions)}D data")
            return self.tracks_data
            
        except Exception as e:
            logger.error(f"Error loading track data: {e}")
            raise
    
    def analyze_dimension_utility_in_neighborhood(self, center_idx, neighbors_data, dimension_name):
        """Analyze utility of a specific dimension in a neighborhood"""
        if len(neighbors_data) < 3:
            return {
                'variance': 0.0,
                'coverage': 0.0,
                'clustering': 0.0,
                'spread': 0.0,
                'utility_score': 0.0
            }
        
        dim_values = neighbors_data[dimension_name].values
        
        # 1. Variance: How much does this dimension vary in the neighborhood?
        variance = np.var(dim_values)
        normalized_variance = min(variance / (np.var(self.tracks_data[dimension_name].values) + 1e-8), 1.0)
        
        # 2. Coverage: What fraction of the global range is covered?
        global_min = self.tracks_data[dimension_name].min()
        global_max = self.tracks_data[dimension_name].max()
        local_min = dim_values.min()
        local_max = dim_values.max()
        
        global_range = global_max - global_min
        local_range = local_max - local_min
        coverage = local_range / (global_range + 1e-8) if global_range > 0 else 0.0
        
        # 3. Clustering quality: Does this dimension create meaningful clusters?
        try:
            if len(np.unique(dim_values)) > 1:
                # Create simple binary clusters based on median split
                median_val = np.median(dim_values)
                labels = (dim_values > median_val).astype(int)
                
                if len(np.unique(labels)) > 1:
                    # Calculate silhouette score using this dimension only
                    dim_features = dim_values.reshape(-1, 1)
                    clustering_score = silhouette_score(dim_features, labels)
                    clustering = max(clustering_score, 0.0)  # Clamp to positive
                else:
                    clustering = 0.0
            else:
                clustering = 0.0
        except:
            clustering = 0.0
        
        # 4. Spread: How well distributed are the values?
        try:
            # Calculate coefficient of variation
            std_dev = np.std(dim_values)
            mean_val = np.mean(dim_values)
            spread = std_dev / (abs(mean_val) + 1e-8) if mean_val != 0 else 0.0
            spread = min(spread, 1.0)  # Normalize
        except:
            spread = 0.0
        
        # Composite utility score (weighted average)
        utility_score = (
            0.3 * normalized_variance +
            0.3 * coverage +
            0.2 * clustering +
            0.2 * spread
        )
        
        return {
            'variance': normalized_variance,
            'coverage': coverage,
            'clustering': clustering,
            'spread': spread,
            'utility_score': utility_score
        }
    
    def analyze_all_dimensions(self, sample_tracks=1000, radius=None):
        """Analyze utility of all dimensions across random neighborhoods"""
        logger.info(f"Analyzing dimension utility across {sample_tracks} random neighborhoods...")
        self.neighborhoods_processed = 0

        if radius is None:
            radius = self.radius

        if self.tracks_data is None or self.tracks_data.empty:
            self.load_sample_tracks(sample_tracks)

        if self.tracks_data is None or self.tracks_data.empty:
            logger.warning("No tracks available with complete dimension data; aborting analysis")
            return {}, 0

        # Sample random center tracks
        total_tracks = len(self.tracks_data)
        sample_size = min(sample_tracks, total_tracks)
        center_indices = np.random.choice(
            total_tracks,
            sample_size,
            replace=False
        )
        
        # Store results for each dimension across all neighborhoods
        dimension_results = defaultdict(list)
        
        for i, center_idx in enumerate(center_indices):
            center_track = self.tracks_data.iloc[center_idx]
            center_id = center_track['identifier']

            # Get neighbors for this track from server
            try:
                params = {
                    'limit': 100,
                    'embedding': self.embedding_mode,
                    'include_distances': 'true',
                    'resolution': self.resolution,
                    'discriminator': self.discriminator
                }
                if radius is not None:
                    params['radius'] = radius

                response = self.session.get(
                    f"{self.server_url}/api/kd-tree/neighbors/{center_id}",
                    params=params,
                    timeout=max(5, 2 * len(params))
                )
                
                if response.status_code != 200:
                    logger.warning(f"Failed to get neighbors for track {center_id}: status {response.status_code}")
                    continue
                
                neighbors_response = response.json()
                neighbor_ids = [n['id'] for n in neighbors_response['neighbors']]

                if len(neighbor_ids) < 3:
                    continue  # Skip neighborhoods that are too small

                neighbor_rows = []
                for neighbor_id in neighbor_ids:
                    if self.ensure_track_cached(neighbor_id):
                        neighbor_rows.append(self.track_cache[neighbor_id])

                if len(neighbor_rows) < 3:
                    continue

                neighbors_data = pd.DataFrame(neighbor_rows)
                
                # Analyze each dimension in this neighborhood
                for dim_name in self.all_dimensions:
                    if dim_name in neighbors_data.columns:
                        utility_metrics = self.analyze_dimension_utility_in_neighborhood(
                            center_idx, neighbors_data, dim_name
                        )
                        
                        # Store results
                        result = {
                            'center_track': center_id,
                            'neighborhood_size': len(neighbors_data),
                            **utility_metrics
                        }
                        dimension_results[dim_name].append(result)

                self.neighborhoods_processed += 1
                
                if (i + 1) % 50 == 0:
                    logger.info(f"  Processed {i+1}/{len(center_indices)} neighborhoods")
                    
            except Exception as e:
                logger.warning(f"Error processing neighborhood for track {center_id}: {e}")
                continue
        
        logger.info(f"Completed analysis across {len(center_indices)} neighborhoods")
        return dict(dimension_results), self.neighborhoods_processed
    
    def generate_utility_report(self, dimension_results, output_path, neighborhoods_processed, radius):
        """Generate comprehensive utility analysis report"""
        logger.info("Generating dimension utility report...")

        # Calculate aggregate statistics for each dimension
        aggregated_results = []
        
        for dim_name in self.all_dimensions:
            if dim_name not in dimension_results or len(dimension_results[dim_name]) == 0:
                continue
            
            results = dimension_results[dim_name]
            
            # Calculate aggregated metrics
            avg_utility = np.mean([r['utility_score'] for r in results])
            avg_variance = np.mean([r['variance'] for r in results])
            avg_coverage = np.mean([r['coverage'] for r in results])
            avg_clustering = np.mean([r['clustering'] for r in results])
            avg_spread = np.mean([r['spread'] for r in results])
            
            # Calculate how often this dimension appears in top 5 for each neighborhood
            utility_scores = [r['utility_score'] for r in results]
            top_5_threshold = np.percentile(utility_scores, 80) if len(utility_scores) > 0 else 0
            appears_in_top5 = np.mean([1 if r['utility_score'] >= top_5_threshold else 0 for r in results])
            
            # Determine space (core, pca, vae)
            if dim_name in self.dimension_names['core']:
                space = 'core'
            elif dim_name in self.dimension_names['pca']:
                space = 'pca'
            elif dim_name in self.dimension_names['vae']:
                space = 'vae'
            else:
                space = 'unknown'
            
            # Categorize dimension
            if avg_utility >= 0.6 and appears_in_top5 >= 0.5:
                category = 'workhorse'
            elif avg_utility >= 0.4 and appears_in_top5 >= 0.2:
                category = 'specialist'
            else:
                category = 'redundant'
            
            aggregated_results.append({
                'name': dim_name,
                'space': space,
                'avg_utility': avg_utility,
                'avg_variance': avg_variance,
                'avg_coverage': avg_coverage,
                'avg_clustering': avg_clustering,
                'avg_spread': avg_spread,
                'appears_in_top5': appears_in_top5,
                'category': category,
                'sample_count': len(results)
            })
        
        # Sort by average utility
        aggregated_results.sort(key=lambda x: x['avg_utility'], reverse=True)
        
        # Group by space
        by_space = {'core': [], 'pca': [], 'vae': []}
        for result in aggregated_results:
            if result['space'] in by_space:
                by_space[result['space']].append(result)
        
        # Create final report
        radius_descriptor = radius if radius is not None else 'calibrated'
        report = {
            'analysis_params': {
                'sample_tracks': neighborhoods_processed,
                'radius': radius_descriptor,
                'embedding': self.embedding_mode,
                'resolution': self.resolution,
                'discriminator': self.discriminator,
                'total_dimensions': len(self.all_dimensions),
                'analysis_timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
            },
            'global_rankings': aggregated_results,
            'by_space': by_space,
            'summary': {
                'workhorses': [r['name'] for r in aggregated_results if r['category'] == 'workhorse'],
                'specialists': [r['name'] for r in aggregated_results if r['category'] == 'specialist'],
                'redundant': [r['name'] for r in aggregated_results if r['category'] == 'redundant']
            }
        }
        
        # Save report
        with open(output_path, 'w') as f:
            json.dump(report, f, indent=2, default=str)
        
        # Print summary
        print("\n" + "="*80)
        print("DIMENSION UTILITY ANALYSIS RESULTS")
        print("="*80)
        
        print(f"\n📊 Analysis Summary:")
        print(f"  Total dimensions analyzed: {len(aggregated_results)}")
        print(f"  Neighborhoods sampled: {report['analysis_params']['sample_tracks']}")
        print(f"  Search radius: {report['analysis_params']['radius']}")
        print(f"  Embedding mode: {report['analysis_params']['embedding']} @ {report['analysis_params']['resolution']} ({report['analysis_params']['discriminator']})")
        
        print(f"\n🏆 Top 10 Most Useful Dimensions:")
        for i, result in enumerate(aggregated_results[:10]):
            print(f"  {i+1:2d}. {result['name']:20s} ({result['space']:4s}) - "
                  f"Utility: {result['avg_utility']:.3f}, "
                  f"Top5%: {result['appears_in_top5']:.1%}, "
                  f"Category: {result['category']}")
        
        print(f"\n📈 Category Breakdown:")
        workhorses = [r for r in aggregated_results if r['category'] == 'workhorse']
        specialists = [r for r in aggregated_results if r['category'] == 'specialist']
        redundant = [r for r in aggregated_results if r['category'] == 'redundant']
        
        print(f"  Workhorses ({len(workhorses)}): {', '.join([r['name'] for r in workhorses])}")
        print(f"  Specialists ({len(specialists)}): {', '.join([r['name'] for r in specialists])}")
        print(f"  Redundant ({len(redundant)}): {', '.join([r['name'] for r in redundant])}")
        
        print(f"\n🎯 Space Analysis:")
        for space, results in by_space.items():
            if results:
                avg_utility = np.mean([r['avg_utility'] for r in results])
                print(f"  {space.upper():4s}: {len(results):2d} dims, avg utility: {avg_utility:.3f}")
        
        print(f"\n💾 Full report saved to: {output_path}")
        
        return report

def main():
    parser = argparse.ArgumentParser(description='Analyze dimension utility across embedding spaces')
    parser.add_argument('--sample-tracks', type=int, default=1000, 
                       help='Number of random neighborhoods to analyze')
    parser.add_argument('--radius', type=float, default=None, 
                       help='Search radius for neighborhood discovery (omit to use calibrated defaults)')
    parser.add_argument('--server-url', default='http://localhost:3001',
                       help='URL of tsnotfyi server')
    parser.add_argument('--output', default='dimension_utility_report.json',
                       help='Output report path')
    parser.add_argument('--embedding', default='vae', choices=['auto', 'pca', 'vae', 'core'],
                       help='Embedding mode for neighborhood discovery (default: vae)')
    parser.add_argument('--resolution', default='magnifying_glass',
                       help='Resolution bucket for calibrated searches (default: magnifying_glass)')
    parser.add_argument('--discriminator', default='primary_d',
                       help='Discriminator used for calibrated searches (default: primary_d)')
    
    args = parser.parse_args()
    
    try:
        # Initialize analyzer
        analyzer = DimensionUtilityAnalyzer(
            server_url=args.server_url,
            embedding=args.embedding,
            resolution=args.resolution,
            discriminator=args.discriminator,
            radius=args.radius
        )
        analyzer.initialize()

        # Run analysis
        dimension_results, neighborhoods_processed = analyzer.analyze_all_dimensions(
            sample_tracks=args.sample_tracks,
            radius=args.radius
        )
        
        if neighborhoods_processed == 0:
            logger.warning("No neighborhoods processed; report may be empty")

        # Generate report
        report = analyzer.generate_utility_report(
            dimension_results,
            args.output,
            neighborhoods_processed,
            args.radius
        )
        
        logger.info("🎉 Dimension utility analysis complete!")
        
    except Exception as e:
        logger.error(f"❌ Analysis failed: {e}")
        raise

if __name__ == '__main__':
    main()
