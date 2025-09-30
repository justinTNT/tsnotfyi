const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class KDTreeNode {
    constructor(point, dimension, left = null, right = null) {
        this.point = point;
        this.dimension = dimension;
        this.left = left;
        this.right = right;
    }
}

class MusicalKDTree {
    constructor(dbPath = path.join(process.env.HOME, 'project/dev/manual.db')) {
        this.dbPath = dbPath;
        this.db = null;
        this.root = null;
        this.tracks = [];
        this.calibrationSettings = {};

        // Core indices from Indices Bible v2 (18 core + 3 algebraic)
        this.dimensions = [
            // Rhythmic
            'bpm', 'danceability', 'onset_rate', 'beat_punch',
            // Tonal
            'tonal_clarity', 'tuning_purity', 'fifths_strength', 'chord_strength', 'chord_change_rate',
            // Harmonic Shape
            'crest', 'entropy',
            // Spectral
            'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis', 'spectral_energy', 'spectral_flatness',
            // Production
            'sub_drive', 'air_sizzle',
            // Algebraic (computed on-the-fly for now)
            'opb', 'pulse_cohesion', 'spectral_slope'
        ];

        // PCA directions with meaningful names based on component analysis
        this.pcaDirections = {
            primary_d: {
                positive: 'more_complex_dynamic',  // entropy, chord_change_rate, spectral_centroid
                negative: 'simpler_controlled',     // crest, spectral_flatness, spectral_kurtosis
                description: 'Musical complexity and dynamics'
            },
            tonal: {
                pc1: {
                    positive: 'complex_textured',   // entropy, chord_change_rate
                    negative: 'smooth_punchy',      // crest
                    description: 'Texture vs punch'
                },
                pc2: {
                    positive: 'harmonic_strength',  // fifths_strength, chord_strength
                    negative: 'percussive_punch',   // crest
                    description: 'Harmony vs percussion'
                },
                pc3: {
                    positive: 'harmonic_change',    // chord_change_rate, tuning_purity
                    negative: 'stable_chords',      // chord_strength
                    description: 'Harmonic movement'
                }
            },
            spectral: {
                pc1: {
                    positive: 'bright_focused',     // spectral_centroid, spectral_rolloff
                    negative: 'dark_spread',        // spectral_flatness
                    description: 'Brightness and focus'
                },
                pc2: {
                    positive: 'energetic',          // spectral_energy
                    negative: 'calm_peaked',        // spectral_kurtosis, spectral_rolloff
                    description: 'Energy distribution'
                },
                pc3: {
                    positive: 'full_spectrum',      // spectral_energy, spectral_rolloff, spectral_centroid
                    negative: 'narrow_spectrum',
                    description: 'Spectral fullness'
                }
            },
            rhythmic: {
                pc1: {
                    positive: 'danceable_active',   // danceability, onset_rate, beat_punch
                    negative: 'subdued_sparse',
                    description: 'Rhythmic activity'
                },
                pc2: {
                    positive: 'fast_tempo',         // bpm dominates
                    negative: 'slow_tempo',
                    description: 'Tempo'
                },
                pc3: {
                    positive: 'punchy_beats',       // beat_punch
                    negative: 'smooth_flow',        // onset_rate, danceability
                    description: 'Beat character'
                }
            }
        };

        // Default weights for similarity calculation (using BPM as primary discriminator D for now)
        this.defaultWeights = {
            bpm: 0.3,              // Primary discriminator until PCA analysis complete
            spectral_centroid: 0.15,
            tonal_clarity: 0.12,
            danceability: 0.1,
            onset_rate: 0.08,
            spectral_energy: 0.08,
            crest: 0.05,
            entropy: 0.05,
            fifths_strength: 0.03,
            chord_strength: 0.04
            // Other dimensions get smaller default weights
        };

        this.epsilon = 1e-12; // For numerical stability in ratios
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(`Database connection failed: ${err.message}`);
                    return;
                }

