#!/usr/bin/env python3
"""
Complete VAE vs PCA Analysis Runner

This script runs the entire analysis pipeline:
1. Tests server connectivity
2. Optionally trains VAE and generates embeddings
3. Runs comprehensive embedding comparison
4. Generates final decision report

Usage:
    # Quick analysis (assume VAE already trained)
    python scripts/run_complete_analysis.py --quick
    
    # Full analysis including VAE training
    python scripts/run_complete_analysis.py --train-vae --epochs 50
    
    # Test only
    python scripts/run_complete_analysis.py --test-only
"""

import argparse
import json
import logging
import os
import sys
import time
import subprocess
from pathlib import Path

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def run_command(cmd, description, timeout=3600):
    """Run a command with proper error handling"""
    logger.info(f"🚀 {description}...")
    
    try:
        start_time = time.time()
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        duration = time.time() - start_time
        
        if result.returncode == 0:
            logger.info(f"  ✅ {description} completed in {duration:.1f}s")
            return True, result.stdout
        else:
            logger.error(f"  ❌ {description} failed:")
            logger.error(f"     STDOUT: {result.stdout}")
            logger.error(f"     STDERR: {result.stderr}")
            return False, result.stderr
            
    except subprocess.TimeoutExpired:
        logger.error(f"  ❌ {description} timed out after {timeout}s")
        return False, "Timeout"
    except Exception as e:
        logger.error(f"  ❌ {description} failed: {e}")
        return False, str(e)

def test_server_connectivity():
    """Test if server is running and accessible"""
    cmd = ['python', 'scripts/test_dimension_apis.py']
    success, output = run_command(cmd, "Testing server connectivity", timeout=30)
    return success

def run_database_check():
    """Check database connection and data availability"""
    cmd = ['python', 'scripts/train_music_vae_poc.py', '--check-db']
    success, output = run_command(cmd, "Checking database connection", timeout=30)
    return success

def train_vae_model(epochs=50, batch_size=64):
    """Train VAE model and generate embeddings"""
    cmd = [
        'python', 'scripts/train_music_vae_poc.py',
        '--epochs', str(epochs),
        '--batch-size', str(batch_size),
        '--device', 'cpu'  # Default to CPU for compatibility
    ]
    success, output = run_command(cmd, f"Training VAE ({epochs} epochs)", timeout=7200)  # 2 hour timeout
    return success

def run_comprehensive_analysis(sample_tracks=1000, radius=0.3):
    """Run the comprehensive embedding analysis"""
    cmd = [
        'python', 'scripts/compare_embedding_coverage_updated.py',
        '--sample-tracks', str(sample_tracks),
        '--radius', str(radius),
        '--output', 'final_embedding_analysis.json'
    ]
    success, output = run_command(cmd, "Running comprehensive analysis", timeout=3600)  # 1 hour timeout
    return success

