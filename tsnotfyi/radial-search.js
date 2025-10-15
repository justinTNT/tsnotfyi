const MusicalKDTree = require('./kd-tree');

class RadialSearchService {
    constructor() {
        this.kdTree = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        try {
            this.kdTree = new MusicalKDTree();
            await this.kdTree.initialize();
            this.initialized = true;
            console.log('Radial search service initialized');
        } catch (error) {
            console.error('Failed to initialize radial search service:', error);
            throw error;
        }
    }

    // PCA-powered contextual exploration algorithm
    async exploreFromTrack(trackId, config = {}) {
        if (!this.initialized) {
            throw new Error('Radial search service not initialized');
        }

        const {
            resolution = 'magnifying_glass',  // 🔬 microscope, 🔍 magnifying_glass, 🔭 binoculars
            discriminator = 'primary_d',      // primary_d, tonal, spectral, rhythmic
            radius = 2.0,                    // fallback for legacy mode (increased from 1.0)
            weights = null,
            ignoreDimensions = [],
            maxDimensions = 6,
            minExplorationPotential = 0.15,
            usePCA = true,                   // Enable PCA-based search by default
            useVAE = false,                  // Enable VAE-based search (experimental)
            searchMode = 'auto'              // 'auto', 'vae', 'pca', 'features'
        } = config;

        const startTime = performance.now();

        try {
            const currentTrack = this.kdTree.getTrack(trackId);
            if (!currentTrack) {
                throw new Error(`Track not found: ${trackId}`);
            }

            // Stage 1: Find musical neighborhood using intelligent search mode selection
            let neighborhood;
            let actualSearchMode = searchMode;
            
            // Handle legacy parameters for backward compatibility
            if (useVAE && currentTrack.vae?.latent) {
                actualSearchMode = 'vae';
            } else if (usePCA && currentTrack.pca && searchMode === 'auto') {
                actualSearchMode = 'pca';
            } else if (searchMode === 'auto' && !usePCA) {
                actualSearchMode = 'features';
            }

            try {
                neighborhood = this.kdTree.smartRadiusSearch(currentTrack, {
                    mode: actualSearchMode,
                    radius: radius,
                    resolution: resolution,
                    discriminator: discriminator,
                    weights: weights,
                    limit: 500
                });
                
                const modeLabels = {
                    'vae': '🧠 VAE',
                    'pca': '🎯 PCA', 
                    'features': '📊 Feature',
                    'auto': '🤖 Auto'
                };
                
                const modeLabel = modeLabels[actualSearchMode] || actualSearchMode;
                console.log(`${modeLabel} search found ${neighborhood.length} tracks`);
                
            } catch (error) {
                // Fallback to PCA if VAE fails
                if (actualSearchMode === 'vae' && currentTrack.pca) {
                    console.warn('⚠️ VAE search failed, falling back to PCA:', error.message);
                    neighborhood = this.kdTree.pcaRadiusSearch(currentTrack, resolution, discriminator, 500);
                    console.log(`🎯 PCA fallback search found ${neighborhood.length} tracks`);
                } else {
                    // Final fallback to legacy feature search
                    console.warn('⚠️ Advanced search failed, falling back to features:', error.message);
                    neighborhood = this.kdTree.radiusSearch(currentTrack, radius, weights, 500);
                    console.log(`📊 Feature fallback search found ${neighborhood.length} tracks`);
                }
            }

            // Stage 2: Analyze dimensional diversity within neighborhood
            const dimensionAnalysis = this.analyzeDimensionalDiversity(
                currentTrack,
                neighborhood.map(r => r.track)
            );

            // Stage 3: Select only contextually relevant dimensions
            const relevantDimensions = this.selectRelevantDimensions(
                dimensionAnalysis,
                { maxDimensions, minExplorationPotential }
            );

            // Stage 4: Generate directional candidates for selected dimensions
            const directionalOptions = {};
            for (const dimInfo of relevantDimensions) {
                const positive = this.kdTree.getDirectionalCandidates(
                    trackId,
                    this.getPositiveDirection(dimInfo.dimension),
                    weights,
                    ignoreDimensions
                );
                const negative = this.kdTree.getDirectionalCandidates(
                    trackId,
                    this.getNegativeDirection(dimInfo.dimension),
                    weights,
                    ignoreDimensions
                );

                directionalOptions[dimInfo.dimension] = {
                    positive: positive,
                    negative: negative,
                    explorationPotential: dimInfo.explorationPotential,
                    contextLabel: dimInfo.contextLabel
                };
            }

            return {
                currentTrack: {
                    identifier: currentTrack.identifier,
                    title: currentTrack.title,
                    artist: currentTrack.artist,
                    features: currentTrack.features,
                    albumCover: currentTrack.albumCover
                },
                neighborhood: {
                    size: neighborhood.length,
                    averageDistance: neighborhood.length > 0
                        ? neighborhood.reduce((sum, r) => sum + r.distance, 0) / neighborhood.length
                        : 0,
                    searchMode: actualSearchMode
                },
                searchCapabilities: {
                    hasVAE: !!currentTrack.vae?.latent,
                    hasPCA: !!currentTrack.pca,
                    usedMode: actualSearchMode
                },
                relevantDimensions: relevantDimensions.length,
                directionalOptions: directionalOptions,
                computationTime: performance.now() - startTime
            };

        } catch (error) {
            console.error('Error in exploreFromTrack:', error);
            throw error;
        }
    }