                console.log('Connected to musical database');
                Promise.all([
                    this.loadTracks(),
                    this.loadCalibrationSettings()
                ]).then(() => {
                    console.log(`Loaded ${this.tracks.length} tracks`);
                    console.log(`Loaded calibration settings for ${Object.keys(this.calibrationSettings).length} discriminators`);
                    this.buildTree();
                    console.log('KD-tree constructed');
                    resolve();
                }).catch(reject);
            });
        });
    }

    async loadTracks() {
        return new Promise((resolve, reject) => {
            // Load all tracks with their audio features and PCA values
            const query = `
                SELECT
                    identifier,
                    bt_title as title,
                    bt_artist as artist,
                    bt_path as path,
                    bt_length as length,
                    ${this.dimensions.join(', ')},
                    primary_d,
                    tonal_pc1, tonal_pc2, tonal_pc3,
                    spectral_pc1, spectral_pc2, spectral_pc3,
                    rhythmic_pc1, rhythmic_pc2, rhythmic_pc3,
                    love,hate,beets_meta
                FROM music_analysis
                WHERE bpm IS NOT NULL and hate IS 0
                AND spectral_centroid IS NOT NULL
                AND primary_d IS NOT NULL
                ORDER BY identifier
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }

                this.tracks = rows.map(row => {

                    let meta = JSON.parse(row.beets_meta);
                    let artPath = (meta.album.artpath?.length > 0) ?  meta.album.artpath : '/images/albumcover.png';

                    const track = {
                        identifier: row.identifier,
                        title: row.title,
                        artist: row.artist,
                        path: row.path,
                        length: row.length,
                        features: {},
                        albumCover: artPath,
                        love: row.love,
                        pca: {
                            primary_d: row.primary_d,
                            tonal: [row.tonal_pc1, row.tonal_pc2, row.tonal_pc3],
                            spectral: [row.spectral_pc1, row.spectral_pc2, row.spectral_pc3],
                            rhythmic: [row.rhythmic_pc1, row.rhythmic_pc2, row.rhythmic_pc3]
                        }
                    };

                    // Extract feature vector
                    this.dimensions.forEach(dim => {
                        track.features[dim] = row[dim] || 0;
                    });

                    return track;
                });

                resolve();
            });
        });
    }

    async loadCalibrationSettings() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT resolution_level as resolution, discriminator, base_x, inner_radius, outer_radius, achieved_percentage, scaling_factor
                FROM pca_calibration_settings
                ORDER BY resolution_level, discriminator
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    console.warn('Could not load calibration settings:', err);
                    this.calibrationSettings = {}; // Use defaults
                    resolve();
                    return;
                }

                this.calibrationSettings = {};
                rows.forEach(row => {
                    if (!this.calibrationSettings[row.resolution]) {
                        this.calibrationSettings[row.resolution] = {};
                    }
                    this.calibrationSettings[row.resolution][row.discriminator] = {
                        base_x: row.base_x,
                        inner_radius: row.inner_radius,
                        outer_radius: row.outer_radius,
                        achieved_percentage: row.achieved_percentage,
                        scaling_factor: row.scaling_factor || 1.0
                    };
                });

                resolve();
            });
        });
    }

    buildTree() {
        if (this.tracks.length === 0) {
            console.warn('No tracks loaded for KD-tree construction');
            return;
        }

        // Create points array for tree construction
        const points = this.tracks.map(track => ({
            ...track,
            vector: this.dimensions.map(dim => track.features[dim])
        }));

        this.root = this.buildKDTree(points, 0);
    }

    buildKDTree(points, depth) {
        if (points.length === 0) return null;
        if (points.length === 1) return new KDTreeNode(points[0], depth % this.dimensions.length);

        const dimension = depth % this.dimensions.length;

        // Sort points by current dimension
        points.sort((a, b) => a.vector[dimension] - b.vector[dimension]);

        const median = Math.floor(points.length / 2);
        const node = new KDTreeNode(points[median], dimension);

        // Recursively build left and right subtrees
        node.left = this.buildKDTree(points.slice(0, median), depth + 1);
        node.right = this.buildKDTree(points.slice(median + 1), depth + 1);

        return node;
    }

    // Calculate PCA-based distance using primary discriminator and domain PCAs
    calculatePCADistance(trackA, trackB, mode = 'primary_d') {
        if (!trackA.pca || !trackB.pca) {
            throw new Error('Tracks missing PCA values');
        }

        switch (mode) {
            case 'primary_d':
                return Math.abs(trackA.pca.primary_d - trackB.pca.primary_d);

            case 'tonal':
                return this.calculateEuclideanDistance(trackA.pca.tonal, trackB.pca.tonal);

            case 'spectral':
                return this.calculateEuclideanDistance(trackA.pca.spectral, trackB.pca.spectral);

            case 'rhythmic':
                return this.calculateEuclideanDistance(trackA.pca.rhythmic, trackB.pca.rhythmic);

            case 'full_pca':
                // Combined 10D PCA distance
                const primary_d_diff = Math.abs(trackA.pca.primary_d - trackB.pca.primary_d);
                const tonal_dist = this.calculateEuclideanDistance(trackA.pca.tonal, trackB.pca.tonal);
                const spectral_dist = this.calculateEuclideanDistance(trackA.pca.spectral, trackB.pca.spectral);
                const rhythmic_dist = this.calculateEuclideanDistance(trackA.pca.rhythmic, trackB.pca.rhythmic);

                return Math.sqrt(primary_d_diff * primary_d_diff +
                                tonal_dist * tonal_dist +
                                spectral_dist * spectral_dist +
                                rhythmic_dist * rhythmic_dist);

            default:
                return this.calculateDistance(trackA, trackB); // Fallback to original
        }
    }

    calculateEuclideanDistance(vectorA, vectorB) {
        if (vectorA.length !== vectorB.length) {
            throw new Error('Vector dimension mismatch');
        }

        let sumSquaredDiffs = 0;
        for (let i = 0; i < vectorA.length; i++) {
            const diff = vectorA[i] - vectorB[i];
            sumSquaredDiffs += diff * diff;
        }

        return Math.sqrt(sumSquaredDiffs);
    }

    // Calculate weighted distance between two tracks (legacy method)
    calculateDistance(trackA, trackB, weights = null, ignoreDimensions = []) {
        const w = weights || this.defaultWeights;
        let distance = 0;

        this.dimensions.forEach(dim => {
            if (ignoreDimensions.includes(dim)) return;

            const diff = Math.abs(trackA.features[dim] - trackB.features[dim]);
            const weight = w[dim] || 0.01; // Small default weight for unspecified dimensions
            distance += diff * weight;
        });

        return distance;
    }

    // Find musical neighborhood using PCA-based radial search with calibrated settings
    pcaRadiusSearch(centerTrack, resolution = 'magnifying_glass', discriminator = 'primary_d', limit = 500) {
        if (!this.root) {
            throw new Error('KD-tree not initialized');
        }

        const settings = this.calibrationSettings[resolution]?.[discriminator];
        if (!settings) {
            console.warn(`No calibration settings for ${resolution}/${discriminator}, falling back to defaults`);
            // Increased fallback radius from 1.0 to 2.0 to ensure bidirectional pairs
            return this.radiusSearch(centerTrack, 2.0, null, limit);
        }

        // Use the stored scaling factor to adjust radii for unnormalized data
        let adjustedSettings = settings;

        if (settings.scaling_factor && settings.scaling_factor !== 1.0) {
            console.log(`🔧 Applying stored scaling factor ${settings.scaling_factor.toFixed(1)}x for ${resolution}/${discriminator}`);

            adjustedSettings = {
                ...settings,
                inner_radius: settings.inner_radius * settings.scaling_factor,
                outer_radius: settings.outer_radius * settings.scaling_factor
            };
        }

        const results = [];
        this.pcaRadiusSearchHelper(this.root, centerTrack, adjustedSettings, discriminator, results);

        // Sort by distance and limit results
        results.sort((a, b) => a.distance - b.distance);
        return results.slice(0, limit);
    }

    pcaRadiusSearchHelper(node, centerTrack, settings, discriminator, results) {
        if (!node) return;

        const distance = this.calculatePCADistance(centerTrack, node.point, discriminator);

        // Use inner/outer radius for annular search
        if (distance >= settings.inner_radius && distance <= settings.outer_radius &&
            node.point.identifier !== centerTrack.identifier) {
            results.push({
                track: node.point,
                distance: distance
            });
        }

        // Continue tree traversal based on PCA distance bounds
        const canContainResults = distance <= settings.outer_radius + this.getMaxNodeRadius(node, discriminator);

        if (canContainResults) {
            this.pcaRadiusSearchHelper(node.left, centerTrack, settings, discriminator, results);
            this.pcaRadiusSearchHelper(node.right, centerTrack, settings, discriminator, results);
        }
    }

    getMaxNodeRadius(node, discriminator) {
        // Approximate maximum radius within this subtree for pruning
        return 2.0; // Conservative estimate for now
    }

    // Find musical neighborhood using radial search (legacy method)
    radiusSearch(centerTrack, radius = 0.3, weights = null, limit = 500) {
        if (!this.root) {
            throw new Error('KD-tree not initialized');
        }

        const results = [];
        this.radiusSearchHelper(this.root, centerTrack, radius, weights, results);

        // Sort by distance and limit results
        results.sort((a, b) => a.distance - b.distance);
        return results.slice(0, limit);
    }

    radiusSearchHelper(node, centerTrack, radius, weights, results) {
        if (!node) return;

        const distance = this.calculateDistance(centerTrack, node.point, weights);
        if (distance <= radius && node.point.identifier !== centerTrack.identifier) {
            results.push({
                track: node.point,
                distance: distance
            });
        }

        const dimValue = centerTrack.features[this.dimensions[node.dimension]];
        const nodeValue = node.point.features[this.dimensions[node.dimension]];
        const dimDiff = Math.abs(dimValue - nodeValue);

        // Recursively search relevant subtrees
        if (dimValue <= nodeValue) {
            this.radiusSearchHelper(node.left, centerTrack, radius, weights, results);
            if (dimDiff <= radius) {
                this.radiusSearchHelper(node.right, centerTrack, radius, weights, results);
            }
        } else {
            this.radiusSearchHelper(node.right, centerTrack, radius, weights, results);
            if (dimDiff <= radius) {
                this.radiusSearchHelper(node.left, centerTrack, radius, weights, results);
            }
        }
    }

    // Get directional candidates (Stage 1 of radial search algorithm)
    getDirectionalCandidates(currentTrackId, direction, weights = null, ignoreDimensions = []) {
        const currentTrack = this.tracks.find(t => t.identifier === currentTrackId);
        if (!currentTrack) {
            throw new Error(`Track not found: ${currentTrackId}`);
        }

        // Use PCA-calibrated radius if available, otherwise fall back to scaled radius
        let searchRadius = 2.0; // Default fallback

        if (currentTrack.pca && this.calibrationSettings.magnifying_glass?.primary_d) {
            const pcaSettings = this.calibrationSettings.magnifying_glass.primary_d;
            // Use outer_radius from PCA calibration, scaled for raw feature space
            // Apply more generous projection factor to ensure we find candidates
            const dimensionProjectionFactor = 6.0; // Tripled from 2.0 to ensure we get at least some tracks
            searchRadius = pcaSettings.outer_radius * (pcaSettings.scaling_factor || 1.0) * dimensionProjectionFactor;

            console.log(`🔧 Using PCA-calibrated radius: ${searchRadius.toFixed(2)} (from PCA outer_radius: ${pcaSettings.outer_radius}, scaling: ${pcaSettings.scaling_factor || 1.0}, projection: ${dimensionProjectionFactor.toFixed(1)})`);
        }

        // First get musical neighborhood using scaled distance
        const neighborhood = this.radiusSearch(currentTrack, searchRadius, weights, 500);

        // Filter by direction
        const directionDim = this.getDirectionDimension(direction);
        const currentValue = currentTrack.features[directionDim];

        const directionalCandidates = neighborhood.filter(result => {
            const candidateValue = result.track.features[directionDim];
            return this.isInDirection(currentValue, candidateValue, direction);
        });

        // Calculate D-minus-i similarity (all dimensions except navigation dimension)
        const activeDimensions = this.dimensions.filter(dim =>
            !ignoreDimensions.includes(dim) && dim !== directionDim
        );

        const candidates = directionalCandidates.map(result => ({
            track: result.track,
            similarity: this.calculateDimensionSimilarity(currentTrack, result.track, activeDimensions, weights),
            direction_value: result.track.features[directionDim],
            direction_delta: result.track.features[directionDim] - currentValue
        }));

        // Sort by similarity in other dimensions
        candidates.sort((a, b) => a.similarity - b.similarity);

        return {
            candidates: candidates.slice(0, 20),
            totalAvailable: directionalCandidates.length,
            dimension: directionDim,
            currentValue: currentValue
        };
    }

    calculateDimensionSimilarity(trackA, trackB, dimensions, weights = null) {
        const w = weights || this.defaultWeights;
        let similarity = 0;

        dimensions.forEach(dim => {
            const diff = Math.abs(trackA.features[dim] - trackB.features[dim]);
            const weight = w[dim] || 0.01;
            similarity += diff * weight;
        });

        return similarity;
    }

    getDirectionDimension(direction) {
        const directionMap = {
            // Rhythmic
            'faster': 'bpm',
            'slower': 'bpm',
            'more_danceable': 'danceability',
            'less_danceable': 'danceability',
            'busier_onsets': 'onset_rate',
            'sparser_onsets': 'onset_rate',
            'punchier_beats': 'beat_punch',
            'smoother_beats': 'beat_punch',

            // Tonal
            'more_tonal': 'tonal_clarity',
            'more_atonal': 'tonal_clarity',
            'purer_tuning': 'tuning_purity',
            'looser_tuning': 'tuning_purity',
            'stronger_fifths': 'fifths_strength',
            'weaker_fifths': 'fifths_strength',
            'stronger_chords': 'chord_strength',
            'weaker_chords': 'chord_strength',
            'faster_changes': 'chord_change_rate',
            'slower_changes': 'chord_change_rate',

            // Harmonic Shape
            'more_punchy': 'crest',
            'smoother': 'crest',
            'more_complex': 'entropy',
            'simpler': 'entropy',

            // Spectral
            'brighter': 'spectral_centroid',
            'darker': 'spectral_centroid',
            'fuller_spectrum': 'spectral_rolloff',
            'narrower_spectrum': 'spectral_rolloff',
            'peakier_spectrum': 'spectral_kurtosis',
            'flatter_spectrum': 'spectral_kurtosis',
            'more_energetic': 'spectral_energy',
            'calmer': 'spectral_energy',
            'noisier': 'spectral_flatness',
            'more_tonal_spectrum': 'spectral_flatness',

            // Production
            'more_bass': 'sub_drive',
            'less_bass': 'sub_drive',
            'more_air': 'air_sizzle',
            'less_air': 'air_sizzle',

            // Legacy aliases
            'denser_onsets': 'onset_rate',
            'impurer_tuning': 'tuning_purity',
            'less_punchy': 'crest',
            'more_air_sizzle': 'air_sizzle',
            'less_air_sizzle': 'air_sizzle'
        };

        return directionMap[direction] || 'bpm';
    }

    isInDirection(currentValue, candidateValue, direction) {
        const positiveDirections = [
            'faster', 'brighter', 'more_energetic', 'more_danceable', 'more_tonal', 'more_complex',
            'more_punchy', 'denser_onsets', 'purer_tuning', 'stronger_chords', 'more_air_sizzle'
        ];
        const isPositive = positiveDirections.includes(direction);

        return isPositive ? candidateValue > currentValue : candidateValue < currentValue;
    }

    // Get track by identifier
    getTrack(identifier) {
        return this.tracks.find(t => t.identifier === identifier);
    }

    // Get stats about the dataset
    getStats() {
        if (this.tracks.length === 0) return null;

        const stats = {
            total_tracks: this.tracks.length,
            dimensions: this.dimensions.length,
            dimension_stats: {}
        };

        this.dimensions.forEach(dim => {
            const values = this.tracks.map(t => t.features[dim]).filter(v => v != null);
            if (values.length === 0) return;

            values.sort((a, b) => a - b);
            stats.dimension_stats[dim] = {
                min: values[0],
                max: values[values.length - 1],
                median: values[Math.floor(values.length / 2)],
                mean: values.reduce((a, b) => a + b, 0) / values.length
            };
        });

        return stats;
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = MusicalKDTree;
