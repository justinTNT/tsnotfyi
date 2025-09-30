class DirectionalDriftPlayer {
    constructor(radialSearch) {
        this.radialSearch = radialSearch;
        this.currentTrack = null;
        this.currentDirection = null;
        this.driftHistory = [];
        this.stepCount = 0;

        // Possible directions for drift
        this.directions = [
            'faster', 'slower',
            'brighter', 'darker',
            'more_energetic', 'calmer',
            'more_danceable', 'less_danceable',
            'more_tonal', 'more_atonal',
            'more_complex', 'simpler',
            'more_punchy', 'less_punchy',
            'denser_onsets', 'sparser_onsets',
            'purer_tuning', 'impurer_tuning',
            'stronger_chords', 'weaker_chords',
            'more_air_sizzle', 'less_air_sizzle'
        ];

        // Configuration for drift behavior
        this.config = {
            maxStepsInDirection: 5,        // Max steps before direction change
            minStepsInDirection: 2,        // Min steps before allowing direction change
            directionChangeChance: 0.3,    // Chance to change direction each step
            neighborhoodRadius: 0.8,       // Radius for finding candidates (relaxed scaling)
            fallbackRadius: 1.5,          // If no candidates found, try wider search
            maxRetries: 3                  // Max retries to find a valid next track
        };
    }

    // Start the drift from a random track
    async startDrift() {
        try {
            // Pick a completely random starting track
            const stats = this.radialSearch.getStats();
            const randomIndex = Math.floor(Math.random() * stats.total_tracks);

            // Get a track from the KD-tree (we'll need to modify this to get by index)
            this.currentTrack = await this.getRandomTrack();
            this.currentDirection = this.pickRandomDirection();
            this.stepCount = 0;

            console.log(`🎵 Starting drift at: ${this.currentTrack.title} by ${this.currentTrack.artist}`);
            console.log(`🎯 Initial direction: ${this.currentDirection}`);

            return this.currentTrack;
        } catch (error) {
            console.error('Failed to start drift:', error);
            throw error;
        }
    }

    // Get next track in the drift (passive - no automatic direction changes)
    async getNextTrack() {
        try {
            // Just find the next track in current direction without changing direction
            // Direction changes are now controlled by the gapless transition timing
            const nextTrack = await this.findNextInDirection();

            if (nextTrack) {
                this.updateState(nextTrack);
                return nextTrack;
            } else {
                // Fallback: pick random direction and try wider search
                console.log('🎲 No candidates found, trying fallback...');
                return await this.fallbackSelection();
            }

        } catch (error) {
            console.error('Failed to get next track:', error);
            // Ultimate fallback: completely random track
            return await this.getRandomTrack();
        }
    }

    async findNextInDirection() {
        const config = {
            radius: this.config.neighborhoodRadius,
            weights: this.getAdaptiveWeights(),
            limit: 50  // Get more candidates for better randomization
        };

        try {
            // First try with current radius using our (temporarily broken) radial search
            // For now, let's implement a simple direct selection
            const result = await this.getDirectionalCandidatesFixed(
                this.currentTrack.identifier,
                this.currentDirection,
                config
            );

            if (result.candidates && result.candidates.length > 0) {
                // Pick randomly from top candidates (musical roulette)
                const candidateIndex = Math.floor(Math.random() * Math.min(result.candidates.length, 10));
                return result.candidates[candidateIndex].track;
            }
        } catch (error) {
            console.error('Direction search failed:', error);
        }

        return null;
    }

    // Fixed version that bypasses the neighborhood search and goes directly to directional filtering
    async getDirectionalCandidatesFixed(trackId, direction, config) {
        // Get all tracks that match the direction constraint
        const currentTrack = this.radialSearch.kdTree.getTrack(trackId);
        const allTracks = this.radialSearch.kdTree.tracks;
        const directionDim = this.radialSearch.kdTree.getDirectionDimension(direction);
        const currentValue = currentTrack.features[directionDim];

        // Filter tracks by direction
        const directionalTracks = allTracks.filter(track => {
            if (track.identifier === trackId) return false; // Don't include current track
            const candidateValue = track.features[directionDim];
            return this.radialSearch.kdTree.isInDirection(currentValue, candidateValue, direction);
        });

        // If we have directional tracks, randomly sample from them
        if (directionalTracks.length > 0) {
            // Shuffle and take first 20 as "candidates"
            const shuffled = directionalTracks.sort(() => Math.random() - 0.5);
            const candidates = shuffled.slice(0, 20).map(track => ({
                track: track,
                similarity: Math.random() // Placeholder similarity
            }));

            return {
                candidates: candidates,
                totalAvailable: directionalTracks.length,
                dimension: directionDim,
                currentValue: currentValue
            };
        }

        return { candidates: [], totalAvailable: 0 };
    }

    async fallbackSelection() {
        // Try a completely different direction
        const newDirection = this.pickRandomDirection();
        this.currentDirection = newDirection;

        console.log(`🎯 Fallback direction: ${newDirection}`);

        const nextTrack = await this.findNextInDirection();
        if (nextTrack) {
            this.updateState(nextTrack);
            return nextTrack;
        }

        // Last resort: completely random
        console.log('🎲 Complete random fallback');
        const randomTrack = await this.getRandomTrack();
        this.updateState(randomTrack);
        return randomTrack;
    }

    async getRandomTrack() {
        // Get a random track from the database
        const allTracks = this.radialSearch.kdTree.tracks;
        console.log(`🔍 Debug: tracks array length: ${allTracks ? allTracks.length : 'undefined'}`);
        console.log(`🔍 Debug: first track: ${allTracks && allTracks[0] ? allTracks[0].title + ' by ' + allTracks[0].artist : 'none'}`);

        if (!allTracks || allTracks.length === 0) {
            console.error('No tracks available in kdTree.tracks');
            return null;
        }

        const randomIndex = Math.floor(Math.random() * allTracks.length);
        const selectedTrack = allTracks[randomIndex];
        console.log(`🔍 Selected random track: ${selectedTrack.title} by ${selectedTrack.artist}`);
        return selectedTrack;
    }

    shouldChangeDirection() {
        // Change direction based on step count and randomness
        if (this.stepCount < this.config.minStepsInDirection) {
            return false;
        }

        if (this.stepCount >= this.config.maxStepsInDirection) {
            return true;
        }

        return Math.random() < this.config.directionChangeChance;
    }

    pickRandomDirection() {
        return this.directions[Math.floor(Math.random() * this.directions.length)];
    }

    pickNewDirection() {
        // Pick a different direction (not the current one)
        const otherDirections = this.directions.filter(d => d !== this.currentDirection);
        return otherDirections[Math.floor(Math.random() * otherDirections.length)];
    }

    updateState(nextTrack) {
        this.driftHistory.push({
            from: this.currentTrack ? this.currentTrack.identifier : null,
            to: nextTrack.identifier,
            direction: this.currentDirection,
            step: this.stepCount
        });

        this.currentTrack = nextTrack;
        this.stepCount++;

        console.log(`🎵 Step ${this.stepCount}: ${nextTrack.title} by ${nextTrack.artist} (${this.currentDirection})`);
    }

    getAdaptiveWeights() {
        // Adjust weights based on current direction to emphasize the navigation dimension
        const baseWeights = {
            bpm: 0.2,
            spectral_centroid: 0.15,
            tonal_clarity: 0.12,
            danceability: 0.1,
            onset_rate: 0.08,
            spectral_energy: 0.08
        };

        // Boost the weight of the dimension we're navigating
        const directionDim = this.radialSearch.kdTree.getDirectionDimension(this.currentDirection);
        if (baseWeights[directionDim]) {
            baseWeights[directionDim] *= 1.5; // Boost navigation dimension
        }

        return baseWeights;
    }

    // Get current drift state for debugging/UI
    getDriftState() {
        return {
            currentTrack: this.currentTrack,
            currentDirection: this.currentDirection,
            stepCount: this.stepCount,
            historyLength: this.driftHistory.length,
            recentHistory: this.driftHistory.slice(-5) // Last 5 steps
        };
    }

    // Reset the drift (like page reload)
    reset() {
        this.currentTrack = null;
        this.currentDirection = null;
        this.driftHistory = [];
        this.stepCount = 0;
        console.log('🔄 Drift reset');
    }
}

module.exports = DirectionalDriftPlayer;