    analyzeDimensionalDiversity(currentTrack, neighborhoodTracks) {
        const dimensionAnalysis = {};

        this.kdTree.dimensions.forEach(dimension => {
            const values = neighborhoodTracks.map(track => track.features[dimension]);
            const currentValue = currentTrack.features[dimension];

            const variance = this.calculateVariance(values);
            const range = Math.max(...values) - Math.min(...values);
            const currentPosition = this.getPercentilePosition(currentValue, values);

            dimensionAnalysis[dimension] = {
                variance: variance,
                range: range,
                currentPosition: currentPosition,
                explorationPotential: this.calculateExplorationPotential(currentValue, values),
                bidirectionalOptions: this.assessDirectionalOptions(currentValue, values)
            };
        });

        return dimensionAnalysis;
    }

    calculateVariance(values) {
        if (values.length === 0) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    }

    getPercentilePosition(value, values) {
        const sorted = values.slice().sort((a, b) => a - b);
        const index = sorted.indexOf(value);
        return index / sorted.length;
    }

    calculateExplorationPotential(currentValue, values) {
        const variance = this.calculateVariance(values);
        const range = Math.max(...values) - Math.min(...values);
        const positionSpread = this.calculatePositionSpread(currentValue, values);

        return (variance * 0.4) + (range * 0.4) + (positionSpread * 0.2);
    }

    calculatePositionSpread(currentValue, values) {
        const sorted = values.slice().sort((a, b) => a - b);
        const position = sorted.indexOf(currentValue);
        const percentile = position / sorted.length;

        // Higher spread if we're not at the extremes
        return 1.0 - Math.abs(percentile - 0.5) * 2;
    }

    assessDirectionalOptions(currentValue, values) {
        const sorted = values.slice().sort((a, b) => a - b);
        const position = sorted.indexOf(currentValue);
        const percentile = position / sorted.length;

        return {
            positiveDirection: {
                available: percentile < 0.8,
                candidateCount: sorted.filter(v => v > currentValue).length
            },
            negativeDirection: {
                available: percentile > 0.2,
                candidateCount: sorted.filter(v => v < currentValue).length
            }
        };
    }

    selectRelevantDimensions(dimensionAnalysis, criteria) {
        const {
            minExplorationPotential = 0.15,
            minVariance = 0.12,
            maxDimensions = 6,
            minCandidates = 5
        } = criteria;

        const relevantDimensions = Object.entries(dimensionAnalysis)
            .filter(([dimension, analysis]) => {
                return analysis.explorationPotential > minExplorationPotential &&
                       analysis.variance > minVariance &&
                       (analysis.bidirectionalOptions.positiveDirection.candidateCount > minCandidates ||
                        analysis.bidirectionalOptions.negativeDirection.candidateCount > minCandidates);
            })
            .sort((a, b) => b[1].explorationPotential - a[1].explorationPotential)
            .slice(0, maxDimensions);

        return relevantDimensions.map(([dimension, analysis]) => ({
            dimension,
            explorationPotential: analysis.explorationPotential,
            contextLabel: this.generateContextualLabel(dimension, analysis)
        }));
    }

