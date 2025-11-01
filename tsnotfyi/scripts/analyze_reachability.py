#!/usr/bin/env python3
"""
Analyze reachability and connectivity across embedding spaces.

This tool measures:
1. Coverage: What percentage of the library is reachable from random starting points
2. Multi-hop paths: How many steps needed to reach distant tracks  
3. Dead zones: Tracks that are rarely/never reached
4. Connectivity comparison: How different embeddings affect graph structure

Usage:
    python scripts/analyze_reachability.py --samples 500 --max-hops 5 --radius 0.3
"""

import argparse
import json
import logging
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ReachabilityAnalyzer:
    def __init__(self, server_url='http://localhost:3001'):
        self.server_url = server_url
        self.session = requests.Session()
        self.embedding_types = ['core', 'pca', 'vae', 'auto']
        
    def initialize(self):
        """Check server connection and available embeddings"""
        logger.info("Initializing reachability analyzer...")
        
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
            
            # Auto uses the best available
            if 'pca' in available_embeddings:
                available_embeddings.append('auto')
            
            self.embedding_types = available_embeddings
            
            logger.info(f"Available embeddings: {', '.join(self.embedding_types)}")
            logger.info(f"Total tracks: {stats['total_tracks']:,}")
            
            return stats
            
        except requests.RequestException as e:
            logger.error(f"Failed to connect to server: {e}")
            raise
    
    def get_neighbors(self, track_id, embedding_type, radius=0.3, limit=100):
        """Get neighbors for a track using specified embedding"""
        try:
            response = self.session.get(
                f"{self.server_url}/api/kd-tree/neighbors/{track_id}",
                params={
                    'radius': radius,
                    'limit': limit,
                    'embedding': embedding_type,
                    'include_distances': 'false'  # Don't need distances for reachability
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                return [neighbor['id'] for neighbor in data.get('neighbors', [])]
            else:
                return []
                
        except Exception as e:
            logger.warning(f"Error getting neighbors for {track_id}: {e}")
            return []
    
    def breadth_first_reachability(self, start_track_id, embedding_type, max_hops=5, radius=0.3):
        """Perform BFS to find all reachable tracks within max_hops"""
        visited = set()
        reachable = {start_track_id: 0}  # track_id -> hop_count
        queue = deque([(start_track_id, 0)])  # (track_id, current_hop)
        
        while queue:
            current_track, current_hop = queue.popleft()
            
            if current_hop >= max_hops:
                continue
            
            if current_track in visited:
                continue
                
            visited.add(current_track)
            
            # Get neighbors for current track
            neighbors = self.get_neighbors(current_track, embedding_type, radius)
            
            for neighbor_id in neighbors:
                if neighbor_id not in reachable:
                    reachable[neighbor_id] = current_hop + 1
                    queue.append((neighbor_id, current_hop + 1))
        
        return reachable
    
    def analyze_reachability_for_embedding(self, starting_tracks, embedding_type, max_hops=5, radius=0.3):
        """Analyze reachability for a specific embedding type"""
        logger.info(f"Analyzing reachability for {embedding_type} embedding...")
        logger.info(f"  Parameters: max_hops={max_hops}, radius={radius}")
        
        all_reachable = set()
        hop_counts = defaultdict(int)  # hop_count -> number_of_tracks_reached_at_this_hop
        track_reach_counts = defaultdict(int)  # track_id -> number_of_starting_points_that_can_reach_it
        path_lengths = []  # All recorded path lengths
        
        for i, start_track in enumerate(starting_tracks):
            try:
                reachable = self.breadth_first_reachability(
                    start_track, embedding_type, max_hops, radius
                )
                
                # Update global statistics
                all_reachable.update(reachable.keys())
                
                # Count tracks reached at each hop distance
                for track_id, hop_count in reachable.items():
                    hop_counts[hop_count] += 1
                    track_reach_counts[track_id] += 1
                    if hop_count > 0:  # Don't count the starting track itself
                        path_lengths.append(hop_count)
                
                if (i + 1) % 25 == 0:
                    logger.info(f"    Processed {i+1}/{len(starting_tracks)} starting points")
                    
            except Exception as e:
                logger.warning(f"Error analyzing reachability from {start_track}: {e}")
                continue
        
        # Calculate statistics
        total_unique_reached = len(all_reachable)
        avg_path_length = np.mean(path_lengths) if path_lengths else 0
        max_path_length = max(path_lengths) if path_lengths else 0
        
        # Analyze track accessibility
        reach_count_values = list(track_reach_counts.values())
        accessibility_stats = {
            'mean_reach_count': np.mean(reach_count_values) if reach_count_values else 0,
            'median_reach_count': np.median(reach_count_values) if reach_count_values else 0,
            'max_reach_count': max(reach_count_values) if reach_count_values else 0,
            'min_reach_count': min(reach_count_values) if reach_count_values else 0
        }
        
        # Find dead zones (tracks never reached)
        never_reached = []
        rarely_reached = []  # Reached from <10% of starting points
        threshold = len(starting_tracks) * 0.1
        
        for track_id, count in track_reach_counts.items():
            if count == 0:
                never_reached.append(track_id)
            elif count < threshold:
                rarely_reached.append(track_id)
        
        # Calculate hop distribution
        hop_distribution = {}
        total_connections = sum(hop_counts.values())
        for hop, count in hop_counts.items():
            hop_distribution[hop] = count / total_connections if total_connections > 0 else 0
        
        result = {
            'embedding_type': embedding_type,
            'parameters': {
                'starting_tracks': len(starting_tracks),
                'max_hops': max_hops,
                'radius': radius
            },
            'coverage': {
                'total_reached': total_unique_reached,
                'coverage_from_sample': total_unique_reached / len(starting_tracks) if starting_tracks else 0
            },
            'path_statistics': {
                'avg_path_length': avg_path_length,
                'max_path_length': max_path_length,
                'total_paths': len(path_lengths)
            },
            'accessibility': accessibility_stats,
            'dead_zones': {
                'never_reached_count': len(never_reached),
                'rarely_reached_count': len(rarely_reached),
                'never_reached_sample': never_reached[:10],  # Sample for debugging
                'rarely_reached_sample': rarely_reached[:10]
            },
            'hop_distribution': hop_distribution
        }
        
        logger.info(f"  ✅ {embedding_type}: Reached {total_unique_reached:,} tracks, "
                   f"avg path {avg_path_length:.1f} hops, "
                   f"{len(never_reached)} dead zones")
        
        return result
    
    def compare_reachability(self, sample_size=500, max_hops=5, radius=0.3):
        """Compare reachability across all available embedding types"""
        logger.info(f"Comparing reachability across {len(self.embedding_types)} embedding types...")
        
        # Get random starting tracks
        try:
            response = self.session.get(
                f"{self.server_url}/api/kd-tree/random-tracks",
                params={'count': sample_size}
            )
            response.raise_for_status()
            data = response.json()
            starting_tracks = [track['id'] for track in data['tracks']]
            
            logger.info(f"Using {len(starting_tracks)} random starting tracks")
            
        except Exception as e:
            logger.error(f"Failed to get starting tracks: {e}")
            raise
        
        # Analyze each embedding type
        results = {}
        
        for embedding_type in self.embedding_types:
            result = self.analyze_reachability_for_embedding(
                starting_tracks, embedding_type, max_hops, radius
            )
            if result:
                results[embedding_type] = result
        
        return results
    
    def generate_reachability_report(self, results, output_path):
        """Generate comprehensive reachability analysis report"""
        logger.info("Generating reachability analysis report...")
        
        # Create comparison summary
        comparison = {}
        for embedding_type, result in results.items():
            comparison[embedding_type] = {
                'total_reached': result['coverage']['total_reached'],
                'coverage_ratio': result['coverage']['coverage_from_sample'],
                'avg_path_length': result['path_statistics']['avg_path_length'],
                'max_path_length': result['path_statistics']['max_path_length'],
                'dead_zones': result['dead_zones']['never_reached_count'],
                'rarely_reached': result['dead_zones']['rarely_reached_count']
            }
        
        # Find winners
        if comparison:
            best_coverage = max(comparison.keys(), key=lambda k: comparison[k]['total_reached'])
            shortest_paths = min(comparison.keys(), key=lambda k: comparison[k]['avg_path_length'])
            fewest_dead_zones = min(comparison.keys(), key=lambda k: comparison[k]['dead_zones'])
        else:
            best_coverage = shortest_paths = fewest_dead_zones = None
        
        # Create full report
        report = {
            'analysis_params': {
                'sample_size': results[list(results.keys())[0]]['parameters']['starting_tracks'] if results else 0,
                'max_hops': results[list(results.keys())[0]]['parameters']['max_hops'] if results else 0,
                'radius': results[list(results.keys())[0]]['parameters']['radius'] if results else 0,
                'embedding_types_analyzed': list(results.keys()),
                'analysis_timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
            },
            'comparison_summary': comparison,
            'winners': {
                'best_coverage': best_coverage,
                'shortest_paths': shortest_paths,
                'fewest_dead_zones': fewest_dead_zones
            },
            'detailed_results': results
        }
        
        # Save report
        with open(output_path, 'w') as f:
            json.dump(report, f, indent=2, default=str)
        
        # Print summary
        print("\n" + "="*80)
        print("REACHABILITY ANALYSIS RESULTS")
        print("="*80)
        
        if results:
            params = report['analysis_params']
            print(f"\n📊 Analysis Summary:")
            print(f"  Starting tracks: {params['sample_size']:,}")
            print(f"  Max hops: {params['max_hops']}")
            print(f"  Search radius: {params['radius']}")
            print(f"  Embeddings tested: {', '.join(results.keys())}")
            
            print(f"\n🌐 Reachability Comparison:")
            for embedding_type in ['core', 'pca', 'vae', 'auto']:
                if embedding_type in comparison:
                    c = comparison[embedding_type]
                    coverage_pct = (c['total_reached'] / params['sample_size']) * 100 if params['sample_size'] > 0 else 0
                    print(f"  {embedding_type:4s}: {c['total_reached']:5,} tracks ({coverage_pct:5.1f}%), "
                          f"avg {c['avg_path_length']:.1f} hops, "
                          f"{c['dead_zones']:3d} dead zones")
            
            print(f"\n🏆 Winners:")
            if best_coverage:
                best_count = comparison[best_coverage]['total_reached']
                print(f"  Best Coverage:    {best_coverage} ({best_count:,} tracks reachable)")
            if shortest_paths:
                shortest_avg = comparison[shortest_paths]['avg_path_length']
                print(f"  Shortest Paths:   {shortest_paths} ({shortest_avg:.1f} avg hops)")
            if fewest_dead_zones:
                fewest_count = comparison[fewest_dead_zones]['dead_zones']
                print(f"  Fewest Dead Zones: {fewest_dead_zones} ({fewest_count} unreachable)")
            
            print(f"\n🎯 Key Insights:")
            
            # Compare VAE vs PCA if both available
            if 'vae' in comparison and 'pca' in comparison:
                vae_coverage = comparison['vae']['total_reached']
                pca_coverage = comparison['pca']['total_reached']
                
                if pca_coverage > 0:
                    improvement = ((vae_coverage - pca_coverage) / pca_coverage) * 100
                    if improvement > 10:
                        print(f"  🎉 VAE provides {improvement:.1f}% better coverage than PCA!")
                    elif improvement > 0:
                        print(f"  📈 VAE provides {improvement:.1f}% better coverage than PCA")
                    else:
                        print(f"  📉 PCA provides {-improvement:.1f}% better coverage than VAE")
                
                vae_hops = comparison['vae']['avg_path_length']
                pca_hops = comparison['pca']['avg_path_length']
                if vae_hops < pca_hops:
                    print(f"  🚀 VAE requires {pca_hops - vae_hops:.1f} fewer hops on average")
                elif vae_hops > pca_hops:
                    print(f"  🐌 VAE requires {vae_hops - pca_hops:.1f} more hops on average")
            
            # Identify potential issues
            total_sample = params['sample_size']
            for emb_type, data in comparison.items():
                dead_zone_pct = (data['dead_zones'] / total_sample) * 100 if total_sample > 0 else 0
                if dead_zone_pct > 20:
                    print(f"  ⚠️  {emb_type} has high dead zone percentage ({dead_zone_pct:.1f}%)")
                if data['avg_path_length'] > 3:
                    print(f"  ⚠️  {emb_type} requires long paths ({data['avg_path_length']:.1f} avg hops)")
        
        print(f"\n💾 Full report saved to: {output_path}")
        
        return report

def main():
    parser = argparse.ArgumentParser(description='Analyze reachability across embedding spaces')
    parser.add_argument('--samples', type=int, default=500, help='Number of starting tracks')
    parser.add_argument('--max-hops', type=int, default=5, help='Maximum hops to explore')
    parser.add_argument('--radius', type=float, default=0.3, help='Search radius')
    parser.add_argument('--server-url', default='http://localhost:3001', help='Server URL')
    parser.add_argument('--output', default='reachability_analysis_report.json', help='Output path')
    
    args = parser.parse_args()
    
    try:
        # Initialize analyzer
        analyzer = ReachabilityAnalyzer(args.server_url)
        analyzer.initialize()
        
        # Run reachability analysis
        results = analyzer.compare_reachability(
            sample_size=args.samples,
            max_hops=args.max_hops,
            radius=args.radius
        )
        
        # Generate report
        report = analyzer.generate_reachability_report(results, args.output)
        
        logger.info("🎉 Reachability analysis complete!")
        
    except Exception as e:
        logger.error(f"❌ Analysis failed: {e}")
        raise

if __name__ == '__main__':
    main()