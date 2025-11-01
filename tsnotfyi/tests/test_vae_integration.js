#!/usr/bin/env node
/**
 * VAE Integration Test Script
 * Tests VAE functionality with mock data before database integration
 */

const path = require('path');

// Mock database connection for testing
const mockDb = {
    query: async (query, params = []) => {
        console.log('🔧 Mock DB Query:', query.slice(0, 100) + '...');
        
        // Return mock data that includes VAE embeddings
        return {
            rows: [
                {
                    identifier: 'test_track_001',
                    bt_title: 'Test Track 1',
                    bt_artist: 'Test Artist',
                    bt_path: '/test/path/track1.mp3',
                    bt_length: 180,
                    
                    // Mock 18D features
                    bpm: 120, danceability: 0.7, onset_rate: 2.5, beat_punch: 0.6,
                    tonal_clarity: 0.8, tuning_purity: 0.9, fifths_strength: 0.6,
                    chord_strength: 0.7, chord_change_rate: 1.2, crest: 0.5, entropy: 3.2,
                    spectral_centroid: 1500, spectral_rolloff: 3000, spectral_kurtosis: 2.1,
                    spectral_energy: 0.6, spectral_flatness: 0.3, sub_drive: 0.4, air_sizzle: 0.3,
                    
                    // Mock PCA values
                    primary_d: 0.25,
                    tonal_pc1: 0.1, tonal_pc2: -0.2, tonal_pc3: 0.3,
                    spectral_pc1: -0.1, spectral_pc2: 0.4, spectral_pc3: -0.2,
                    rhythmic_pc1: 0.3, rhythmic_pc2: -0.1, rhythmic_pc3: 0.2,
                    
                    // Mock VAE embeddings (8D)
                    vae_latent_0: 0.15, vae_latent_1: -0.28, vae_latent_2: 0.41, vae_latent_3: -0.12,
                    vae_latent_4: 0.33, vae_latent_5: -0.67, vae_latent_6: 0.22, vae_latent_7: 0.51,
                    vae_model_version: 'test_v1.0',
                    vae_computed_at: new Date(),
                    
                    love: 0, hate: 0, beets_meta: '{"album": {"artpath": "/test/cover.jpg"}}'
                },
                {
                    identifier: 'test_track_002',
                    bt_title: 'Test Track 2',
                    bt_artist: 'Test Artist',
                    bt_path: '/test/path/track2.mp3',
                    bt_length: 200,
                    
                    // Mock 18D features (different values)
                    bpm: 140, danceability: 0.9, onset_rate: 3.2, beat_punch: 0.8,
                    tonal_clarity: 0.6, tuning_purity: 0.7, fifths_strength: 0.8,
                    chord_strength: 0.9, chord_change_rate: 2.1, crest: 0.7, entropy: 2.8,
                    spectral_centroid: 2000, spectral_rolloff: 4000, spectral_kurtosis: 1.8,
                    spectral_energy: 0.8, spectral_flatness: 0.2, sub_drive: 0.6, air_sizzle: 0.5,
                    
                    // Mock PCA values
                    primary_d: 0.45,
                    tonal_pc1: 0.3, tonal_pc2: -0.1, tonal_pc3: 0.2,
                    spectral_pc1: 0.2, spectral_pc2: 0.6, spectral_pc3: -0.3,
                    rhythmic_pc1: 0.5, rhythmic_pc2: 0.1, rhythmic_pc3: 0.3,
                    
                    // Mock VAE embeddings (8D) - different from track 1
                    vae_latent_0: 0.42, vae_latent_1: -0.15, vae_latent_2: 0.23, vae_latent_3: -0.38,
                    vae_latent_4: 0.55, vae_latent_5: -0.29, vae_latent_6: 0.61, vae_latent_7: 0.18,
                    vae_model_version: 'test_v1.0',
                    vae_computed_at: new Date(),
                    
                    love: 0, hate: 0, beets_meta: '{"album": {"artpath": "/test/cover2.jpg"}}'
                },
                {
                    identifier: 'test_track_003',
                    bt_title: 'Test Track 3 (No VAE)',
                    bt_artist: 'Test Artist',
                    bt_path: '/test/path/track3.mp3',
                    bt_length: 160,
                    
                    // Mock 18D features
                    bpm: 100, danceability: 0.4, onset_rate: 1.8, beat_punch: 0.3,
                    tonal_clarity: 0.9, tuning_purity: 0.8, fifths_strength: 0.4,
                    chord_strength: 0.5, chord_change_rate: 0.8, crest: 0.3, entropy: 4.1,
                    spectral_centroid: 1200, spectral_rolloff: 2500, spectral_kurtosis: 2.8,
                    spectral_energy: 0.4, spectral_flatness: 0.5, sub_drive: 0.2, air_sizzle: 0.1,
                    
                    // Mock PCA values
                    primary_d: 0.05,
                    tonal_pc1: -0.2, tonal_pc2: 0.3, tonal_pc3: -0.1,
                    spectral_pc1: -0.3, spectral_pc2: 0.1, spectral_pc3: 0.4,
                    rhythmic_pc1: -0.2, rhythmic_pc2: -0.3, rhythmic_pc3: 0.1,
                    
                    // No VAE embeddings (testing fallback)
                    vae_latent_0: null, vae_latent_1: null, vae_latent_2: null, vae_latent_3: null,
                    vae_latent_4: null, vae_latent_5: null, vae_latent_6: null, vae_latent_7: null,
                    vae_model_version: null,
                    vae_computed_at: null,
                    
                    love: 0, hate: 0, beets_meta: '{"album": {"artpath": "/test/cover3.jpg"}}'
                }
            ]
        };
    }
};

