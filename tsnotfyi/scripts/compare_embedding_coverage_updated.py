#!/usr/bin/env python3
"""
Comprehensive embedding comparison using all analysis tools.

This script runs all three core analysis tools and generates a unified
comparison report between embedding types (Core, PCA, VAE, Auto).

It orchestrates:
1. Dimension utility analysis 
2. Density distribution analysis
3. Reachability analysis

Usage:
    python scripts/compare_embedding_coverage_updated.py --sample-tracks 1000 --radius 0.3
"""

import argparse
import json
import logging
import os
import sys
import time
import subprocess
from pathlib import Path

import requests

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ComprehensiveEmbeddingAnalyzer:
    def __init__(self, server_url='http://localhost:3001'):
        self.server_url = server_url
        self.session = requests.Session()
        
    def check_server_connection(self):
        """Verify server is accessible"""
        try:
            response = self.session.get(f"{self.server_url}/api/dimensions/stats", timeout=5)
            response.raise_for_status()
            stats = response.json()
            
            logger.info(f"✅ Server connected successfully")
            logger.info(f"   Total tracks: {stats['total_tracks']:,}")
            logger.info(f"   Available embeddings: Core({stats['available_dimensions']['core']}), "
                       f"PCA({stats['available_dimensions']['pca']}), "
                       f"VAE({stats['available_dimensions']['vae']})")
            
            return stats
            
        except requests.RequestException as e:
            logger.error(f"❌ Failed to connect to server: {e}")
            logger.info("Make sure the tsnotfyi server is running on port 3001")
            raise
    
    def run_analysis_tool(self, script_name, args_dict, description):
        """Run a single analysis tool and return the output path"""
        logger.info(f"🔬 Running {description}...")
        
        # Build command arguments
        cmd = ['python', f'scripts/{script_name}']
        for key, value in args_dict.items():
            cmd.extend([f'--{key}', str(value)])
        
        try:
            # Run the analysis tool
            start_time = time.time()
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)  # 30 min timeout
            duration = time.time() - start_time
            
            if result.returncode == 0:
                logger.info(f"  ✅ {description} completed in {duration:.1f}s")
                return args_dict.get('output', 'output.json')
            else:
                logger.error(f"  ❌ {description} failed:")
                logger.error(f"     STDOUT: {result.stdout}")
                logger.error(f"     STDERR: {result.stderr}")
                return None
                
        except subprocess.TimeoutExpired:
            logger.error(f"  ❌ {description} timed out after 30 minutes")
            return None
        except Exception as e:
            logger.error(f"  ❌ {description} failed with exception: {e}")
            return None
    
    def run_all_analyses(self, sample_tracks=1000, radius=0.3, max_hops=5):
        """Run all three analysis tools"""
        logger.info("🚀 Starting comprehensive embedding analysis...")
        
        # Define analysis configurations
        analyses = [
            {
                'script': 'analyze_dimension_utility.py',
                'description': 'Dimension Utility Analysis',
                'args': {
                    'sample-tracks': sample_tracks,
                    'radius': radius,
                    'server-url': self.server_url,
                    'output': 'dimension_utility_results.json'
                }
            },
            {
                'script': 'analyze_density.py', 
                'description': 'Density Distribution Analysis',
                'args': {
                    'sample-tracks': sample_tracks,
                    'radius': radius,
                    'server-url': self.server_url,
                    'output': 'density_analysis_results.json'
                }
            },
            {
                'script': 'analyze_reachability.py',
                'description': 'Reachability Analysis', 
                'args': {
                    'samples': sample_tracks // 2,  # Use fewer samples for reachability (it's expensive)
                    'max-hops': max_hops,
                    'radius': radius,
                    'server-url': self.server_url,
                    'output': 'reachability_analysis_results.json'
                }
            }
        ]
        
        # Run each analysis
        results = {}
        for analysis in analyses:
            output_path = self.run_analysis_tool(
                analysis['script'],
                analysis['args'], 
                analysis['description']
            )
            
            if output_path and Path(output_path).exists():
                try:
                    with open(output_path, 'r') as f:
                        results[analysis['description']] = json.load(f)
                    logger.info(f"  📊 {analysis['description']} results loaded")
                except Exception as e:
                    logger.error(f"  ❌ Failed to load results from {output_path}: {e}")
            else:
                logger.warning(f"  ⚠️  {analysis['description']} did not produce output")
        
        return results
    
    def generate_unified_report(self, analysis_results, output_path):
        """Generate a unified comparison report from all analyses"""
        logger.info("📋 Generating unified comparison report...")
        
        # Extract key metrics from each analysis
        unified_comparison = {}
        
        # Process dimension utility results
        if 'Dimension Utility Analysis' in analysis_results:
            utility_data = analysis_results['Dimension Utility Analysis']
            
            # Get top dimensions by category
            workhorses = utility_data.get('summary', {}).get('workhorses', [])
            specialists = utility_data.get('summary', {}).get('specialists', [])
            redundant = utility_data.get('summary', {}).get('redundant', [])
            
            unified_comparison['dimension_insights'] = {
                'total_dimensions_analyzed': len(utility_data.get('global_rankings', [])),
                'workhorses': workhorses,
                'specialists': specialists, 
                'redundant': redundant,
                'by_space': utility_data.get('by_space', {})
            }
        
        # Process density results
        if 'Density Distribution Analysis' in analysis_results:
            density_data = analysis_results['Density Distribution Analysis']
            
            comparison = density_data.get('comparison_summary', {})
            unified_comparison['density_comparison'] = {}
            
            for embedding_type, metrics in comparison.items():
                unified_comparison['density_comparison'][embedding_type] = {
                    'mean_neighbors': metrics.get('mean_density', 0),
                    'isolated_percentage': metrics.get('isolated_fraction', 0) * 100,
                    'distance_quality': metrics.get('distance_quality', 'unknown')
                }
        
        # Process reachability results
        if 'Reachability Analysis' in analysis_results:
            reachability_data = analysis_results['Reachability Analysis']
            
            comparison = reachability_data.get('comparison_summary', {})
            unified_comparison['reachability_comparison'] = {}
            
            for embedding_type, metrics in comparison.items():
                unified_comparison['reachability_comparison'][embedding_type] = {
                    'tracks_reachable': metrics.get('total_reached', 0),
                    'avg_path_length': metrics.get('avg_path_length', 0),
                    'dead_zones': metrics.get('dead_zones', 0)
                }
        
        # Calculate overall scores
        embedding_scores = self.calculate_embedding_scores(unified_comparison)
        
        # Create final unified report
        unified_report = {
            'analysis_summary': {
                'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
                'analyses_completed': list(analysis_results.keys()),
                'embedding_types_tested': list(embedding_scores.keys()) if embedding_scores else []
            },
            'unified_comparison': unified_comparison,
            'embedding_scores': embedding_scores,
            'recommendations': self.generate_recommendations(unified_comparison, embedding_scores),
            'detailed_results': analysis_results
        }
        
        # Save unified report
        with open(output_path, 'w') as f:
            json.dump(unified_report, f, indent=2, default=str)
        
        # Print executive summary
        self.print_executive_summary(unified_report)
        
        return unified_report
    
    def calculate_embedding_scores(self, comparison_data):
        """Calculate composite scores for each embedding type"""
        scores = {}
        
        # Get available embedding types from any analysis
        embedding_types = set()
        for analysis_type, data in comparison_data.items():
            if isinstance(data, dict):
                embedding_types.update(data.keys())
        
        for embedding_type in embedding_types:
            if embedding_type in ['core', 'pca', 'vae', 'auto']:
                score = 0
                components = 0
                
                # Density score (0-1, higher is better)
                if 'density_comparison' in comparison_data:
                    density_data = comparison_data['density_comparison'].get(embedding_type, {})
                    mean_neighbors = density_data.get('mean_neighbors', 0)
                    isolated_pct = density_data.get('isolated_percentage', 100)
                    
                    density_score = min(mean_neighbors / 50, 1.0) * 0.7 + (1 - isolated_pct / 100) * 0.3
                    score += density_score
                    components += 1
                
                # Reachability score (0-1, higher is better)
                if 'reachability_comparison' in comparison_data:
                    reach_data = comparison_data['reachability_comparison'].get(embedding_type, {})
                    tracks_reachable = reach_data.get('tracks_reachable', 0)
                    avg_path_length = reach_data.get('avg_path_length', 10)
                    dead_zones = reach_data.get('dead_zones', 1000)
                    
                    # Normalize reachability metrics
                    coverage_score = min(tracks_reachable / 1000, 1.0)  # Assume 1000 is good coverage
                    path_score = max(0, 1 - (avg_path_length - 1) / 4)  # 1-5 hops normalized
                    dead_zone_score = max(0, 1 - dead_zones / 100)  # <100 dead zones is good
                    
                    reachability_score = coverage_score * 0.5 + path_score * 0.3 + dead_zone_score * 0.2
                    score += reachability_score
                    components += 1
                
                # Calculate final score
                if components > 0:
                    scores[embedding_type] = score / components
                else:
                    scores[embedding_type] = 0
        
        return scores
    
    def generate_recommendations(self, comparison_data, embedding_scores):
        """Generate actionable recommendations based on analysis results"""
        recommendations = []
        
        if not embedding_scores:
            return ["Insufficient data for recommendations"]
        
        # Find best overall embedding
        best_embedding = max(embedding_scores.keys(), key=lambda k: embedding_scores[k])
        best_score = embedding_scores[best_embedding]
        
        recommendations.append(f"Best overall embedding: {best_embedding} (score: {best_score:.3f})")
        
        # VAE vs PCA comparison if both available
        if 'vae' in embedding_scores and 'pca' in embedding_scores:
            vae_score = embedding_scores['vae']
            pca_score = embedding_scores['pca']
            improvement = ((vae_score - pca_score) / pca_score) * 100 if pca_score > 0 else 0
            
            if improvement > 15:
                recommendations.append(f"🎉 VAE shows significant improvement ({improvement:.1f}%) - implement full VAE pipeline")
            elif improvement > 5:
                recommendations.append(f"📈 VAE shows modest improvement ({improvement:.1f}%) - consider VAE implementation")
            elif improvement > -5:
                recommendations.append(f"📊 VAE and PCA perform similarly - PCA may be simpler choice")
            else:
                recommendations.append(f"📉 PCA outperforms VAE ({-improvement:.1f}%) - stick with PCA")
        
        # Dimension utility recommendations
        if 'dimension_insights' in comparison_data:
            insights = comparison_data['dimension_insights']
            total_dims = insights.get('total_dimensions_analyzed', 0)
            workhorses = len(insights.get('workhorses', []))
            redundant = len(insights.get('redundant', []))
            
            if redundant > total_dims * 0.3:
                recommendations.append(f"Consider dimension reduction: {redundant}/{total_dims} dimensions appear redundant")
            
            if workhorses < 5:
                recommendations.append(f"Only {workhorses} workhorse dimensions found - may need more diverse features")
        
        # Performance recommendations
        if 'density_comparison' in comparison_data:
            for emb_type, data in comparison_data['density_comparison'].items():
                isolated_pct = data.get('isolated_percentage', 0)
                if isolated_pct > 20:
                    recommendations.append(f"⚠️  {emb_type} has high isolation ({isolated_pct:.1f}%) - consider larger radius")
        
        return recommendations
    
    def print_executive_summary(self, report):
        """Print executive summary of all analyses"""
        print("\n" + "="*80)
        print("COMPREHENSIVE EMBEDDING ANALYSIS - EXECUTIVE SUMMARY")
        print("="*80)
        
        summary = report['analysis_summary']
        print(f"\n📊 Analysis Overview:")
        print(f"  Timestamp: {summary['timestamp']}")
        print(f"  Analyses completed: {len(summary['analyses_completed'])}")
        print(f"  Embedding types tested: {', '.join(summary['embedding_types_tested'])}")
        
        # Show embedding scores
        scores = report.get('embedding_scores', {})
        if scores:
            print(f"\n🏆 Embedding Performance Scores (0-1, higher better):")
            sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            for embedding, score in sorted_scores:
                print(f"  {embedding:4s}: {score:.3f}")
        
        # Show key comparisons
        comparison = report.get('unified_comparison', {})
        
        if 'density_comparison' in comparison:
            print(f"\n📈 Density Summary:")
            for emb_type, data in comparison['density_comparison'].items():
                print(f"  {emb_type:4s}: {data['mean_neighbors']:5.1f} avg neighbors, "
                      f"{data['isolated_percentage']:4.1f}% isolated")
        
        if 'reachability_comparison' in comparison:
            print(f"\n🌐 Reachability Summary:")
            for emb_type, data in comparison['reachability_comparison'].items():
                print(f"  {emb_type:4s}: {data['tracks_reachable']:5,} reachable, "
                      f"{data['avg_path_length']:4.1f} avg hops")
        
        # Show recommendations
        recommendations = report.get('recommendations', [])
        if recommendations:
            print(f"\n🎯 Key Recommendations:")
            for i, rec in enumerate(recommendations, 1):
                print(f"  {i}. {rec}")
        
        print(f"\n💾 Full report saved to comprehensive analysis output")