    generateContextualLabel(dimension, analysis) {
        const labelMappings = {
            bpm: 'faster/slower',
            spectral_centroid: analysis.currentPosition > 0.5 ? 'brighter/darker' : 'darker/brighter',
            spectral_energy: analysis.currentPosition > 0.7 ? 'calmer/more energetic' : 'more energetic/calmer',
            tonal_clarity: 'more tonal/more atonal',
            danceability: 'more danceable/less danceable',
            entropy: 'more complex/simpler',
            crest: 'more punchy/smoother',
            onset_rate: 'busier/sparser'
        };

        return labelMappings[dimension] || `${dimension} variation`;
    }

    getPositiveDirection(dimension) {
        const directionMap = {
            // Rhythmic
            bpm: 'faster',
            danceability: 'more_danceable',
            onset_rate: 'busier_onsets',
            beat_punch: 'punchier_beats',

            // Tonal
            tonal_clarity: 'more_tonal',
            tuning_purity: 'purer_tuning',
            fifths_strength: 'stronger_fifths',
            chord_strength: 'stronger_chords',
            chord_change_rate: 'faster_changes',

            // Harmonic Shape
            crest: 'more_punchy',
            entropy: 'more_complex',

            // Spectral
            spectral_centroid: 'brighter',
            spectral_rolloff: 'fuller_spectrum',
            spectral_kurtosis: 'peakier_spectrum',
            spectral_energy: 'more_energetic',
            spectral_flatness: 'noisier',

            // Production
            sub_drive: 'more_bass',
            air_sizzle: 'more_air'
        };
        return directionMap[dimension] || 'faster';
    }

    getNegativeDirection(dimension) {
        const directionMap = {
            // Rhythmic
            bpm: 'slower',
            danceability: 'less_danceable',
            onset_rate: 'sparser_onsets',
            beat_punch: 'smoother_beats',

            // Tonal
            tonal_clarity: 'more_atonal',
            tuning_purity: 'looser_tuning',
            fifths_strength: 'weaker_fifths',
            chord_strength: 'weaker_chords',
            chord_change_rate: 'slower_changes',

            // Harmonic Shape
            crest: 'smoother',
            entropy: 'simpler',

            // Spectral
            spectral_centroid: 'darker',
            spectral_rolloff: 'narrower_spectrum',
            spectral_kurtosis: 'flatter_spectrum',
            spectral_energy: 'calmer',
            spectral_flatness: 'more_tonal_spectrum',

            // Production
            sub_drive: 'less_bass',
            air_sizzle: 'less_air'
        };
        return directionMap[dimension] || 'slower';
    }

    // Simple directional search (bypass full 3-stage algorithm)
    async getDirectionalCandidates(trackId, direction, config = {}) {
        if (!this.initialized) {
            throw new Error('Radial search service not initialized');
        }

        const { weights = null, ignoreDimensions = [], limit = 20 } = config;

        try {
            const result = this.kdTree.getDirectionalCandidates(trackId, direction, weights, ignoreDimensions);
            return {
                candidates: result.candidates.slice(0, limit),
                totalAvailable: result.totalAvailable,
                dimension: result.dimension,
                currentValue: result.currentValue
            };
        } catch (error) {
            console.error('Error in getDirectionalCandidates:', error);
            throw error;
        }
    }

    // Get available PCA directions for UI
    getPCADirections() {
        if (!this.initialized || !this.kdTree) {
            return null;
        }

        return this.kdTree.pcaDirections;
    }

    // Get available resolution settings for UI
    getResolutionSettings() {
        if (!this.initialized || !this.kdTree) {
            return null;
        }

        const settings = {
            microscope: { emoji: '🔬', description: '3% precision search', percentage: '~3%' },
            magnifying_glass: { emoji: '🔍', description: '7% precision search', percentage: '~7%' },
            binoculars: { emoji: '🔭', description: '11% broader search', percentage: '~11%' }
        };

        // Add calibration data if available
        Object.keys(settings).forEach(resolution => {
            if (this.kdTree.calibrationSettings[resolution]) {
                settings[resolution].calibrated = true;
                settings[resolution].discriminators = Object.keys(this.kdTree.calibrationSettings[resolution]);
            }
        });

        return settings;
    }