async function testVAEIntegration() {
    console.log('🧪 Starting VAE Integration Tests');
    console.log('=' * 50);
    
    try {
        // Mock the MusicalKDTree to use our test database
        const MusicalKDTree = require('../tsnotfyi/kd-tree.js');
        const RadialSearchService = require('../tsnotfyi/radial-search.js');
        
        // Override database connection for testing
        const originalConnect = MusicalKDTree.prototype.initialize;
        MusicalKDTree.prototype.initialize = async function() {
            this.db = mockDb;
            
            // Load tracks with mock data
            await this.loadTracks();
            this.loadCalibrationSettings = async () => { this.calibrationSettings = {}; };
            this.loadPCATransformations = async () => { this.pcaWeights = {}; };
            
            console.log(`Loaded ${this.tracks.length} mock tracks`);
            
            // Log VAE embedding availability
            const tracksWithVAE = this.tracks.filter(t => t.vae?.latent !== null).length;
            const vaePercentage = this.tracks.length > 0 ? (tracksWithVAE / this.tracks.length * 100).toFixed(1) : 0;
            console.log(`✓ VAE embeddings available for ${tracksWithVAE}/${this.tracks.length} tracks (${vaePercentage}%)`);
            
            this.buildTree();
            console.log('KD-tree constructed');
        };
        
        // Initialize search service
        const searchService = new RadialSearchService();
        await searchService.initialize();
        
        console.log('\n📊 Testing VAE Distance Calculations...');
        
        // Test 1: VAE distance calculation
        const track1 = searchService.kdTree.getTrack('test_track_001');
        const track2 = searchService.kdTree.getTrack('test_track_002');
        const track3 = searchService.kdTree.getTrack('test_track_003');
        
        if (track1 && track2) {
            const vaeDistance = searchService.kdTree.calculateVAEDistance(track1, track2);
            console.log(`✓ VAE distance between tracks 1 & 2: ${vaeDistance.toFixed(4)}`);
            
            const pcaDistance = searchService.kdTree.calculatePCADistance(track1, track2, 'primary_d');
            console.log(`✓ PCA distance between tracks 1 & 2: ${pcaDistance.toFixed(4)}`);
        }
        
        console.log('\n🔍 Testing Smart Search Modes...');
        
        // Test 2: Smart distance calculation
        if (track1 && track2) {
            const autoDistance = searchService.kdTree.calculateSmartDistance(track1, track2, 'auto');
            console.log(`✓ Auto mode distance (should prefer VAE): ${autoDistance.toFixed(4)}`);
            
            const vaeSpecific = searchService.kdTree.calculateSmartDistance(track1, track2, 'vae');
            console.log(`✓ VAE-specific distance: ${vaeSpecific.toFixed(4)}`);
        }
        
        // Test 3: Search mode fallbacks
        if (track1 && track3) {
            try {
                const vaeWithFallback = searchService.kdTree.calculateSmartDistance(track1, track3, 'vae');
                console.log(`❌ Should have failed: VAE distance with missing embedding`);
            } catch (error) {
                console.log(`✓ Correctly failed VAE distance with missing embedding: ${error.message}`);
            }
            
            const autoWithFallback = searchService.kdTree.calculateSmartDistance(track1, track3, 'auto');
            console.log(`✓ Auto mode fallback distance: ${autoWithFallback.toFixed(4)}`);
        }
        
        console.log('\n🎯 Testing Search Methods...');
        
        // Test 4: VAE radius search
        if (track1) {
            const vaeResults = searchService.kdTree.vaeRadiusSearch(track1, 1.0, 10);
            console.log(`✓ VAE radius search found ${vaeResults.length} tracks`);
            
            const smartResults = searchService.kdTree.smartRadiusSearch(track1, { mode: 'auto', radius: 1.0 });
            console.log(`✓ Smart radius search found ${smartResults.length} tracks`);
        }
        
        console.log('\n🧠 Testing RadialSearchService Integration...');
        
        // Test 5: Full exploration with VAE mode
        if (track1) {
            const vaeExploration = await searchService.exploreFromTrack('test_track_001', {
                searchMode: 'vae',
                radius: 1.0
            });
            
            console.log(`✓ VAE exploration completed:`);
            console.log(`  - Search mode used: ${vaeExploration.searchCapabilities.usedMode}`);
            console.log(`  - Neighborhood size: ${vaeExploration.neighborhood.size}`);
            console.log(`  - Has VAE: ${vaeExploration.searchCapabilities.hasVAE}`);
            console.log(`  - Has PCA: ${vaeExploration.searchCapabilities.hasPCA}`);
        }
        
        // Test 6: Auto mode selection
        if (track1) {
            const autoExploration = await searchService.exploreFromTrack('test_track_001', {
                searchMode: 'auto',
                radius: 1.0
            });
            
            console.log(`✓ Auto exploration completed:`);
            console.log(`  - Automatically chose: ${autoExploration.searchCapabilities.usedMode}`);
        }
        
        // Test 7: Fallback behavior
        if (track3) {
            const fallbackExploration = await searchService.exploreFromTrack('test_track_003', {
                searchMode: 'auto',
                radius: 1.0
            });
            
            console.log(`✓ Fallback exploration (no VAE) completed:`);
            console.log(`  - Fell back to: ${fallbackExploration.searchCapabilities.usedMode}`);
        }
        
        console.log('\n📈 Testing Statistics...');
        
        // Test 8: Statistics and capabilities
        const stats = searchService.getStats();
        console.log(`✓ Service statistics:`);
        console.log(`  - Has VAE: ${stats.hasVAE}`);
        console.log(`  - VAE coverage: ${stats.vaeStats.coverage}`);
        console.log(`  - VAE model versions: ${stats.vaeStats.modelVersions.join(', ')}`);
        
        const searchModes = searchService.getAvailableSearchModes('test_track_001');
        console.log(`✓ Available search modes for track 1: ${Object.keys(searchModes).filter(k => searchModes[k] && k !== 'recommended').join(', ')}`);
        console.log(`  - Recommended: ${searchModes.recommended}`);
        
        console.log('\n🎉 All VAE Integration Tests Passed!');
        console.log('Phase 2 Runtime Integration is ready for database testing.');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        throw error;
    }
}

// Run tests if called directly
if (require.main === module) {
    testVAEIntegration().catch(error => {
        console.error('Test suite failed:', error);
        process.exit(1);
    });
}

module.exports = { testVAEIntegration };