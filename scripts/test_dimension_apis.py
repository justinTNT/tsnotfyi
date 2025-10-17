#!/usr/bin/env python3
"""
Test the new dimension analysis APIs to ensure they work correctly.

Usage:
    python scripts/test_dimension_apis.py
"""

import requests
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_api_endpoint(url, description):
    """Test a single API endpoint"""
    try:
        logger.info(f"Testing {description}...")
        response = requests.get(url, timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            logger.info(f"  ✅ {description} - Success")
            return data
        else:
            logger.error(f"  ❌ {description} - Status {response.status_code}")
            return None
            
    except requests.RequestException as e:
        logger.error(f"  ❌ {description} - Error: {e}")
        return None

def main():
    server_url = "http://localhost:3001"
    
    print("🧪 Testing Dimension Analysis APIs")
    print("="*50)
    
    # Test 1: Dimension stats
    stats = test_api_endpoint(
        f"{server_url}/api/dimensions/stats",
        "Dimension statistics endpoint"
    )
    
    if stats:
        print(f"\n📊 Dimension Stats:")
        print(f"  Total tracks: {stats.get('total_tracks', 'N/A')}")
        print(f"  Available dimensions: {stats.get('available_dimensions', {})}")
        print(f"  Complete data counts: {stats.get('complete_data_counts', {})}")
    
    # Test 2: Random tracks
    random_tracks = test_api_endpoint(
        f"{server_url}/api/kd-tree/random-tracks?count=5",
        "Random tracks endpoint"
    )
    
    if random_tracks and random_tracks.get('tracks'):
        sample_track_id = random_tracks['tracks'][0]['id']
        print(f"\n🎵 Sample track ID: {sample_track_id}")
        
        # Test 3: Track dimensions
        track_dims = test_api_endpoint(
            f"{server_url}/api/dimensions/track/{sample_track_id}",
            f"Track dimensions for {sample_track_id}"
        )
        
        if track_dims:
            dims = track_dims.get('dimensions', {})
            print(f"  Core dims: {len(dims.get('core', {}))}")
            print(f"  PCA dims: {len(dims.get('pca', {}))}")
            print(f"  VAE dims: {len(dims.get('vae', {}))}")
        
        # Test 4: Neighbors
        neighbors = test_api_endpoint(
            f"{server_url}/api/kd-tree/neighbors/{sample_track_id}?radius=0.3&limit=10&include_distances=true",
            f"Neighbors for {sample_track_id}"
        )
        
        if neighbors:
            print(f"  Found {neighbors.get('count', 0)} neighbors within radius 0.3")
            if neighbors.get('neighbors'):
                print(f"  First neighbor: {neighbors['neighbors'][0].get('metadata', {}).get('bt_artist', 'Unknown')} - {neighbors['neighbors'][0].get('metadata', {}).get('bt_title', 'Unknown')}")
    
    # Test 5: Batch neighbors
    if random_tracks and len(random_tracks.get('tracks', [])) >= 3:
        batch_ids = [track['id'] for track in random_tracks['tracks'][:3]]
        
        try:
            logger.info("Testing batch neighbors endpoint...")
            response = requests.post(
                f"{server_url}/api/kd-tree/batch-neighbors",
                json={
                    'track_ids': batch_ids,
                    'radius': 0.3,
                    'limit': 5
                },
                timeout=30
            )
            
            if response.status_code == 200:
                batch_results = response.json()
                logger.info(f"  ✅ Batch neighbors - Success")
                print(f"  Processed {batch_results.get('processed_count', 0)} tracks")
            else:
                logger.error(f"  ❌ Batch neighbors - Status {response.status_code}")
                
        except requests.RequestException as e:
            logger.error(f"  ❌ Batch neighbors - Error: {e}")
    
    print("\n🎉 API testing complete!")
    print("\nIf all tests passed, you can now run:")
    print("  python scripts/analyze_dimension_utility.py --sample-tracks 100")

if __name__ == '__main__':
    main()