def main():
    parser = argparse.ArgumentParser(description='Comprehensive embedding comparison analysis')
    parser.add_argument('--sample-tracks', type=int, default=1000, 
                       help='Number of tracks to sample for analysis')
    parser.add_argument('--radius', type=float, default=0.3, 
                       help='Search radius for neighbor analysis')
    parser.add_argument('--max-hops', type=int, default=5,
                       help='Maximum hops for reachability analysis')
    parser.add_argument('--server-url', default='http://localhost:3001',
                       help='URL of tsnotfyi server')
    parser.add_argument('--output', default='comprehensive_embedding_analysis.json',
                       help='Output report path')
    
    args = parser.parse_args()
    
    try:
        # Initialize analyzer
        analyzer = ComprehensiveEmbeddingAnalyzer(args.server_url)
        
        # Check server connection
        analyzer.check_server_connection()
        
        # Run all analyses
        analysis_results = analyzer.run_all_analyses(
            sample_tracks=args.sample_tracks,
            radius=args.radius,
            max_hops=args.max_hops
        )
        
        if not analysis_results:
            logger.error("No analysis results generated - check individual tool outputs")
            sys.exit(1)
        
        # Generate unified report
        unified_report = analyzer.generate_unified_report(analysis_results, args.output)
        
        logger.info("🎉 Comprehensive analysis complete!")
        print(f"\n📄 Detailed results available in: {args.output}")
        
    except Exception as e:
        logger.error(f"❌ Analysis failed: {e}")
        raise

if __name__ == '__main__':
    main()