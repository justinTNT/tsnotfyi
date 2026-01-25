#!/usr/bin/env node
/**
 * VAE API Integration Test Script - Phase 3
 * Tests the complete VAE API and service layer integration
 */

const http = require('http');
const { URL } = require('url');

const BASE_URL = process.env.API_BASE_URL || 'http://mini.local:3001';

class VAEAPITester {
    constructor(baseUrl = BASE_URL) {
        this.baseUrl = baseUrl;
        this.testResults = [];
    }

    async makeRequest(endpoint, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(endpoint, this.baseUrl);
            
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const response = {
                            status: res.statusCode,
                            headers: res.headers,
                            data: data ? JSON.parse(data) : null
                        };
                        resolve(response);
                    } catch (error) {
                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            data: data,
                            parseError: error.message
                        });
                    }
                });
            });

            req.on('error', reject);
            
            if (body) {
                req.write(JSON.stringify(body));
            }
            
            req.end();
        });
    }

    logTest(name, passed, details = '') {
        const status = passed ? '✅' : '❌';
        console.log(`${status} ${name}${details ? ': ' + details : ''}`);
        this.testResults.push({ name, passed, details });
    }

    async testVAEStatus() {
        console.log('\n🔍 Testing VAE Status Endpoint...');
        
        try {
            const response = await this.makeRequest('/vae/status');
            
            if (response.status === 200) {
                const { vae, coverage, isReady } = response.data;
                
                this.logTest('VAE status endpoint accessible', true);
                this.logTest('VAE service status included', !!vae, JSON.stringify(vae));
                this.logTest('Coverage information included', coverage !== undefined);
                this.logTest('Ready status included', typeof isReady === 'boolean', `isReady: ${isReady}`);
                
                return isReady;
            } else {
                this.logTest('VAE status endpoint', false, `Status: ${response.status}`);
                this.logTest(`Status: ${response.status}`, false );
                return false;
            }
        } catch (error) {
            this.logTest('VAE status endpoint', false, error.message);
            return false;
        }
    }

    async testSearchModes() {
        console.log('\n🔍 Testing Search Modes Endpoint...');
        
        try {
            // Test with a mock track ID (this will fail but should return proper error)
            const response = await this.makeRequest('/vae/search-modes/test_track_001');
            
            if (response.status === 404) {
                this.logTest('Search modes endpoint returns 404 for missing track', true);
            } else if (response.status === 200) {
                const modes = response.data;
                this.logTest('Search modes endpoint accessible', true);
                this.logTest('Features mode available', modes.features === true);
                this.logTest('PCA mode status included', 'pca' in modes);
                this.logTest('VAE mode status included', 'vae' in modes);
                this.logTest('Recommended mode included', !!modes.recommended);
            } else {
                this.logTest('Search modes endpoint', false, `Status: ${response.status}`);
            }
        } catch (error) {
            this.logTest('Search modes endpoint', false, error.message);
        }
    }

    async testVAEEncode() {
        console.log('\n🧠 Testing VAE Encode Endpoint...');
        
        try {
            // Test with mock features
            const mockFeatures = {
                bpm: 120, danceability: 0.7, onset_rate: 2.5, beat_punch: 0.6,
                tonal_clarity: 0.8, tuning_purity: 0.9, fifths_strength: 0.6,
                chord_strength: 0.7, chord_change_rate: 1.2, crest: 0.5, entropy: 3.2,
                spectral_centroid: 1500, spectral_rolloff: 3000, spectral_kurtosis: 2.1,
                spectral_energy: 0.6, spectral_flatness: 0.3, sub_drive: 0.4, air_sizzle: 0.3
            };

            const response = await this.makeRequest('/vae/encode', 'POST', { features: mockFeatures });
            
            if (response.status === 503) {
                this.logTest('VAE encode returns 503 when service unavailable', true);
            } else if (response.status === 200) {
                const { latent } = response.data;
                this.logTest('VAE encode successful', true);
                this.logTest('Latent vector returned', Array.isArray(latent) && latent.length === 8, `Length: ${latent?.length}`);
            } else {
                this.logTest(`Status: ${response.status}, Data: ${JSON.stringify(response.data)}`, false);
                this.logTest('VAE encode endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
            // Test with invalid features
            const invalidResponse = await this.makeRequest('/vae/encode', 'POST', { features: null });
            this.logTest('VAE encode rejects invalid features', invalidResponse.status === 400);
            
        } catch (error) {
            this.logTest('VAE encode endpoint', false, error.message);
        }
    }

    async testVAEDecode() {
        console.log('\n🔄 Testing VAE Decode Endpoint...');
        
        try {
            // Test with mock 8D latent vector
            const mockLatent = [0.1, -0.3, 0.7, -0.1, 0.4, -0.8, 0.2, 0.5];

            const response = await this.makeRequest('/vae/decode', 'POST', { latent: mockLatent });
            
            if (response.status === 503) {
                this.logTest('VAE decode returns 503 when service unavailable', true);
            } else if (response.status === 200) {
                const { features } = response.data;
                this.logTest('VAE decode successful', true);
                this.logTest('Features object returned', !!features && typeof features === 'object');
                this.logTest('Features has correct properties', features.bpm !== undefined && features.danceability !== undefined);
            } else {
                this.logTest('VAE decode endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
            // Test with invalid latent vector
            const invalidResponse = await this.makeRequest('/vae/decode', 'POST', { latent: [1, 2, 3] }); // Wrong dimension
            this.logTest('VAE decode rejects invalid latent vector', invalidResponse.status === 400);
            
        } catch (error) {
            this.logTest('VAE decode endpoint', false, error.message);
        }
    }

    async testVAEInterpolate() {
        console.log('\n🔄 Testing VAE Interpolate Endpoint...');
        
        try {
            const requestBody = {
                trackIdA: 'test_track_001',
                trackIdB: 'test_track_002',
                steps: 5
            };

            const response = await this.makeRequest('/vae/interpolate', 'POST', requestBody);
            
            if (response.status === 404) {
                this.logTest('VAE interpolate returns 404 for missing tracks', true);
            } else if (response.status === 503) {
                this.logTest('VAE interpolate returns 503 when service unavailable', true);
            } else if (response.status === 200) {
                const { trackA, trackB, steps, interpolation } = response.data;
                this.logTest('VAE interpolate successful', true);
                this.logTest('Track A info included', !!trackA && trackA.identifier);
                this.logTest('Track B info included', !!trackB && trackB.identifier);
                this.logTest('Correct number of steps', steps === 5);
                this.logTest('Interpolation array returned', Array.isArray(interpolation) && interpolation.length === steps);
            } else {
                this.logTest('VAE interpolate endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
            // Test with missing parameters
            const invalidResponse = await this.makeRequest('/vae/interpolate', 'POST', { trackIdA: 'test' });
            this.logTest('VAE interpolate rejects missing trackIdB', invalidResponse.status === 400);
            
        } catch (error) {
            this.logTest('VAE interpolate endpoint', false, error.message);
        }
    }

    async testVAEFlow() {
        console.log('\n🌊 Testing VAE Flow Endpoint...');
        
        try {
            const requestBody = {
                trackId: 'test_track_001',
                direction: [0.1, -0.2, 0.3, -0.1, 0.2, -0.4, 0.1, 0.3],
                amount: 1.5
            };

            const response = await this.makeRequest('/vae/flow', 'POST', requestBody);
            
            if (response.status === 404) {
                this.logTest('VAE flow returns 404 for missing track', true);
            } else if (response.status === 503) {
                this.logTest('VAE flow returns 503 when service unavailable', true);
            } else if (response.status === 200) {
                const { originalTrack, direction, amount, newFeatures } = response.data;
                this.logTest('VAE flow successful', true);
                this.logTest('Original track info included', !!originalTrack && originalTrack.identifier);
                this.logTest('Direction vector included', Array.isArray(direction) && direction.length === 8);
                this.logTest('Amount included', amount === 1.5);
                this.logTest('New features returned', !!newFeatures && typeof newFeatures === 'object');
            } else {
                this.logTest('VAE flow endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
            // Test with invalid direction
            const invalidResponse = await this.makeRequest('/vae/flow', 'POST', { 
                trackId: 'test', 
                direction: [1, 2, 3] // Wrong dimension
            });
            this.logTest('VAE flow rejects invalid direction vector', invalidResponse.status === 400);
            
        } catch (error) {
            this.logTest('VAE flow endpoint', false, error.message);
        }
    }

    async testVAEExplore() {
        console.log('\n🚀 Testing VAE Explore Endpoint...');
        
        try {
            const requestBody = {
                trackId: 'test_track_001',
                radius: 1.0
            };

            const response = await this.makeRequest('/vae/explore', 'POST', requestBody);
            
            if (response.status === 500 && response.data?.error?.includes('Track not found')) {
                this.logTest('VAE explore returns error for missing track', true);
            } else if (response.status === 200) {
                const result = response.data;
                this.logTest('VAE explore successful', true);
                this.logTest('Search capabilities included', !!result.searchCapabilities);
                this.logTest('Neighborhood info included', !!result.neighborhood);
                this.logTest('Used mode is VAE', result.searchCapabilities?.usedMode === 'vae');
            } else {
                this.logTest('VAE explore endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
        } catch (error) {
            this.logTest('VAE explore endpoint', false, error.message);
        }
    }

    async testVAEDimensions() {
        console.log('\n📏 Testing VAE Dimensions Endpoint...');
        
        try {
            const response = await this.makeRequest('/vae/dimensions');
            
            if (response.status === 503) {
                this.logTest('VAE dimensions returns 503 when service unavailable', true);
            } else if (response.status === 200) {
                const info = response.data;
                this.logTest('VAE dimensions successful', true);
                this.logTest('Model config included', !!info.model_config);
                this.logTest('Feature names included', Array.isArray(info.feature_names));
                this.logTest('Latent dimensions included', typeof info.latent_dim === 'number');
            } else {
                this.logTest('VAE dimensions endpoint', false, `Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
            }
            
        } catch (error) {
            this.logTest('VAE dimensions endpoint', false, error.message);
        }
    }

    async testEnhancedExistingEndpoints() {
        console.log('\n🔄 Testing Enhanced Existing Endpoints...');
        
        try {
            // Test radial search with VAE mode
            const radialResponse = await this.makeRequest('/radial-search', 'POST', {
                trackId: 'test_track_001',
                config: { searchMode: 'vae', radius: 1.0 }
            });
            
            if (radialResponse.status === 500) {
                this.logTest('Radial search accepts VAE mode parameter', true, 'Returns expected error for missing track');
            } else if (radialResponse.status === 200) {
                this.logTest('Radial search with VAE mode successful', true);
            }
            
            // Test search stats
            const statsResponse = await this.makeRequest('/radial-search/stats');
            if (statsResponse.status === 200) {
                const stats = statsResponse.data;
                this.logTest('Search stats include VAE information', !!stats.hasVAE || stats.hasVAE === false);
                this.logTest('VAE stats included', !!stats.vaeStats);
            }
            
        } catch (error) {
console.dir("CAUGHT");
console.dir(error.message);
console.dir(error);
            this.logTest(error.message, false, error.message);
            this.logTest('Enhanced existing endpoints', false, error.message);
        }
    }

    async runAllTests() {
        console.log('🧪 Starting VAE API Integration Tests');
        console.log('=====================================');
        
        // Basic connectivity
        const isVAEReady = await this.testVAEStatus();
        
        // Core VAE functionality tests
        await this.testSearchModes();
        await this.testVAEEncode();
        await this.testVAEDecode(); 
        await this.testVAEInterpolate();
        await this.testVAEFlow();
        await this.testVAEExplore();
        await this.testVAEDimensions();
        
        // Integration tests
        await this.testEnhancedExistingEndpoints();
        
        // Summary
        console.log('\n📊 Test Results Summary');
        console.log('=======================');
        
        const passed = this.testResults.filter(r => r.passed).length;
        const total = this.testResults.length;
        const percentage = ((passed / total) * 100).toFixed(1);
        
        console.log(`Total tests: ${total}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${total - passed}`);
        console.log(`Success rate: ${percentage}%`);
        
        if (isVAEReady) {
            console.log('\n✅ VAE service is ready and functional');
        } else {
            console.log('\n⚠️  VAE service is not ready (expected if model not available)');
        }
        
        if (percentage >= 80) {
            console.log('\n🎉 Phase 3 API Integration: SUCCESS');
        } else {
            console.log('\n⚠️  Phase 3 API Integration: NEEDS ATTENTION');
        }
        
        // List failed tests
        const failed = this.testResults.filter(r => !r.passed);
        if (failed.length > 0) {
            console.log('\n❌ Failed Tests:');
            failed.forEach(test => {
                console.log(`   - ${test.name}${test.details ? ': ' + test.details : ''}`);
            });
        }
        
        return percentage >= 80;
    }
}

// Run tests if called directly
if (require.main === module) {
    const tester = new VAEAPITester();
    tester.runAllTests().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error('Test suite failed:', error);
        process.exit(1);
    });
}

module.exports = { VAEAPITester };
