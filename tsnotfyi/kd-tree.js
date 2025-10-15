const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Module-level pool (shared across instances)
let globalPool = null;

function openDatabase(connectionString) {
    return new Promise((resolve, reject) => {
        try {
            if (globalPool) {
                resolve(globalPool);
                return;
            }

            globalPool = new Pool({
                connectionString: connectionString,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });

            globalPool.on('error', (err) => {
                console.error('Unexpected database error:', err);
            });

            resolve(globalPool);
        } catch (err) {
            reject(new Error(`Database connection failed: ${err.message}`));
        }
    });
}

async function runAll(pool, query, params = []) {
    const result = await pool.query(query, params);
    return result.rows;
}

class KDTreeNode {
    constructor(point, dimension, left = null, right = null) {
        this.point = point;
        this.dimension = dimension;
        this.left = left;
        this.right = right;
    }
}

class MusicalKDTree {
    constructor(connectionString = null) {
        this.connectionString = connectionString ||
                               process.env.DATABASE_URL ||
                               config.database.postgresql.connectionString;
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
                    description: 'Spectral texture balance'
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
        this.pcaWeights = null; // Will store PCA transformation weights
    }

    async initialize() {
        if (this.db) {
            return;
        }

        this.db = await openDatabase(this.connectionString);
        console.log('Connected to PostgreSQL musical database');

        await Promise.all([
            this.loadTracks(),
            this.loadCalibrationSettings(),
            this.loadPCATransformations()
        ]);

        console.log(`Loaded ${this.tracks.length} tracks`);
        console.log(`Loaded calibration settings for ${Object.keys(this.calibrationSettings).length} resolutions`);
        console.log('✓ PCA transformation weights loaded');
        
        // Log VAE embedding availability
        const tracksWithVAE = this.tracks.filter(t => t.vae?.latent !== null).length;
        const vaePercentage = this.tracks.length > 0 ? (tracksWithVAE / this.tracks.length * 100).toFixed(1) : 0;
        console.log(`✓ VAE embeddings available for ${tracksWithVAE}/${this.tracks.length} tracks (${vaePercentage}%)`);
        
        if (tracksWithVAE > 0) {
            const sampleVAE = this.tracks.find(t => t.vae?.latent !== null);
            if (sampleVAE) {
                console.log(`✓ VAE model version: ${sampleVAE.vae.model_version || 'unknown'}`);
            }
        }
        
        // Validate PCA recalculation
        if (this.tracks.length > 0 && this.pcaWeights) {
            const sample = this.tracks[0];
            const recalc = this.recalculatePCA(sample.features, 'primary_d');
            const stored = sample.pca.primary_d;
            const error = Math.abs(recalc - stored);

            if (error > 0.001) {
                console.warn(`⚠️ PCA validation error: ${error.toFixed(6)} (threshold: 0.001)`);
                console.warn(`   Sample track: ${sample.identifier}`);
                console.warn(`   Recalculated: ${recalc.toFixed(6)}, Stored: ${stored.toFixed(6)}`);
            } else {
                console.log(`✓ PCA validation passed: error = ${error.toFixed(6)}`);
            }
        }
        
        this.buildTree();
        console.log('KD-tree constructed');
    }