    // Get available search modes for a specific track
    getAvailableSearchModes(trackId) {
        if (!this.initialized || !this.kdTree) {
            return null;
        }

        const track = this.kdTree.getTrack(trackId);
        if (!track) {
            return null;
        }

        return {
            features: true,  // Always available
            pca: !!track.pca,
            vae: !!track.vae?.latent,
            recommended: this.getRecommendedSearchMode(track)
        };
    }

    // Get recommended search mode for a track
    getRecommendedSearchMode(track) {
        if (track.vae?.latent) {
            return 'vae';
        } else if (track.pca) {
            return 'pca';
        } else {
            return 'features';
        }
    }

    // Enhanced directional search using PCA
    async getPCADirectionalCandidates(trackId, pcaDomain, pcaComponent, direction, config = {}) {
        if (!this.initialized) {
            throw new Error('Radial search service not initialized');
        }

        const {
            resolution = 'magnifying_glass',
            limit = 20
        } = config;

        try {
            const currentTrack = this.kdTree.getTrack(trackId);
            if (!currentTrack || !currentTrack.pca) {
                throw new Error(`Track not found or missing PCA data: ${trackId}`);
            }

            // Get neighborhood using specified PCA discriminator
            const neighborhood = this.kdTree.pcaRadiusSearch(currentTrack, resolution, pcaDomain, 500);

            // Filter by PCA direction and make sure we never include the center track itself
            const candidates = neighborhood.filter(result => {
                if (!result?.track?.identifier) {
                    return false;
                }

                if (result.track.identifier === currentTrack.identifier) {
                    return false;
                }

                return this.isInPCADirection(currentTrack, result.track, pcaDomain, pcaComponent, direction);
            });

            // Sort and limit
            candidates.sort((a, b) => a.distance - b.distance);

            return {
                candidates: candidates.slice(0, limit),
                totalAvailable: candidates.length,
                currentTrack: {
                    identifier: currentTrack.identifier,
                    title: currentTrack.title,
                    artist: currentTrack.artist,
                    pca: currentTrack.pca
                },
                searchParameters: { pcaDomain, pcaComponent, direction, resolution }
            };
        } catch (error) {
            console.error('Error in getPCADirectionalCandidates:', error);
            throw error;
        }
    }

    isInPCADirection(currentTrack, candidateTrack, pcaDomain, pcaComponent, direction) {
        let currentValue, candidateValue;

        if (pcaDomain === 'primary_d') {
            currentValue = currentTrack.pca.primary_d;
            candidateValue = candidateTrack.pca.primary_d;
        } else {
            const componentIndex = parseInt(pcaComponent.replace('pc', '')) - 1;
            currentValue = currentTrack.pca[pcaDomain][componentIndex];
            candidateValue = candidateTrack.pca[pcaDomain][componentIndex];
        }

        return direction === 'positive' ? candidateValue > currentValue : candidateValue < currentValue;
    }

    getStats() {
        if (!this.initialized || !this.kdTree) {
            return { initialized: false };
        }

        const tracksWithVAE = this.kdTree.tracks.filter(t => t.vae?.latent !== null).length;
        const vaeModelVersions = [...new Set(
            this.kdTree.tracks
                .filter(t => t.vae?.model_version)
                .map(t => t.vae.model_version)
        )];

        return {
            initialized: true,
            hasPCA: this.kdTree.tracks.some(t => t.pca),
            hasVAE: tracksWithVAE > 0,
            vaeStats: {
                tracksWithEmbeddings: tracksWithVAE,
                totalTracks: this.kdTree.tracks.length,
                coverage: this.kdTree.tracks.length > 0 ? 
                    (tracksWithVAE / this.kdTree.tracks.length * 100).toFixed(1) + '%' : '0%',
                modelVersions: vaeModelVersions
            },
            resolutions: Object.keys(this.kdTree.calibrationSettings),
            discriminators: this.kdTree.calibrationSettings.magnifying_glass ?
                Object.keys(this.kdTree.calibrationSettings.magnifying_glass) : [],
            ...this.kdTree.getStats()
        };
    }

    close() {
        if (this.kdTree) {
            this.kdTree.close();
        }
    }
}

module.exports = RadialSearchService;