def generate_decision_report():
    """Generate final decision report based on analysis results"""
    logger.info("📋 Generating final decision report...")
    
    # Load analysis results
    results_file = 'final_embedding_analysis.json'
    if not Path(results_file).exists():
        logger.error(f"Analysis results not found: {results_file}")
        return False
    
    try:
        with open(results_file, 'r') as f:
            analysis_data = json.load(f)
        
        # Extract key decision metrics
        scores = analysis_data.get('embedding_scores', {})
        recommendations = analysis_data.get('recommendations', [])
        
        decision_report = {
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            'analysis_source': results_file,
            'decision_metrics': scores,
            'recommendations': recommendations,
            'decision': 'unknown'
        }
        
        # Make decision based on scores
        if 'vae' in scores and 'pca' in scores:
            vae_score = scores['vae']
            pca_score = scores['pca']
            
            if pca_score > 0:
                improvement = ((vae_score - pca_score) / pca_score) * 100
                
                if improvement > 15:
                    decision_report['decision'] = 'implement_vae'
                    decision_report['reason'] = f'VAE shows significant {improvement:.1f}% improvement'
                elif improvement > 5:
                    decision_report['decision'] = 'consider_vae'
                    decision_report['reason'] = f'VAE shows modest {improvement:.1f}% improvement'
                elif improvement > -5:
                    decision_report['decision'] = 'stick_with_pca'
                    decision_report['reason'] = f'VAE and PCA perform similarly ({improvement:.1f}% difference)'
                else:
                    decision_report['decision'] = 'optimize_pca'
                    decision_report['reason'] = f'PCA outperforms VAE by {-improvement:.1f}%'
            else:
                decision_report['decision'] = 'insufficient_data'
                decision_report['reason'] = 'PCA score is zero or invalid'
        else:
            decision_report['decision'] = 'incomplete_analysis'
            decision_report['reason'] = 'Missing VAE or PCA scores'
        
        # Save decision report
        decision_file = 'vae_decision_report.json'
        with open(decision_file, 'w') as f:
            json.dump(decision_report, f, indent=2)
        
        # Print decision summary
        print("\n" + "="*80)
        print("FINAL DECISION REPORT")
        print("="*80)
        
        print(f"\n🎯 Decision: {decision_report['decision'].replace('_', ' ').title()}")
        print(f"📝 Reason: {decision_report['reason']}")
        
        if scores:
            print(f"\n📊 Performance Scores:")
            for embedding, score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
                print(f"  {embedding}: {score:.3f}")
        
        if recommendations:
            print(f"\n💡 Key Recommendations:")
            for i, rec in enumerate(recommendations, 1):
                print(f"  {i}. {rec}")
        
        print(f"\n📄 Full decision report: {decision_file}")
        print(f"📊 Complete analysis: {results_file}")
        
        return True
        
    except Exception as e:
        logger.error(f"Failed to generate decision report: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Complete VAE vs PCA analysis pipeline')
    parser.add_argument('--test-only', action='store_true', 
                       help='Only test connectivity, do not run analysis')
    parser.add_argument('--quick', action='store_true',
                       help='Skip VAE training, assume already trained')
    parser.add_argument('--train-vae', action='store_true',
                       help='Include VAE training in pipeline')
    parser.add_argument('--epochs', type=int, default=50,
                       help='VAE training epochs')
    parser.add_argument('--sample-tracks', type=int, default=1000,
                       help='Number of tracks for analysis')
    parser.add_argument('--radius', type=float, default=0.3,
                       help='Search radius for analysis')
    
    args = parser.parse_args()
    
    logger.info("🎵 Starting Complete VAE vs PCA Analysis Pipeline")
    logger.info("="*60)
    
    # Step 1: Test server connectivity
    if not test_server_connectivity():
        logger.error("❌ Server connectivity test failed")
        logger.info("Make sure tsnotfyi server is running: cd tsnotfyi && node server.js")
        sys.exit(1)
    
    # Step 2: Check database
    if not run_database_check():
        logger.error("❌ Database check failed")
        logger.info("Ensure PostgreSQL is running and tsnotfyi database exists")
        sys.exit(1)
    
    if args.test_only:
        logger.info("🎉 Connectivity tests passed!")
        return
    
    # Step 3: VAE training (if requested)
    if args.train_vae:
        if not train_vae_model(args.epochs):
            logger.error("❌ VAE training failed")
            logger.info("Check training logs for details")
            sys.exit(1)
    elif not args.quick:
        logger.info("⚠️  Skipping VAE training (use --train-vae to include)")
        logger.info("Assuming VAE embeddings already exist in database")
    
    # Step 4: Comprehensive analysis
    if not run_comprehensive_analysis(args.sample_tracks, args.radius):
        logger.error("❌ Comprehensive analysis failed")
        sys.exit(1)
    
    # Step 5: Decision report
    if not generate_decision_report():
        logger.error("❌ Decision report generation failed")
        sys.exit(1)
    
    logger.info("🎉 Complete analysis pipeline finished successfully!")
    print("\n🎯 Next steps based on decision:")
    print("  - implement_vae: Proceed with full ML Analysis Toolkit")
    print("  - consider_vae: Run cost/benefit analysis")
    print("  - stick_with_pca: Focus on PCA optimizations")
    print("  - optimize_pca: Improve existing PCA system")

if __name__ == '__main__':
    main()