    async loadTracks() {
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
                vae_latent_0, vae_latent_1, vae_latent_2, vae_latent_3,
                vae_latent_4, vae_latent_5, vae_latent_6, vae_latent_7,
                vae_model_version, vae_computed_at,
                love,hate,beets_meta
            FROM music_analysis
            WHERE bpm IS NOT NULL and hate IS 0
            AND spectral_centroid IS NOT NULL
            AND primary_d IS NOT NULL
            ORDER BY identifier
        `;

        const rows = await runAll(this.db, query);

        this.tracks = rows.map(row => {
            let meta = null;
            try {
                meta = row.beets_meta ? JSON.parse(row.beets_meta) : null;
            } catch (err) {
                console.warn('⚠️ Failed to parse beets metadata for', row.identifier, err?.message || err);
                meta = null;
            }

            const artPath = meta?.album?.artpath?.length > 0 ? meta.album.artpath : '/images/albumcover.png';

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
                },
                vae: {
                    latent: [
                        row.vae_latent_0, row.vae_latent_1, row.vae_latent_2, row.vae_latent_3,
                        row.vae_latent_4, row.vae_latent_5, row.vae_latent_6, row.vae_latent_7
                    ].every(val => val !== null && val !== undefined) ? [
                        row.vae_latent_0, row.vae_latent_1, row.vae_latent_2, row.vae_latent_3,
                        row.vae_latent_4, row.vae_latent_5, row.vae_latent_6, row.vae_latent_7
                    ] : null,
                    model_version: row.vae_model_version,
                    computed_at: row.vae_computed_at
                },
                beetsMeta: meta
            };

            this.dimensions.forEach(dim => {
                track.features[dim] = row[dim] || 0;
            });

            return track;
        });
    }

    async loadCalibrationSettings() {
        const query = `
            SELECT resolution_level as resolution, discriminator, base_x, inner_radius, outer_radius, achieved_percentage, scaling_factor
            FROM pca_calibration_settings
            ORDER BY resolution_level, discriminator
        `;

        try {
            const rows = await runAll(this.db, query);

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
        } catch (err) {
            console.warn('Could not load calibration settings:', err);
            this.calibrationSettings = {}; // Use defaults
        }
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

    // Calculate VAE-based distance using latent embeddings
    calculateVAEDistance(trackA, trackB) {
        if (!trackA.vae?.latent || !trackB.vae?.latent) {
            throw new Error('Tracks missing VAE embeddings');
        }

        // Euclidean distance in 8D latent space
        return this.calculateEuclideanDistance(trackA.vae.latent, trackB.vae.latent);
    }

    // Calculate distance using specified method (PCA, VAE, or legacy features)
    calculateSmartDistance(trackA, trackB, mode = 'auto', modeParams = {}) {
        switch (mode) {
            case 'vae':
                if (trackA.vae?.latent && trackB.vae?.latent) {
                    return this.calculateVAEDistance(trackA, trackB);
                } else {
                    throw new Error('VAE embeddings not available for requested tracks');
                }

            case 'pca':
                const pcaMode = modeParams.pcaMode || 'primary_d';
                return this.calculatePCADistance(trackA, trackB, pcaMode);

            case 'features':
                return this.calculateDistance(trackA, trackB, modeParams.weights, modeParams.ignoreDimensions);

            case 'auto':
                // Prefer VAE if available, fallback to PCA, then features
                if (trackA.vae?.latent && trackB.vae?.latent) {
                    return this.calculateVAEDistance(trackA, trackB);
                } else if (trackA.pca && trackB.pca) {
                    return this.calculatePCADistance(trackA, trackB, 'primary_d');
                } else {
                    return this.calculateDistance(trackA, trackB, modeParams.weights, modeParams.ignoreDimensions);
                }

            default:
                throw new Error(`Unknown distance mode: ${mode}`);
        }
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

        if (node.point.identifier === centerTrack.identifier) {
            if (distance > this.epsilon) {
                console.warn(`⚠️ PCA radius search computed non-zero distance (${distance}) for center track ${centerTrack.identifier}`);
            }
        } else {
            // Use inner/outer radius for annular search
            if (distance >= settings.inner_radius && distance <= settings.outer_radius) {
                results.push({
                    track: node.point,
                    distance: distance
                });
            }
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

    // Find musical neighborhood using VAE-based radial search
    vaeRadiusSearch(centerTrack, radius = 0.3, limit = 500) {
        if (!this.root) {
            throw new Error('KD-tree not initialized');
        }

        if (!centerTrack.vae?.latent) {
            throw new Error('Center track missing VAE embeddings');
        }

        const results = [];
        this.vaeRadiusSearchHelper(this.root, centerTrack, radius, results);

        // Sort by VAE distance and limit results
        results.sort((a, b) => a.distance - b.distance);
        return results.slice(0, limit);
    }

    vaeRadiusSearchHelper(node, centerTrack, radius, results) {
        if (!node) return;

        // Skip tracks without VAE embeddings
        if (!node.point.vae?.latent) {
            this.vaeRadiusSearchHelper(node.left, centerTrack, radius, results);
            this.vaeRadiusSearchHelper(node.right, centerTrack, radius, results);
            return;
        }

        const distance = this.calculateVAEDistance(centerTrack, node.point);
        if (distance <= radius && node.point.identifier !== centerTrack.identifier) {
            results.push({
                track: node.point,
                distance: distance
            });
        }

        // For VAE search, we still need to traverse the feature-based KD-tree structure
        // but we're looking for VAE-similar tracks within the tree
        const dimValue = centerTrack.features[this.dimensions[node.dimension]];
        const nodeValue = node.point.features[this.dimensions[node.dimension]];
        const dimDiff = Math.abs(dimValue - nodeValue);

        // Use a more generous traversal for VAE search since the tree is organized by features
        // but we're searching by VAE distance (which may not correlate with feature similarity)
        const traversalThreshold = radius * 10; // Generous threshold for VAE search

        if (dimValue <= nodeValue) {
            this.vaeRadiusSearchHelper(node.left, centerTrack, radius, results);
            if (dimDiff <= traversalThreshold) {
                this.vaeRadiusSearchHelper(node.right, centerTrack, radius, results);
            }
        } else {
            this.vaeRadiusSearchHelper(node.right, centerTrack, radius, results);
            if (dimDiff <= traversalThreshold) {
                this.vaeRadiusSearchHelper(node.left, centerTrack, radius, results);
            }
        }
    }

    // Smart search method that chooses best available approach
    smartRadiusSearch(centerTrack, config = {}) {
        const {
            mode = 'auto',           // 'auto', 'vae', 'pca', 'features'
            radius = 0.3,           // Search radius
            resolution = 'magnifying_glass',  // For PCA mode
            discriminator = 'primary_d',      // For PCA mode
            weights = null,         // For feature mode
            limit = 500
        } = config;

        switch (mode) {
            case 'vae':
                if (!centerTrack.vae?.latent) {
                    throw new Error('VAE embeddings not available for center track');
                }
                return this.vaeRadiusSearch(centerTrack, radius, limit);

            case 'pca':
                if (!centerTrack.pca) {
                    throw new Error('PCA data not available for center track');
                }
                return this.pcaRadiusSearch(centerTrack, resolution, discriminator, limit);

            case 'features':
                return this.radiusSearch(centerTrack, radius, weights, limit);

            case 'auto':
                // Prefer VAE, fallback to PCA, then features
                if (centerTrack.vae?.latent) {
                    console.log('🧠 Using VAE-based search');
                    return this.vaeRadiusSearch(centerTrack, radius, limit);
                } else if (centerTrack.pca) {
                    console.log('📊 Using PCA-based search');
                    return this.pcaRadiusSearch(centerTrack, resolution, discriminator, limit);
                } else {
                    console.log('🔢 Using feature-based search');
                    return this.radiusSearch(centerTrack, radius, weights, limit);
                }

            default:
                throw new Error(`Unknown search mode: ${mode}`);
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

        const pcaSettings = this.calibrationSettings.magnifying_glass?.primary_d;
        const innerRadius = pcaSettings?.inner_radius || 0;

        const directionalCandidates = [];
        const ratioSamples = [];
        const deltaSamples = [];

        neighborhood.forEach(result => {
            const candidateValue = result.track.features[directionDim];
            if (candidateValue === undefined) {
                return;
            }

            const delta = Math.abs(candidateValue - currentValue);
            if (delta === 0) {
                return;
            }

            const inDirection = this.isInDirection(currentValue, candidateValue, direction);
            if (!inDirection) {
                return;
            }

            // Locality filter: Reject if other dimensions change too much in PCA space
            const otherDimensions = this.dimensions.filter(d =>
                d !== directionDim && !ignoreDimensions.includes(d)
            );

            let violatesLocality = false;
            for (const dim of otherDimensions) {
                // Create counterfactual: current track but with ONLY this dimension changed
                const counterfactual = this.createCounterfactualTrack(currentTrack, {
                    [dim]: result.track.features[dim]
                });

                if (!counterfactual) {
                    // If we can't create counterfactual, fall back to conservative rejection
                    violatesLocality = true;
                    break;
                }

                // Measure PCA distance caused by changing just this dimension
                const isolatedDistance = this.calculatePCADistance(
                    currentTrack,
                    counterfactual,
                    'primary_d'
                );

                // Reject if isolated change exceeds inner radius
                if (isolatedDistance > innerRadius) {
                    violatesLocality = true;
                    break;
                }
            }

            if (violatesLocality) {
                return; // Skip this candidate
            }

            let primaryDistance = null;
            if (innerRadius > 0 && result.track.pca && currentTrack.pca) {
                primaryDistance = this.calculatePCADistance(currentTrack, result.track, 'primary_d');
                if (primaryDistance > 0) {
                    ratioSamples.push(delta / primaryDistance);
                }
            }

            deltaSamples.push(delta);
            directionalCandidates.push({
                track: result.track,
                similarity: result.distance,
                direction_value: candidateValue,
                direction_delta: candidateValue - currentValue,
                featureDelta: delta,
                primaryDistance
            });
        });

        // Log locality filter rejection rate
        const rejectedCount = neighborhood.length - directionalCandidates.length;
        const rejectionRate = (rejectedCount / neighborhood.length) * 100;

        if (rejectionRate > 20) {
            console.warn(`⚠️ High locality rejection rate: ${rejectionRate.toFixed(1)}% (${rejectedCount}/${neighborhood.length})`);
        } else {
            console.log(`✓ Locality filter: ${rejectionRate.toFixed(1)}% rejected (${rejectedCount}/${neighborhood.length})`);
        }

        let minimumDelta = 0;
        if (innerRadius > 0) {
            const meaningfulRatios = ratioSamples.filter(value => Number.isFinite(value) && value > 0);
            if (meaningfulRatios.length > 0) {
                meaningfulRatios.sort((a, b) => a - b);
                const medianRatio = meaningfulRatios[Math.floor(meaningfulRatios.length / 2)];
                minimumDelta = medianRatio * innerRadius;
            }
        }

        if (minimumDelta === 0 && deltaSamples.length > 0) {
            const sorted = deltaSamples.slice().sort((a, b) => a - b);
            const percentileIndex = Math.floor(sorted.length * 0.25);
            minimumDelta = sorted[Math.min(percentileIndex, sorted.length - 1)] || sorted[sorted.length - 1];
        }

        const filteredCandidates = directionalCandidates.filter(candidate => {
            const passesDelta = candidate.featureDelta >= minimumDelta * 0.999;
            const passesPrimary = innerRadius > 0 && candidate.primaryDistance !== null
                ? candidate.primaryDistance >= innerRadius * 0.95
                : true;
            return passesDelta && passesPrimary;
        });

        const chosenCandidates = filteredCandidates.length > 0 ? filteredCandidates : directionalCandidates;

        const excluded = directionalCandidates.length - chosenCandidates.length;
        if (minimumDelta > 0) {
            console.log(`🎯 Directional filter: ${directionDim} minimum delta ≈ ${minimumDelta.toFixed(3)} (excluded ${excluded} tracks too close or inside inner radius)`);
        }

        // Calculate D-minus-i similarity (all dimensions except navigation dimension)
        const activeDimensions = this.dimensions.filter(dim =>
            !ignoreDimensions.includes(dim) && dim !== directionDim
        );

        const candidates = chosenCandidates.map(result => ({
            track: result.track,
            similarity: this.calculateDimensionSimilarity(currentTrack, result.track, activeDimensions, weights),
            direction_value: result.direction_value,
            direction_delta: result.direction_delta
        }));

        // Sort by similarity in other dimensions
        candidates.sort((a, b) => a.similarity - b.similarity);

        return {
            candidates: candidates.slice(0, 20),
            totalAvailable: directionalCandidates.length,
            dimension: directionDim,
            currentValue: currentValue,
            minimumDelta: minimumDelta
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

    cloneFeatureSet(features) {
        if (!features || typeof features !== 'object') return {};
        const clone = {};
        for (const [key, value] of Object.entries(features)) {
            clone[key] = value;
        }
        return clone;
    }

    clonePcaSet(pca) {
        if (!pca || typeof pca !== 'object') return {};
        const clone = {};
        if (pca.primary_d !== undefined) {
            clone.primary_d = pca.primary_d;
        }
        ['tonal', 'spectral', 'rhythmic'].forEach(domain => {
            if (Array.isArray(pca[domain])) {
                clone[domain] = pca[domain].slice();
            } else if (pca[domain] !== undefined) {
                clone[domain] = pca[domain];
            }
        });
        return clone;
    }

    async loadPCATransformations() {
        try {
            const query = `
                SELECT component_name, feature_name, weight
                FROM pca_weights
                ORDER BY component_name, feature_name
            `;
            const rows = await runAll(this.db, query);
            
            this.pcaWeights = {};
            rows.forEach(row => {
                if (!this.pcaWeights[row.component_name]) {
                    this.pcaWeights[row.component_name] = {};
                }
                this.pcaWeights[row.component_name][row.feature_name] = row.weight;
            });
        } catch (err) {
            console.warn('Could not load PCA transformation weights:', err);
            this.pcaWeights = null;
        }
    }

    recalculatePCA(features, component) {
        if (!this.pcaWeights || !this.pcaWeights[component]) {
            console.error(`❌ Cannot recalculate PCA: missing weights for ${component}`);
            return null;
        }

        let result = 0;
        for (const [feature, weight] of Object.entries(this.pcaWeights[component])) {
            if (features[feature] !== undefined) {
                result += features[feature] * weight;
            }
        }
        return result;
    }

    recalculateAllPCA(features) {
        if (!this.pcaWeights) {
            console.error('❌ Cannot recalculate PCA: missing transformation weights');
            return null;
        }

        const pca = {};
        
        // Recalculate primary_d
        if (this.pcaWeights.primary_d) {
            pca.primary_d = this.recalculatePCA(features, 'primary_d');
        }

        // Recalculate domain components
        ['tonal', 'spectral', 'rhythmic'].forEach(domain => {
            const components = [];
            for (let i = 1; i <= 3; i++) {
                const componentName = `${domain}_pc${i}`;
                if (this.pcaWeights[componentName]) {
                    components.push(this.recalculatePCA(features, componentName));
                }
            }
            if (components.length > 0) {
                pca[domain] = components;
            }
        });

        return pca;
    }

    createCounterfactualTrack(baseTrack, featureModifications) {
        if (!baseTrack?.features || !this.pcaWeights) {
            console.error('❌ Cannot create counterfactual: missing base track or PCA weights');
            return null;
        }

        // 1. Clone base track structure
        const counterfactual = {
            identifier: baseTrack.identifier,
            title: baseTrack.title,
            artist: baseTrack.artist,
            path: baseTrack.path,
            length: baseTrack.length,
            albumCover: baseTrack.albumCover,
            love: baseTrack.love,
            beetsMeta: baseTrack.beetsMeta,
            features: this.cloneFeatureSet(baseTrack.features),
            pca: {} // Will be recalculated
        };

        // 2. Apply feature modifications
        for (const [feature, newValue] of Object.entries(featureModifications)) {
            if (this.dimensions.includes(feature)) {
                counterfactual.features[feature] = newValue;
            } else {
                console.warn(`⚠️ Ignoring unknown feature: ${feature}`);
            }
        }

        // 3. Recalculate all PCA values
        counterfactual.pca = this.recalculateAllPCA(counterfactual.features);

        // Optional validation for no-modification case
        if (Object.keys(featureModifications).length === 0) {
            const error = Math.abs(counterfactual.pca.primary_d - baseTrack.pca.primary_d);
            if (error > 1e-6) {
                console.warn(`⚠️ Counterfactual validation failed: ${error}`);
            }
        }

        return counterfactual;
    }

    calculateFeatureContributionFractions(currentTrack, candidateTrack, dimensions, weights = null, contextLabel = '', referenceDimension = null) {
        if (!currentTrack?.features || !candidateTrack?.features) {
            return { total: 0, referenceDistance: 0, slices: [] };
        }

        const activeDimensions = Array.isArray(dimensions) && dimensions.length > 0
            ? dimensions
            : this.dimensions;

        const appliedWeights = weights || this.defaultWeights;
        const rawTotalDistance = this.calculateDimensionSimilarity(currentTrack, candidateTrack, activeDimensions, appliedWeights);
        const totalDistance = Number.isFinite(rawTotalDistance) ? rawTotalDistance : 0;
        const safeTotal = Math.abs(totalDistance);

        const slices = [];
        const labelPrefix = contextLabel ? `[${contextLabel}]` : '';

        let referenceDistance = null;
        if (referenceDimension) {
            const candidateValue = candidateTrack.features?.[referenceDimension];
            const currentValue = currentTrack.features?.[referenceDimension];
            if (candidateValue !== undefined && currentValue !== undefined) {
                const hybrid = this.createCounterfactualTrack(currentTrack, {
                    [referenceDimension]: candidateValue
                });

                referenceDistance = this.calculateDimensionSimilarity(currentTrack, hybrid, [referenceDimension], appliedWeights);
                const fraction = (safeTotal > this.epsilon && referenceDistance > 0)
                    ? Math.min(1, referenceDistance / safeTotal)
                    : 0;
                const delta = candidateValue - currentValue;
                const relative = referenceDistance > this.epsilon ? 1 : null;

                console.log(`📐 Feature contribution ${labelPrefix}.${referenceDimension}: value=${candidateValue}, delta=${delta}, fraction=${fraction.toFixed(4)}, relative=${relative !== null ? relative.toFixed(4) : 'n/a'}`);

                slices.push({
                    key: referenceDimension,
                    value: candidateValue,
                    delta,
                    distance: referenceDistance,
                    fraction,
                    relative
                });
            }
        }

        activeDimensions.forEach(dimension => {
            if (referenceDimension && dimension === referenceDimension) {
                return;
            }

            const candidateValue = candidateTrack.features?.[dimension];
            const currentValue = currentTrack.features?.[dimension];
            if (candidateValue === undefined || currentValue === undefined) {
                return;
            }

            const hybrid = this.createCounterfactualTrack(currentTrack, {
                [dimension]: candidateValue
            });

            const sliceDistance = this.calculateDimensionSimilarity(currentTrack, hybrid, [dimension], appliedWeights);
            const fraction = (safeTotal > this.epsilon && sliceDistance > 0)
                ? Math.min(1, sliceDistance / safeTotal)
                : 0;
            const delta = candidateValue - currentValue;
            const relative = (referenceDistance && referenceDistance > this.epsilon)
                ? sliceDistance / referenceDistance
                : null;

            console.log(`📐 Feature contribution ${labelPrefix}.${dimension}: value=${candidateValue}, delta=${delta}, fraction=${fraction.toFixed(4)}, relative=${relative !== null ? relative.toFixed(4) : 'n/a'}`);

            slices.push({
                key: dimension,
                value: candidateValue,
                delta,
                distance: sliceDistance,
                fraction,
                relative
            });
        });

        return { total: totalDistance, referenceDistance, slices };
    }

    calculatePcaContributionFractions(currentTrack, candidateTrack, domain, contextLabel = '', referenceComponent = null) {
        if (!currentTrack?.pca || !candidateTrack?.pca) {
            return { total: 0, referenceDistance: 0, referenceKey: null, slices: [] };
        }

        const labelPrefix = contextLabel ? `[${contextLabel}]` : '';
        const rawTotalDistance = this.calculatePCADistance(currentTrack, candidateTrack, domain);
        const totalDistance = Number.isFinite(rawTotalDistance) ? rawTotalDistance : 0;
        const safeTotal = Math.abs(totalDistance);

        const slices = [];
        let referenceDistance = null;
        let referenceKey = null;

        if (domain === 'primary_d') {
            const candidateValue = candidateTrack.pca?.primary_d;
            const currentValue = currentTrack.pca?.primary_d;
            if (candidateValue === undefined || currentValue === undefined) {
                return { total: totalDistance, referenceDistance: 0, referenceKey: null, slices: [] };
            }
            const hybrid = {
                features: this.cloneFeatureSet(currentTrack.features),
                pca: this.clonePcaSet(currentTrack.pca)
            };
            // NOTE: Intentionally modifying PCA without updating features
            // This is a pseudo-track for measuring PCA contribution in isolation
            hybrid.pca.primary_d = candidateValue;

            referenceDistance = Math.abs(this.calculatePCADistance(currentTrack, hybrid, 'primary_d'));
            const fraction = (safeTotal > this.epsilon && referenceDistance > 0)
                ? Math.min(1, referenceDistance / safeTotal)
                : 0;
            const delta = candidateValue - currentValue;
            const relative = referenceDistance > this.epsilon ? 1 : null;

            console.log(`📐 PCA contribution ${labelPrefix}.primary_d: value=${candidateValue}, delta=${delta}, fraction=${fraction.toFixed(4)}, relative=${relative !== null ? relative.toFixed(4) : 'n/a'}`);

            slices.push({
                key: 'primary_d',
                value: candidateValue,
                delta,
                distance: referenceDistance,
                fraction,
                relative
            });

            referenceKey = 'primary_d';

            return { total: totalDistance, referenceDistance, referenceKey, slices };
        }

        const candidateComponents = candidateTrack.pca?.[domain];
        const currentComponents = currentTrack.pca?.[domain];
        if (!Array.isArray(candidateComponents) || !Array.isArray(currentComponents)) {
            return { total: totalDistance, referenceDistance: 0, referenceKey: null, slices: [] };
        }

        let referenceIndex = null;
        if (typeof referenceComponent === 'number' && Number.isFinite(referenceComponent)) {
            referenceIndex = referenceComponent;
        } else if (typeof referenceComponent === 'string') {
            const match = referenceComponent.match(/pc(\d+)/i);
            if (match) {
                referenceIndex = parseInt(match[1], 10) - 1;
            }
        }

        if (referenceIndex !== null && referenceIndex >= 0 && referenceIndex < candidateComponents.length) {
            const candidateValue = candidateComponents[referenceIndex];
            const currentValue = currentComponents[referenceIndex];
            if (candidateValue !== undefined && currentValue !== undefined) {
                const hybrid = {
                    features: this.cloneFeatureSet(currentTrack.features),
                    pca: this.clonePcaSet(currentTrack.pca)
                };
                if (!Array.isArray(hybrid.pca[domain])) {
                    hybrid.pca[domain] = currentComponents.slice();
                }
                // NOTE: Intentionally modifying PCA component without updating features
                // This is a pseudo-track for measuring component contribution in isolation
                hybrid.pca[domain][referenceIndex] = candidateValue;

                referenceDistance = Math.abs(this.calculatePCADistance(currentTrack, hybrid, domain));
                const fraction = (safeTotal > this.epsilon && referenceDistance > 0)
                    ? Math.min(1, referenceDistance / safeTotal)
                    : 0;
                const delta = candidateValue - currentValue;
                const relative = referenceDistance > this.epsilon ? 1 : null;
                const label = `${domain}_pc${referenceIndex + 1}`;

                console.log(`📐 PCA contribution ${labelPrefix}.${label}: value=${candidateValue}, delta=${delta}, fraction=${fraction.toFixed(4)}, relative=${relative !== null ? relative.toFixed(4) : 'n/a'}`);

                slices.push({
                    key: label,
                    value: candidateValue,
                    delta,
                    distance: referenceDistance,
                    fraction,
                    relative
                });

                referenceKey = label;
            }
        }

        candidateComponents.forEach((candidateValue, index) => {
            const currentValue = currentComponents[index];
            if (candidateValue === undefined || currentValue === undefined) {
                return;
            }

            if (referenceIndex !== null && index === referenceIndex) {
                return;
            }

            const hybrid = {
                features: this.cloneFeatureSet(currentTrack.features),
                pca: this.clonePcaSet(currentTrack.pca)
            };
            if (!Array.isArray(hybrid.pca[domain])) {
                hybrid.pca[domain] = currentComponents.slice();
            }
            // NOTE: Intentionally modifying PCA component without updating features
            // This is a pseudo-track for measuring component contribution in isolation
            hybrid.pca[domain][index] = candidateValue;

            const sliceDistance = Math.abs(this.calculatePCADistance(currentTrack, hybrid, domain));
            const fraction = (safeTotal > this.epsilon && sliceDistance > 0)
                ? Math.min(1, sliceDistance / safeTotal)
                : 0;
            const delta = candidateValue - currentValue;
            const relative = (referenceDistance && referenceDistance > this.epsilon)
                ? sliceDistance / referenceDistance
                : null;

            const label = `${domain}_pc${index + 1}`;
            console.log(`📐 PCA contribution ${labelPrefix}.${label}: value=${candidateValue}, delta=${delta}, fraction=${fraction.toFixed(4)}, relative=${relative !== null ? relative.toFixed(4) : 'n/a'}`);

            slices.push({
                key: label,
                value: candidateValue,
                delta,
                distance: sliceDistance,
                fraction,
                relative
            });
        });

        return { total: totalDistance, referenceDistance, referenceKey, slices };
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

    async close() {
        if (this.db) {
            await this.db.end();
        }
    }
}

module.exports = MusicalKDTree;
