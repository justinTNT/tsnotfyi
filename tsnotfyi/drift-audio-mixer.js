const fs = require('fs');
const { spawn } = require('child_process');
const DirectionalDriftPlayer = require('./directional-drift-player');
const AdvancedAudioMixer = require('./advanced-audio-mixer');

class DriftAudioMixer {
  constructor(sessionId, radialSearch) {
    this.sessionId = sessionId;
    this.radialSearch = radialSearch;
    this.clients = new Set();
    this.eventClients = new Set(); // SSE clients for real-time events
    this.isActive = false;
    this.currentProcess = null;
    this.driftPlayer = new DirectionalDriftPlayer(radialSearch);
    this.currentTrack = null;
    this.nextTrack = null;
    this.trackStartTime = null;
    this.isTransitioning = false;

    // Session history and exploration data
    this.sessionHistory = []; // Array of previous tracks with timestamps and metadata
    this.maxHistorySize = 50; // Keep last 50 tracks in history

    // Session-level filtering flags
    this.noAlbum = true; // Default: prevent album repeats in session
    this.noArtist = true; // Default: prevent artist repeats in session
    this.seenArtists = new Set(); // Track artists from played tracks
    this.seenAlbums = new Set(); // Track albums from played tracks

    // Track exposure: tracks the user has actually SEEN (displayed on top of stacks or selected)
    this.seenTracks = new Set(); // Track IDs that were displayed (top of stack OR selected as next track)
    this.seenTrackArtists = new Set(); // Artists from seen tracks
    this.seenTrackAlbums = new Set(); // Albums from seen tracks

    // Cleanup callback supplied by session manager
    this.onIdle = null;
    this.cleanupTimer = null;

    // Explorer configuration
    this.explorerResolution = 'magnifying_glass';

    // Audio configuration
    this.sampleRate = 44100;
    this.channels = 2;
    this.bitRate = 192; // kbps

    // Initialize advanced audio mixer
    this.audioMixer = new AdvancedAudioMixer({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitRate: this.bitRate
    });

    // Set up mixer callbacks
    this.audioMixer.onData = (chunk) => {
      this.broadcastToClients(chunk);
    };

    this.audioMixer.onTrackStart = (reason) => {
      console.log(`🎵 Advanced mixer: Track started (${reason || 'normal'})`);

      // Broadcast track event now that audio is actually playing
      if (this.currentTrack) {
        console.log(`📡 Audio started - now broadcasting track event: ${this.currentTrack.title}`);
        this.broadcastTrackEvent();
      }

      if (reason === 'crossfade_complete') {
        // This means we switched to the next track via crossfade
        console.log('🔄 Crossfade transition completed - track already loaded, just broadcast');
        // DON'T call loadNextTrackIntoMixer() again - it's already loaded
      }
    };

    this.audioMixer.onTrackEnd = () => {
      console.log('🎵 Advanced mixer: Track ended');
      // Automatically load next track
      this.loadNextTrackIntoMixer();
    };

    this.audioMixer.onCrossfadeStart = (info) => {
      console.log(`🔄 Advanced mixer: Crossfade started (${info.currentBPM} → ${info.nextBPM} BPM)`);
    };

    this.audioMixer.onError = (error) => {
      console.error('🚨 Advanced mixer error:', error);
      this.fallbackToNoise();
    };

    // User override handling
    this.selectedNextTrackMd5 = null;
    this.userSelectionDebounceMs = 400; // milliseconds to coalesce rapid selections
    this.pendingUserSelectionTimer = null;
    this.isUserSelectionPending = false;

    // Track preparation coordination
    this.pendingPreparationPromise = null;

    console.log(`Created drift audio mixer for session: ${sessionId}`);
  }

  // Helper: Get the opposite direction for a given direction key
  getOppositeDirection(directionKey) {
    // Handle PCA directions
    if (directionKey.includes('_positive')) {
      return directionKey.replace('_positive', '_negative');
    }
    if (directionKey.includes('_negative')) {
      return directionKey.replace('_negative', '_positive');
    }

    // Handle traditional directions
    const oppositeDirections = {
      'faster': 'slower',
      'slower': 'faster',
      'brighter': 'darker',
      'darker': 'brighter',
      'more_energetic': 'calmer',
      'calmer': 'more_energetic',
      'more_danceable': 'less_danceable',
      'less_danceable': 'more_danceable',
      'more_tonal': 'more_atonal',
      'more_atonal': 'more_tonal',
      'more_complex': 'simpler',
      'simpler': 'more_complex',
      'more_punchy': 'smoother',
      'smoother': 'more_punchy'
    };
    return oppositeDirections[directionKey];
  }

  // Start the drift playback
  async startDriftPlayback() {
    if (this.currentProcess) {
      this.currentProcess.kill();
    }

    try {
      // Start the drift
      this.currentTrack = await this.driftPlayer.startDrift();
      this.playCurrentTrack();

    } catch (error) {
      console.error('Failed to start drift playback:', error);
      this.fallbackToNoise();
    }
  }

  // Play the current track using advanced mixer
  async playCurrentTrack() {
    if (!this.currentTrack || !this.currentTrack.path) {
      console.error('No valid track to play');
      this.fallbackToNoise();
      return;
    }

    // Convert Buffer path to string if needed
    let trackPath = this.currentTrack.path;
    if (trackPath && trackPath.type === 'Buffer' && trackPath.data) {
      trackPath = Buffer.from(trackPath.data).toString('utf8');
      console.log('🔧 Converted Buffer path to string');
    }

    // Check if file exists
    if (!fs.existsSync(trackPath)) {
      console.error(`Track file not found: ${trackPath}`);
      this.skipToNextTrack();
      return;
    }

    console.log(`🎵 ${this.currentTrack.title} by ${this.currentTrack.artist}`);
    this.trackStartTime = Date.now();

    // DON'T broadcast yet - wait until track actually starts streaming

    try {
      // Stop any existing streaming before loading new track
      console.log(`🔧 DEBUG: Stopping previous stream before loading new track`);
      this.audioMixer.stopStreaming();

      // Load track into advanced mixer
      console.log(`🔧 DEBUG: About to load track into advanced mixer: ${trackPath}`);
      console.log(`🔧 DEBUG: Current mixer state - isActive: ${this.isActive}, clients: ${this.clients.size}`);

      const trackInfo = await this.audioMixer.loadTrack(trackPath, 'current');

      console.log(`📊 Track analysis: BPM=${trackInfo.bpm}, Key=${trackInfo.key}, Duration=${trackInfo.duration?.toFixed(1)}s`);
      console.log(`🔧 DEBUG: Track loaded successfully, about to start streaming`);

      // Start streaming with crossfade support
      const streamingResult = this.audioMixer.startStreaming();
      console.log(`🔧 DEBUG: audioMixer.startStreaming() returned: ${streamingResult}`);

      if (streamingResult) {
        console.log('✅ Advanced mixer streaming started');

        // DON'T broadcast here - the onTrackStart callback will handle it when audio actually starts
        // this.broadcastTrackEvent();

        // Schedule next track preparation for crossfading
        if (this.currentTrack.length && this.currentTrack.length > 10) {
          const crossfadeStartTime = (this.currentTrack.length - 2.5) * 1000; // Start crossfade 2.5s before end

          setTimeout(() => {
            if (this.currentTrack && this.isActive) {
              this.prepareNextTrackForCrossfade();
            }
          }, Math.max(1000, crossfadeStartTime)); // At least 1s delay
        }

      } else {
        console.log(`🔧 DEBUG: startStreaming() failed - mixer state may be invalid`);
        console.log(`🔧 DEBUG: audioMixer properties: ${Object.keys(this.audioMixer)}`);
        throw new Error('Failed to start advanced mixer streaming - startStreaming() returned false');
      }

    } catch (error) {
      console.error('❌ Advanced mixer playback failed:', error);
      console.error('❌ Stack trace:', error.stack);
      console.log(`🔧 DEBUG: Error occurred while processing track: ${this.currentTrack?.title} by ${this.currentTrack?.artist}`);
      this.fallbackToNoise();
    }
  }

  handleUserSelectedNextTrack(trackMd5, options = {}) {
    if (!trackMd5) {
      console.warn('⚠️ Ignoring user track override without a trackMd5');
      return;
    }

    const { direction = null, debounceMs = this.userSelectionDebounceMs } = options;

    if (direction) {
      this.driftPlayer.currentDirection = direction;
    }

    if (this.nextTrack && this.nextTrack.identifier === trackMd5) {
      console.log('🎯 User-selected track already prepared; keeping existing preload');
      this.selectedNextTrackMd5 = null;
      this.isUserSelectionPending = false;
      return;
    }

    this.selectedNextTrackMd5 = trackMd5;
    this.isUserSelectionPending = true;

    const effectiveDelay = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : this.userSelectionDebounceMs;

    if (this.pendingUserSelectionTimer) {
      clearTimeout(this.pendingUserSelectionTimer);
    }

    if (effectiveDelay > 0) {
      console.log(`🕓 Debouncing user-selected track override for ${effectiveDelay}ms`);
      this.pendingUserSelectionTimer = setTimeout(() => {
        this.pendingUserSelectionTimer = null;
        this.applyUserSelectedTrackOverride();
      }, effectiveDelay);
    } else {
      this.pendingUserSelectionTimer = null;
      this.applyUserSelectedTrackOverride();
    }
  }

  applyUserSelectedTrackOverride() {
    if (!this.selectedNextTrackMd5) {
      this.isUserSelectionPending = false;
      return;
    }

    const mixerStatus = (this.audioMixer && typeof this.audioMixer.getStatus === 'function')
      ? this.audioMixer.getStatus()
      : null;

    if (mixerStatus?.isCrossfading) {
      console.log('⏳ Crossfade in progress; deferring user-selected override until fade completes');
      if (this.pendingUserSelectionTimer) {
        clearTimeout(this.pendingUserSelectionTimer);
      }
      this.pendingUserSelectionTimer = setTimeout(() => {
        this.pendingUserSelectionTimer = null;
        this.applyUserSelectedTrackOverride();
      }, 750);
      return;
    }

    if (this.nextTrack && this.nextTrack.identifier === this.selectedNextTrackMd5) {
      console.log('🎯 User-selected track already prepared after debounce; no refresh needed');
      this.selectedNextTrackMd5 = null;
      this.isUserSelectionPending = false;
      return;
    }

    if (this.audioMixer && typeof this.audioMixer.clearNextTrackSlot === 'function') {
      this.audioMixer.clearNextTrackSlot();
    }

    this.nextTrack = null;

    this.prepareNextTrackForCrossfade({ forceRefresh: true, reason: 'user-selection' });
  }

  // Prepare next track for crossfading
  async prepareNextTrackForCrossfade(options = {}) {
    const { forceRefresh = false, reason = 'auto' } = options;

    if (this.pendingPreparationPromise) {
      if (!forceRefresh) {
        console.log('⏳ Next track preparation already in progress; skipping duplicate call');
        return this.pendingPreparationPromise;
      }

      console.log('⏳ Force refresh requested; waiting for current preparation to finish');
      try {
        await this.pendingPreparationPromise;
      } catch (err) {
        console.warn(`⚠️ Previous preparation ended with error before force refresh: ${err?.message || err}`);
      }
    }

    if (this.isUserSelectionPending && !forceRefresh) {
      console.log('⏳ Skipping auto next-track preparation while user selection is pending');
      return;
    }

    const preparation = (async () => {
      try {
        const nextTrack = await this.selectNextFromCandidates();
        if (!nextTrack) {
          console.log('❌ No next track selected for crossfade preparation');
          return;
        }

        console.log(`🎯 Preparing next track for crossfade (${reason}): ${nextTrack.title}`);
        console.log(`🔧 DEBUG: Next track path: ${nextTrack.path}`);
        console.log(`🔧 DEBUG: Current this.nextTrack: ${this.nextTrack?.title || 'null'}`);

        if (!forceRefresh && this.nextTrack && this.nextTrack.identifier === nextTrack.identifier) {
          console.log(`⚠️ Same next track already prepared, skipping duplicate processing: ${nextTrack.title}`);
          return;
        }

        const nextTrackInfo = await this.audioMixer.loadTrack(nextTrack.path, 'next');
        console.log(`📊 Next track analysis: BPM=${nextTrackInfo.bpm}, Key=${nextTrackInfo.key}`);

        this.nextTrack = nextTrack;
        console.log(`✅ Next track prepared successfully: ${nextTrack.title}`);
      } catch (error) {
        console.error('❌ Failed to prepare next track:', error);
        console.error('❌ Error details:', error.stack);
      }
    })();

    this.pendingPreparationPromise = preparation;

    try {
      await preparation;
    } finally {
      if (this.pendingPreparationPromise === preparation) {
        this.pendingPreparationPromise = null;
      }
    }
  }

  // Auto-load next track when mixer requests it
  async loadNextTrackIntoMixer() {
    if (this.nextTrack) {
      // Move prepared track to current
      this.currentTrack = this.nextTrack;
      this.nextTrack = null;
      this.trackStartTime = Date.now();

      // Clear mixdown cache on significant transitions (when we've moved to a new track)
      // This ensures we don't hold onto old neighborhood data
      this.audioMixer.clearMixdownCache();

      // DON'T broadcast here - let the audio mixer broadcast when it actually starts streaming
      // The broadcast will happen in the audioMixer.onTrackStart callback -> broadcastTrackEvent()
      console.log(`🔧 Track loaded into mixer: ${this.currentTrack.title} - waiting for audio to start before broadcasting`);

      // Start building new neighborhood cache aggressively
      this.startNeighborhoodCaching();

      // Prepare another next track (will start building new neighborhood cache)
      this.prepareNextTrackForCrossfade();

    } else {
      // No prepared track, transition normally
      await this.transitionToNext();
    }
  }

  // Start aggressive neighborhood caching based on current exploration data
  async startNeighborhoodCaching() {
    // Background neighborhood caching disabled to reduce upfront decode load.
    return;
  }

  // Get exploration data for current track (reuse existing logic)
  async getExplorerDataForCurrentTrack() {
    if (!this.currentTrack) return null;

    try {
      return await this.radialSearch.exploreFromTrack(this.currentTrack.identifier);
    } catch (error) {
      console.warn(`Failed to get explorer data: ${error.message}`);
      return null;
    }
  }

  // Next track selection - user selection takes priority, then explorer-based selection
  async selectNextFromCandidates() {
    try {
      // PRIORITY: Check if user has selected a specific track
      if (this.selectedNextTrackMd5) {
        console.log(`🎯 User selected track takes priority: ${this.selectedNextTrackMd5}`);
        const userSelectedTrack = this.radialSearch.kdTree.getTrack(this.selectedNextTrackMd5);
        if (userSelectedTrack) {
          console.log(`✅ Using user-selected track: ${userSelectedTrack.title} by ${userSelectedTrack.artist}`);
          // Clear the selection after using it
          this.selectedNextTrackMd5 = null;
          this.isUserSelectionPending = false;
          return userSelectedTrack;
        } else {
          console.error(`❌ User-selected track not found: ${this.selectedNextTrackMd5}`);
          this.selectedNextTrackMd5 = null; // Clear invalid selection
          this.isUserSelectionPending = false;
        }
      }

      // Fallback to explorer-based selection (same logic as SSE event)
      console.log(`🎯 No user selection, using explorer-based selection`);
      const explorerData = await this.getComprehensiveExplorerData();
      const nextTrackFromExplorer = await this.selectNextTrackFromExplorer(explorerData);

      if (nextTrackFromExplorer) {
        const track = this.radialSearch.kdTree.getTrack(nextTrackFromExplorer.identifier);
        if (track) {
          console.log(`✅ Using explorer-selected track: ${track.title} by ${track.artist} via ${nextTrackFromExplorer.nextTrackDirection}`);
          return track;
        }
      }

      // Ultimate fallback to drift player
      console.log(`🎯 Explorer selection failed, using drift player fallback`);
      return await this.driftPlayer.getNextTrack();
    } catch (error) {
      console.error('Failed to select next track:', error);
      // Ultimate fallback - return null and let system handle it
      return null;
    }
  }

  pickOptimalDirection(flowOptions) {
    const directions = Object.keys(flowOptions).filter(dir =>
      flowOptions[dir].candidates.length > 0
    );

    if (directions.length === 0) {
      return this.driftPlayer.currentDirection || 'faster';
    }

    // 70% chance to continue current direction if it has good candidates
    const currentDirection = this.driftPlayer.currentDirection;
    if (Math.random() < 0.7 &&
        currentDirection &&
        flowOptions[currentDirection] &&
        flowOptions[currentDirection].candidates.length >= 3) {
      console.log(`🔄 Continuing drift: ${currentDirection}`);
      return currentDirection;
    }

    // Pick direction with most high-quality candidates
    const directionsByQuality = directions.sort((a, b) => {
      const aScore = flowOptions[a].candidates.length;
      const bScore = flowOptions[b].candidates.length;
      return bScore - aScore;
    });

    // Add some randomization among top 3 directions
    const topDirections = directionsByQuality.slice(0, 3);
    const chosenDirection = topDirections[Math.floor(Math.random() * topDirections.length)];

    console.log(`🎯 New direction: ${chosenDirection} (${flowOptions[chosenDirection].candidates.length} candidates)`);
    return chosenDirection;
  }

  // Transition to the next track using smart candidate selection
  async transitionToNext() {
    if (this.isTransitioning) {
      console.log('⚠️ Transition already in progress, skipping...');
      return;
    }

    try {
      this.isTransitioning = true;
      console.log('🔄 Starting track transition...');

      this.currentTrack = await this.selectNextFromCandidates();
      this.playCurrentTrack();

      this.isTransitioning = false;
    } catch (error) {
      console.error('Failed to get next track:', error);
      this.isTransitioning = false;
      this.fallbackToNoise();
    }
  }

  // Trigger gapless transition using advanced mixer
  async triggerGaplessTransition() {
    console.log('🎮 Triggering immediate transition');

    // Occasionally change direction (30% chance)
    if (Math.random() < 0.3) {
      const newDirection = this.driftPlayer.pickNewDirection();
      this.driftPlayer.currentDirection = newDirection;
      console.log(`🔄 ${newDirection}`);
    }

    // Force immediate CROSSFADE if next track is ready, otherwise transition normally
    if (this.audioMixer.forceTransition('crossfade')) {
      console.log('✅ Forced immediate 2.5s CROSSFADE transition');
    } else {
      console.log('⏭️ No next track ready, standard transition');
      this.audioMixer.stopStreaming();
      await this.transitionToNext();
    }
  }

  // Skip to next track immediately
  async skipToNextTrack() {
    console.log('⏭️ Skipping to next track...');
    this.audioMixer.stopStreaming();
    await this.transitionToNext();
  }

  // Fallback to generated noise when tracks fail
  fallbackToNoise() {
    // Rate limiting: prevent runaway noise fallback
    const now = Date.now();

    // Initialize rate limiting variables on first call
    if (!this.lastNoiseTime) {
      this.lastNoiseTime = now;
      this.noiseCount = 1; // This is attempt #1
    } else {
      // If less than 5 seconds since last noise, increment counter
      if (now - this.lastNoiseTime < 5000) {
        this.noiseCount++;
        if (this.noiseCount > 3) {
          console.log('🚫 NOISE FALLBACK RATE LIMITED - too many failures in short time');
          console.log('🚫 Stopping session to prevent runaway processes');
          this.isActive = false;
          return;
        }
      } else {
        // Reset counter if enough time has passed (>5 seconds)
        this.noiseCount = 1; // Fresh start
      }

      this.lastNoiseTime = now;
    }

    console.log(`🌊 Falling back to ambient noise... (attempt ${this.noiseCount}/3)`);

    const ffmpegArgs = [
      '-f', 'lavfi',
      '-i', 'anoisesrc=color=brown:sample_rate=44100:duration=3600', // 1 hour of brown noise
      '-ac', '2',
      '-ar', '44100',
      '-b:a', '32k',
      '-filter:a', 'volume=0.05,highpass=f=100,lowpass=f=4000',
      '-f', 'mp3',
      'pipe:1'
    ];

    this.currentProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    console.log(`🌊 Noise fallback started: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Handle stdout data
    this.currentProcess.stdout.on('data', (chunk) => {
      this.broadcastToClients(chunk);
    });

    // Handle errors
    this.currentProcess.stderr.on('data', (data) => {
      console.error('Noise FFmpeg stderr:', data.toString());
    });

    this.currentProcess.on('close', (code) => {
      console.log(`🌊 Noise FFmpeg process exited with code ${code}`);
      if (this.isActive) {
        setTimeout(() => this.attemptDriftResumption(), 2000);
      }
    });

    this.currentProcess.on('error', (err) => {
      console.error('🌊 Noise FFmpeg spawn error:', err);
    });
  }

  // Try to resume drift after fallback
  async attemptDriftResumption() {
    try {
      console.log('🔄 Attempting to resume drift...');
      this.currentTrack = await this.selectNextFromCandidates();
      this.playCurrentTrack();
    } catch (error) {
      console.error('Failed to resume drift, continuing noise:', error);
      this.fallbackToNoise();
    }
  }

  // Add a client to receive the stream
  addClient(response) {
    console.log(`Adding client to drift session: ${this.sessionId}`);

    // Set proper headers for MP3 streaming
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges': 'none'
    });

    this.clients.add(response);
    this.pendingClientBootstrap = false;

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Start drift if this is the first client
    if (this.clients.size === 1 && !this.isActive) {
      this.startStreaming();
    }

    // Handle client disconnect
    response.on('close', () => {
      console.log(`Client disconnected from drift session: ${this.sessionId}`);
      this.clients.delete(response);

      // Stop streaming if no clients
      if (this.clients.size === 0) {
        this.stopStreaming();
      }
    });

    response.on('error', (err) => {
      console.error('Client response error:', err);
      this.clients.delete(response);
    });
  }

  // Start the streaming
  startStreaming() {
    if (this.isActive) return;

    console.log(`🎵 Starting drift streaming for session: ${this.sessionId}`);
    this.isActive = true;

    // If the mixer is already streaming (preload) just start serving clients
    if (this.audioMixer?.engine?.isStreaming) {
      console.log('🎵 Mixer already streaming from preload; keeping current track');
      return;
    }

    // Respect any pre-seeded track (e.g., contrived MD5 journey)
    if (this.currentTrack && this.currentTrack.path) {
      console.log(`🎵 Using pre-seeded track for session start: ${this.currentTrack.title || this.currentTrack.identifier}`);
      this.playCurrentTrack();
    } else {
      this.startDriftPlayback();
    }
  }

  // Set up stream piping for current process

  // Stop streaming
  stopStreaming() {
    if (!this.isActive) return;

    console.log(`🛑 Stopping drift streaming for session: ${this.sessionId}`);
    this.isActive = false;

    // Stop advanced mixer
    this.audioMixer.stopStreaming();

    // Kill fallback noise process if active
    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    if (!this.pendingClientBootstrap && typeof this.onIdle === 'function' && this.clients.size === 0 && this.eventClients.size === 0) {
      this.onIdle();
    }
  }

  // Send audio data to all connected clients
  broadcastToClients(chunk) {
    for (const client of this.clients) {
      try {
        if (!client.destroyed) {
          client.write(chunk);
        }
      } catch (err) {
        console.error('Error writing to client:', err);
        this.clients.delete(client);
      }
    }
  }

  // Add event client for SSE
  addEventClient(eventClient) {
    console.log(`📡 Event client connected to session: ${this.sessionId}`);
    this.eventClients.add(eventClient);

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // Remove event client
  removeEventClient(eventClient) {
    console.log(`📡 Event client disconnected from session: ${this.sessionId}`);
    this.eventClients.delete(eventClient);

    if (!this.pendingClientBootstrap && !this.isActive && this.clients.size === 0 && this.eventClients.size === 0 && typeof this.onIdle === 'function') {
      this.onIdle();
    }
  }

  // Broadcast event to all SSE clients
  broadcastEvent(eventData) {
    console.log(`📡 Session ${this.sessionId} broadcasting to ${this.eventClients.size} clients`);
    const eventJson = JSON.stringify(eventData);
    for (const client of this.eventClients) {
      try {
        if (!client.destroyed) {
          console.log(`📡 → Sending to client for session ${this.sessionId}`);
          client.write(`data: ${eventJson}\n\n`);
        }
      } catch (err) {
        console.error('Error sending event to client:', err);
        this.eventClients.delete(client);
      }
    }
  }

  // Add track to session history
  addToHistory(track, startTimestamp, direction = null, transitionReason = 'natural') {
    const historyEntry = {
      identifier: track.identifier,
      title: track.title,
      artist: track.artist,
      duration: track.length,
      startTime: startTimestamp,
      direction: direction,
      transitionReason: transitionReason,
      features: track.features || {},
      albumCover: track.albumCover || null,
      pca: track.pca || null
    };

    this.sessionHistory.push(historyEntry);

    // Track seen artists and albums for filtering
    if (track.artist && this.noArtist) {
      this.seenArtists.add(track.artist);
    }
    if (track.album && this.noAlbum) {
      this.seenAlbums.add(track.album);
    }

    // Keep history size manageable
    if (this.sessionHistory.length > this.maxHistorySize) {
      this.sessionHistory.shift();
    }
  }

  // Strategic sample track selection: use method 3 times to get 24 samples
  selectStrategicSamples(candidates, currentTrack, maxSamples = 24) {
    if (!candidates || candidates.length === 0) return [];
    if (candidates.length <= maxSamples) return candidates;

    const samples = new Set(); // Use Set to avoid duplicates
    const samplesPerRound = Math.ceil(maxSamples / 3); // 8 samples per round for 24 total

    // Calculate diversity scores if not already present
    const candidatesWithScores = candidates.map(candidate => {
      const track = candidate.track || candidate;
      // Simple diversity based on distance from current track
      const diversityScore = candidate.distance || candidate.similarity || Math.random();
      return { ...candidate, track, diversityScore };
    });

    // Round 1: Top-to-bottom sampling (most similar to least similar)
    const diversitySorted = [...candidatesWithScores].sort((a, b) => a.diversityScore - b.diversityScore);
    const step1 = Math.max(1, Math.floor(diversitySorted.length / samplesPerRound));
    for (let i = 0; i < samplesPerRound && i * step1 < diversitySorted.length; i++) {
      const candidate = diversitySorted[i * step1];
      if (candidate) samples.add(candidate);
    }

    // Round 2: Random sampling from remaining candidates
    const remaining1 = candidatesWithScores.filter(c =>
      !Array.from(samples).find(s => s.track.identifier === c.track.identifier)
    );
    const shuffled = remaining1.sort(() => Math.random() - 0.5);
    for (let i = 0; i < samplesPerRound && i < shuffled.length; i++) {
      samples.add(shuffled[i]);
    }

    // Round 3: Distance-based sampling from still remaining candidates
    const remaining2 = candidatesWithScores.filter(c =>
      !Array.from(samples).find(s => s.track.identifier === c.track.identifier)
    );
    const distanceSorted = remaining2.sort((a, b) => {
      const distA = a.distance || a.similarity || 0;
      const distB = b.distance || b.similarity || 0;
      return distA - distB;
    });
    const step3 = Math.max(1, Math.floor(distanceSorted.length / samplesPerRound));
    for (let i = 0; i < samplesPerRound && i * step3 < distanceSorted.length; i++) {
      const candidate = distanceSorted[i * step3];
      if (candidate) samples.add(candidate);
    }

    return Array.from(samples).slice(0, maxSamples);
  }

  // Smart filtering: exclude played tracks, deprioritize seen tracks and their artists/albums
  filterAndDeprioritizeCandidates(tracks) {
    if (!tracks || tracks.length === 0) return [];

    const scored = tracks.map((trackObj, index) => {
      const track = trackObj.track || trackObj;
      // Start with existing sort order priority (higher index = lower priority)
      let priority = 1.0 - (index / tracks.length); // 1.0 for first track, approaching 0 for last

      // HARD EXCLUSION: Already played tracks
      if (this.currentTrack && track.identifier === this.currentTrack.identifier) {
        return null; // Will be filtered out
      }

      // Check if track was actually played this session
      const wasPlayed = this.sessionHistory.some(historyEntry =>
        historyEntry.track.identifier === track.identifier
      );
      if (wasPlayed) {
        return null; // HARD EXCLUDE: No track repeats ever
      }

      // AGGRESSIVE DEPRIORITIZATION: Tracks that were SEEN (top of stack or selected as next)
      if (this.seenTracks.has(track.identifier)) {
        priority *= 0.05; // 95% penalty for seen tracks
      }

      // GENTLE DEPRIORITIZATION: Artists from seen tracks
      if (track.artist && this.seenTrackArtists.has(track.artist)) {
        priority *= 0.5; // 50% penalty for artists from seen tracks
      }

      // GENTLE DEPRIORITIZATION: Albums from seen tracks
      if (track.album && this.seenTrackAlbums.has(track.album)) {
        priority *= 0.2; // 80% penalty for albums from seen tracks
      }

      return {
        ...trackObj,
        _priority: priority,
        _originalIndex: index
      };
    }).filter(item => item !== null); // Remove hard exclusions

    // Sort by priority (high to low), with small randomization for diversity
    return scored.sort((a, b) => {
      // Add small random factor to prevent deterministic ordering
      const randomA = a._priority * (0.95 + Math.random() * 0.1);
      const randomB = b._priority * (0.95 + Math.random() * 0.1);
      return randomB - randomA;
    });
  }

  // Filter tracks based on session-level noArtist/noAlbum flags
  filterSessionRepeats(tracks) {
    const originalCount = tracks.length;

    // Disable session filtering for the first few tracks to prevent core direction starvation
    const trackCount = this.sessionHistory.length;
    if (trackCount <= 3) {
      console.log(`🔓 Session filtering DISABLED - only ${trackCount} tracks played, allowing all ${originalCount} candidates`);
      return tracks;
    }

    const filtered = tracks.filter(trackObj => {
      // Handle both direct track objects and wrapped candidate objects
      const track = trackObj.track || trackObj;

      // ALWAYS exclude current track to prevent duplicates
      if (this.currentTrack && track.identifier === this.currentTrack.identifier) {
        return false;
      }

      // Filter out seen artists if noArtist is enabled
      if (this.noArtist && track.artist && this.seenArtists.has(track.artist)) {
        return false;
      }

      // Filter out seen albums if noAlbum is enabled
      if (this.noAlbum && track.album && this.seenAlbums.has(track.album)) {
        return false;
      }

      return true;
    });

    if (filtered.length < originalCount) {
      console.log(`🚫 Session filtering: ${originalCount - filtered.length} tracks removed (${filtered.length} remaining)`);
    }

    // If filtering removed ALL candidates, fallback to unfiltered for core directions
    if (filtered.length === 0 && originalCount > 0) {
      console.log(`🚨 Session filtering removed ALL candidates! Falling back to unfiltered list for core directions`);
      return tracks;
    }

    return filtered;
  }

  // Enhanced comprehensive track event for SSE with full exploration data
  async broadcastTrackEvent(force = false) {
    console.log(`📡 broadcastTrackEvent called, eventClients: ${this.eventClients.size}`);

    if (this.eventClients.size === 0) {
      console.log(`📡 No event clients, skipping broadcast`);
      return;
    }

    if (!this.currentTrack) {
      console.log(`📡 No current track, skipping broadcast`);
      return;
    }

    // Continue broadcasting regardless of title - identifier is what matters
    // Title metadata is cosmetic, not functional

    // THROTTLE: Prevent runaway broadcasting - only broadcast if track actually changed
    const currentTrackId = this.currentTrack.identifier;

    if (!force && this._lastBroadcastTrackId === currentTrackId) {
      console.log(`📡 Skipping duplicate broadcast for same track: ${currentTrackId}`);
      return;
    }

    this._lastBroadcastTrackId = currentTrackId;
    console.log(`📡 Broadcasting NEW track event: ${this.currentTrack.title}`);

    try {
      console.log(`📡 Starting track event broadcast for: ${this.currentTrack.title} by ${this.currentTrack.artist}`);

      // Add current track to history if transitioning from a previous track
      if (this.sessionHistory.length === 0 ||
          this.sessionHistory[this.sessionHistory.length - 1].identifier !== this.currentTrack.identifier) {
        this.addToHistory(this.currentTrack, this.trackStartTime, this.driftPlayer.currentDirection);
        console.log(`📡 Added track to history, total: ${this.sessionHistory.length}`);
      }

      // Get comprehensive exploration data with all the exotic next track data
      let explorerData;
      try {
        console.log(`📊 Loading comprehensive explorer data...`);
        explorerData = await this.getComprehensiveExplorerData();
        console.log(`📊 Explorer data loaded: ${Object.keys(explorerData.directions || {}).length} directions, ${Object.keys(explorerData.outliers || {}).length} outliers`);
      } catch (explorerError) {
        console.error('🚨🚨🚨 CRITICAL: PCA/Core explorer data FAILED - Legacy fallback has been DISABLED! 🚨🚨🚨');
        console.error('🚨 Original error:', explorerError);
        console.error('🚨 This means NO directions will be available for exploration!');
        console.error('🚨 The system will NOT fall back to legacy search - fix the PCA/Core search!');

        // Return empty explorer data - no legacy fallback
        explorerData = {
          directions: {},
          outliers: {},
          nextTrack: null,
          diversityMetrics: {
            error: true,
            message: 'PCA/Core search failed - Legacy fallback disabled',
            originalError: explorerError.message
          }
        };
      }

      // Ensure nextTrack information exists for UI consumption
      if (!explorerData.nextTrack && this.nextTrack) {
        console.log('📊 No explorer nextTrack, falling back to prepared next track');
        explorerData.nextTrack = {
          directionKey: this.nextTrack.directionKey || this.nextTrack.nextTrackDirection || null,
          direction: this.nextTrack.nextTrackDirection || null,
          track: {
            identifier: this.nextTrack.identifier,
            title: this.nextTrack.title,
            artist: this.nextTrack.artist,
            duration: this.nextTrack.length || this.nextTrack.duration || null,
            albumCover: this.nextTrack.albumCover || null
          }
        };
      }

      const trackEvent = {
        type: 'track_started',
        timestamp: Date.now(),

        // Current track with full metadata
        currentTrack: {
          identifier: this.currentTrack.identifier,
          title: this.currentTrack.title,
          artist: this.currentTrack.artist,
          duration: this.getAdjustedTrackDuration(),
          features: this.currentTrack.features || {},
          albumCover: this.currentTrack.albumCover || null,
          pca: this.currentTrack.pca || null,
          startTime: this.trackStartTime
        },

        // Session history (last 10 tracks)
        sessionHistory: this.sessionHistory.slice(-10).map(entry => ({
          identifier: entry.identifier,
          title: entry.title,
          artist: entry.artist,
          startTime: entry.startTime,
          direction: entry.direction,
          transitionReason: entry.transitionReason
        })),

        // Current drift state
        driftState: {
          currentDirection: this.driftPlayer.currentDirection,
          stepCount: this.driftPlayer.stepCount,
          sessionDuration: Date.now() - (this.sessionHistory[0]?.startTime || Date.now())
        },

        // Comprehensive explorer section with weighted directions and groups
        explorer: explorerData,

        // Session metadata
        session: {
          id: this.sessionId,
          clients: this.clients.size,
          totalTracksPlayed: this.sessionHistory.length,
          diversityScore: this.calculateSessionDiversity(),
          filtering: {
            noArtist: this.noArtist,
            noAlbum: this.noAlbum,
            seenArtistsCount: this.seenArtists.size,
            seenAlbumsCount: this.seenAlbums.size
          }
        }
      };

      console.log(`📡 Broadcasting comprehensive track event: ${this.currentTrack.title} by ${this.currentTrack.artist}`);
      console.log(`📊 Next track: ${explorerData.nextTrack?.title || 'TBD'} via ${explorerData.nextTrack?.nextTrackDirection || 'unknown'} (${explorerData.nextTrack?.transitionReason || 'unknown'})`);

      this.broadcastEvent(trackEvent);

    } catch (error) {
      console.error('📡 SSE track event error:', error);

      // Send minimal fallback event so frontend gets something
      try {
        const fallbackEvent = {
          type: 'track_started',
          timestamp: Date.now(),
          currentTrack: {
            identifier: this.currentTrack.identifier,
            title: this.currentTrack.title,
            artist: this.currentTrack.artist,
            duration: this.getAdjustedTrackDuration(),
            albumCover: this.currentTrack.albumCover,
          },
          error: 'Failed to load full track data',
          errorMessage: error.message
        };

        this.broadcastEvent(fallbackEvent);
      } catch (fallbackError) {
        console.error('📡 Even fallback SSE failed:', fallbackError);
      }
    }
  }

  // Get directional flow options (expensive - use only when needed)
  async broadcastRichFlowOptions() {
    if (this.eventClients.size === 0) return;

    try {
      const flowOptions = await this.getDirectionalFlowOptions();

      const flowEvent = {
        type: 'flow_options',
        timestamp: Date.now(),
        flowOptions: flowOptions,
        currentDirection: this.driftPlayer.currentDirection
      };

      console.log(`📡 Broadcasting flow options (${Object.keys(flowOptions).length} directions)`);
      this.broadcastEvent(flowEvent);

    } catch (error) {
      console.error('Failed to broadcast flow options:', error);
    }
  }

  // Get comprehensive explorer data with PCA-enhanced directions and diversity scoring
  async getComprehensiveExplorerData() {
    if (!this.currentTrack) {
      throw new Error('No current track for explorer data');
    }

    const currentTrackData = this.radialSearch.kdTree.getTrack(this.currentTrack.identifier);
    if (!currentTrackData || !currentTrackData.pca) {
      // Fallback to legacy exploration if no PCA data
      return await this.getLegacyExplorerData();
    }

    const explorerData = {
      directions: {},
      outliers: {},
      nextTrack: null,
      diversityMetrics: {}
    };

    // Get total neighborhood size for diversity calculations
    console.log(`📊 Getting neighborhood for track: ${currentTrackData.identifier}`);
    console.log(`📊 Track has PCA data:`, !!currentTrackData.pca);

    let totalNeighborhood;
    const resolution = this.explorerResolution || 'magnifying_glass';
    console.log(`📊 Using explorer resolution: ${resolution}`);

    try {
      totalNeighborhood = this.radialSearch.kdTree.pcaRadiusSearch(
        currentTrackData, resolution, 'primary_d', 1000
      );
      console.log(`📊 PCA radius search returned: ${totalNeighborhood.length} tracks`);
    } catch (pcaError) {
      console.error('📊 PCA radius search failed:', pcaError);
      // Fallback to legacy radius search
      console.log('📊 Falling back to legacy radius search');
      const radiusFallback = {
        microscope: 0.03,
        magnifying_glass: 0.07,
        binoculars: 0.11
      };
      const legacyRadius = radiusFallback[resolution] || 0.25;
      totalNeighborhood = this.radialSearch.kdTree.radiusSearch(currentTrackData, legacyRadius, null, 1000);
      console.log(`📊 Legacy radius search returned: ${totalNeighborhood.length} tracks`);
    }

    const totalNeighborhoodSize = totalNeighborhood.length;
    console.log(`📊 Final neighborhood size: ${totalNeighborhoodSize} tracks`);

    // Get PCA directions with enhanced data
    const pcaDirections = this.radialSearch.getPCADirections();

    // Explore PCA directions first (skip primary_d - internal only)
    for (const [domain, domainInfo] of Object.entries(pcaDirections)) {
      if (domain === 'primary_d') {
        // Skip primary discriminator - used internally, not exposed to UI
        console.log('📊 Skipping primary_d directions (internal use only)');
        continue;
      } else {
        // Multi-component domains (tonal, spectral, rhythmic)
        for (const [component, componentInfo] of Object.entries(domainInfo)) {
          const directionKey = `${domain}_${component}`;
          await this.exploreDirection(explorerData, domain, component, componentInfo.positive, componentInfo.description, 'positive', totalNeighborhoodSize);
          await this.exploreDirection(explorerData, domain, component, componentInfo.negative, componentInfo.description, 'negative', totalNeighborhoodSize);
        }
      }
    }

    // Add original 18 core feature directions for local neighborhood search
    console.log(`📊 Adding original 18 core feature directions...`);
    const originalFeatures = [
      // Rhythmic
      { name: 'bpm', positive: 'faster', negative: 'slower', description: 'Tempo' },
      { name: 'danceability', positive: 'more_danceable', negative: 'less_danceable', description: 'Danceability' },
      { name: 'onset_rate', positive: 'busier_onsets', negative: 'sparser_onsets', description: 'Rhythmic density' },
      { name: 'beat_punch', positive: 'punchier_beats', negative: 'smoother_beats', description: 'Beat character' },

      // Tonal
      { name: 'tonal_clarity', positive: 'more_tonal', negative: 'more_atonal', description: 'Tonality' },
      { name: 'tuning_purity', positive: 'purer_tuning', negative: 'looser_tuning', description: 'Tuning precision' },
      { name: 'fifths_strength', positive: 'stronger_fifths', negative: 'weaker_fifths', description: 'Harmonic strength' },
      { name: 'chord_strength', positive: 'stronger_chords', negative: 'weaker_chords', description: 'Chord definition' },
      { name: 'chord_change_rate', positive: 'faster_changes', negative: 'slower_changes', description: 'Harmonic movement' },

      // Harmonic Shape
      { name: 'crest', positive: 'more_punchy', negative: 'smoother', description: 'Dynamic punch' },
      { name: 'entropy', positive: 'more_complex', negative: 'simpler', description: 'Complexity' },

      // Spectral
      { name: 'spectral_centroid', positive: 'brighter', negative: 'darker', description: 'Brightness' },
      { name: 'spectral_rolloff', positive: 'fuller_spectrum', negative: 'narrower_spectrum', description: 'Spectral fullness' },
      { name: 'spectral_kurtosis', positive: 'peakier_spectrum', negative: 'flatter_spectrum', description: 'Spectral shape' },
      { name: 'spectral_energy', positive: 'more_energetic', negative: 'calmer', description: 'Energy level' },
      { name: 'spectral_flatness', positive: 'noisier', negative: 'more_tonal_spectrum', description: 'Spectral character' },

      // Production
      { name: 'sub_drive', positive: 'more_bass', negative: 'less_bass', description: 'Low-end presence' },
      { name: 'air_sizzle', positive: 'more_air', negative: 'less_air', description: 'High-end sparkle' }
    ];

    // Explore each original feature direction using legacy directional search
    console.log(`📊 Starting exploration of ${originalFeatures.length} original features...`);
    console.log(`🔍 CORE SEARCH SETUP: RadialSearch object available methods:`, Object.getOwnPropertyNames(Object.getPrototypeOf(this.radialSearch)));
    console.log(`🔍 CORE SEARCH SETUP: getDirectionalCandidates method exists:`, typeof this.radialSearch.getDirectionalCandidates);

    for (const feature of originalFeatures) {
      console.log(`📊 Exploring original feature: ${feature.name} (${feature.description})`);
      await this.exploreOriginalFeatureDirection(explorerData, feature, 'positive', totalNeighborhoodSize);
      await this.exploreOriginalFeatureDirection(explorerData, feature, 'negative', totalNeighborhoodSize);
    }

    // Limit to maximum 12 dimensions for UI performance
    explorerData.directions = this.limitToTopDimensions(explorerData.directions, 12);

    // Strategic deduplication: PCA directions take precedence over similar core directions
    explorerData.directions = this.deduplicateTracksStrategically(explorerData.directions);

    // 🃏 DEBUG: Verify no duplicate cards across stacks
    this.debugDuplicateCards(explorerData.directions);

    // 🃏 FINAL DEDUPLICATION: Each card appears in exactly one stack (highest position wins)
    explorerData.directions = this.finalDeduplication(explorerData.directions);

    // After deduplication, limit each direction back to 24 sample tracks for UI
    Object.keys(explorerData.directions).forEach(directionKey => {
      const direction = explorerData.directions[directionKey];
      if (direction.sampleTracks && direction.sampleTracks.length > 24) {
        direction.sampleTracks = this.selectStrategicSamples(
          direction.sampleTracks.map(track => ({ track })),
          this.currentTrack,
          24
        ).map(sample => sample.track);
      }
    });


    Object.entries(explorerData.directions).forEach(([key, data]) => {
        console.log(`🚫🚫BEFORE🚫🚫 ${key} ${data.sampleTracks.length} ${data.hasOpposite}`)
    });

    // ⚖️ BIDIRECTIONAL PRIORITIZATION: Make larger stack primary, smaller stack opposite
    // Do this AFTER final sampling so we prioritize based on actual final track counts
    explorerData.directions = this.prioritizeBidirectionalDirections(explorerData.directions);

    Object.entries(explorerData.directions).forEach(([key, data]) => {
      if (data.oppositeDirection) {
        const opKey = data.oppositeDirection.key;
        console.log(`🚫🚫AFTER🚫🚫 ${key} ${data.sampleTracks.length}, ${data.oppositeDirection.sampleTracks.length} ${opKey}`);
      } else {
        console.log(`🚫🚫AFTER🚫🚫 ${key} ${data.sampleTracks.length} ${data.hasOpposite}`);
      }
    });

    // Calculate diversity scores and select next track
    explorerData.diversityMetrics = this.calculateExplorerDiversityMetrics(explorerData.directions, totalNeighborhoodSize);
    explorerData.nextTrack = await this.selectNextTrackFromExplorer(explorerData);
    explorerData.resolution = this.explorerResolution;

    return explorerData;
  }

  setExplorerResolution(resolution) {
    const validResolutions = ['microscope', 'magnifying_glass', 'binoculars'];
    if (!validResolutions.includes(resolution)) {
      throw new Error(`Invalid explorer resolution: ${resolution}`);
    }

    if (this.explorerResolution === resolution) {
      console.log(`🔍 Explorer resolution already ${resolution}, no change`);
      return false;
    }

    console.log(`🔍 Updating explorer resolution: ${this.explorerResolution} → ${resolution}`);
    this.explorerResolution = resolution;
    return true;
  }

  // Explore a specific PCA direction
  async exploreDirection(explorerData, domain, component, directionName, description, polarity = null, totalNeighborhoodSize = 100) {
    const directionKey = polarity ? `${domain}_${component}_${polarity}` : `${domain}_${polarity || component}`;

    try {
      const searchConfig = {
        resolution: this.explorerResolution || 'magnifying_glass',
        limit: 40
      };

      const candidates = await this.radialSearch.getPCADirectionalCandidates(
        this.currentTrack.identifier,
        domain,
        component,
        polarity || component,
        searchConfig
      );

      const trackCount = candidates.totalAvailable || 0;
      // Smart filtering: exclude played tracks, deprioritize actually seen tracks/artists/albums
      const smartFiltered = this.filterAndDeprioritizeCandidates(candidates.candidates || []);
      const sampleTracks = this.selectStrategicSamples(smartFiltered, this.currentTrack, 50);

      // Skip directions with 0 tracks (completely ignore them)
      if (trackCount === 0) {
        return;
      }

      // Skip directions that select nearly everything (useless)
      if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
        console.log(`🚫 Ignoring direction ${directionKey}: selects too many tracks (${trackCount}/${totalNeighborhoodSize})`);
        return; // Don't even add to explorerData
      }

      // Corrected diversity calculation based on neighborhood splitting
      const diversityScore = this.calculateDirectionDiversity(trackCount, totalNeighborhoodSize);

      // Outlier classification: < 3 tracks go to outlier section
      const isOutlier = trackCount < 3;

      explorerData.directions[directionKey] = {
        direction: directionName,
        description: description,
        domain: domain,
        component: component,
        polarity: polarity,
        trackCount: trackCount,
        totalNeighborhoodSize: totalNeighborhoodSize,
        sampleTracks: sampleTracks.map(track => ({
          identifier: track.track.identifier,
          title: track.track.title,
          artist: track.track.artist,
          albumCover: track.track.albumCover,
          duration: track.track.length,
          distance: track.distance,
          pca: track.track.pca
        })),
        diversityScore: diversityScore,
        isOutlier: isOutlier,
        splitRatio: totalNeighborhoodSize > 0 ? (trackCount / totalNeighborhoodSize) : 0
      };

      // Group outliers separately as requested
      if (isOutlier) {
        explorerData.outliers[directionKey] = explorerData.directions[directionKey];
      }

      console.log(`🎯 Direction ${directionKey}: ${trackCount}/${totalNeighborhoodSize} tracks, diversity: ${diversityScore.toFixed(1)}, ${isOutlier ? 'OUTLIER' : 'VALID'}`);

    } catch (error) {
      console.error(`Failed to explore direction ${directionKey}:`, error);
      explorerData.directions[directionKey] = {
        direction: directionName,
        description: description,
        domain: domain,
        component: component,
        polarity: polarity,
        trackCount: 0,
        totalNeighborhoodSize: totalNeighborhoodSize,
        sampleTracks: [],
        diversityScore: 0,
        isOutlier: true,
        error: error.message
      };
    }
  }

  // Explore original feature direction using legacy directional search
  async exploreOriginalFeatureDirection(explorerData, feature, polarity, totalNeighborhoodSize) {
    const direction = polarity === 'positive' ? feature.positive : feature.negative;
    const directionKey = `${feature.name}_${polarity}`;

    try {
      console.log(`🔍 CORE SEARCH: Starting legacy search for '${direction}' (feature: ${feature.name})`);
      console.log(`🔍 CORE SEARCH: Current track identifier: ${this.currentTrack.identifier}`);
      console.log(`🔍 CORE SEARCH: Calling this.radialSearch.getDirectionalCandidates('${this.currentTrack.identifier}', '${direction}')`);

      // Use legacy directional search for original features - get all candidates
      const candidates = await this.radialSearch.getDirectionalCandidates(
        this.currentTrack.identifier,
        direction
        // No limit - get all available candidates for strategic sampling
      );

      console.log(`🔍 CORE SEARCH RESULT: candidates object:`, candidates);
      console.log(`🔍 CORE SEARCH RESULT: candidates.totalAvailable = ${candidates.totalAvailable}`);
      console.log(`🔍 CORE SEARCH RESULT: candidates.candidates.length = ${candidates.candidates?.length || 'undefined'}`);

      if (candidates.candidates && candidates.candidates.length > 0) {
        console.log(`🔍 CORE SEARCH RESULT: First 3 candidates:`, candidates.candidates.slice(0, 3));
      } else {
        console.log(`🚨 CORE SEARCH PROBLEM: No candidates returned for '${direction}' - this should not happen for core features!`);
      }

      const trackCount = candidates.totalAvailable || 0;
      console.log(`🔍 CORE FILTERING: Before session filtering: ${candidates.candidates?.length || 0} candidates`);
      console.log(`🔍 CORE FILTERING: Session state - seenArtists: ${this.seenArtists.size}, seenAlbums: ${this.seenAlbums.size}, noArtist: ${this.noArtist}, noAlbum: ${this.noAlbum}`);

      const filteredCandidates = this.filterSessionRepeats(candidates.candidates || []);
      console.log(`🔍 CORE FILTERING: After session filtering: ${filteredCandidates.length} candidates`);

      if (candidates.candidates && candidates.candidates.length > 0 && filteredCandidates.length === 0) {
        console.log(`🚨 CORE FILTERING PROBLEM: Session filtering removed ALL candidates for '${direction}'!`);
        console.log(`🚨 This suggests too aggressive artist/album filtering or session history is too large`);
      }

      const sampleTracks = this.selectStrategicSamples(filteredCandidates, this.currentTrack, 50);
      console.log(`🔍 CORE SAMPLING: Selected ${sampleTracks.length} sample tracks from ${filteredCandidates.length} filtered candidates`);

      // Skip directions with 0 tracks (completely ignore them)
      if (trackCount === 0) {
        console.log(`🚫 CORE REJECTION: ${directionKey} selects ZERO tracks (${trackCount}/${totalNeighborhoodSize}) - [${feature.name}]`);
        console.log(`🔍 CORE DEBUG: candidates.totalAvailable=${candidates.totalAvailable}, candidates.candidates.length=${candidates.candidates?.length || 0}`);
        return;
      }

      // Skip directions that select nearly everything (useless)
      if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
        console.log(`🚫 CORE REJECTION: ${directionKey} selects TOO MANY tracks (${trackCount}/${totalNeighborhoodSize}) - [${feature.name}]`);
        return;
      }

      // Corrected diversity calculation based on neighborhood splitting
      const diversityScore = this.calculateDirectionDiversity(trackCount, totalNeighborhoodSize);

      // Outlier classification: < 3 tracks go to outlier section
      const isOutlier = trackCount < 3;

      explorerData.directions[directionKey] = {
        direction: direction,
        description: feature.description,
        domain: 'original',
        component: feature.name,
        polarity: polarity,
        trackCount: trackCount,
        totalNeighborhoodSize: totalNeighborhoodSize,
        sampleTracks: sampleTracks.map(track => ({
          identifier: track.identifier || track.track?.identifier,
          title: track.title || track.track?.title,
          artist: track.artist || track.track?.artist,
          duration: track.length || track.track?.length,
          distance: track.distance || track.similarity,
          features: track.features || track.track?.features,
          albumCover: track.albumCover || track.track?.albumCover
        })),
        diversityScore: diversityScore,
        isOutlier: isOutlier,
        splitRatio: totalNeighborhoodSize > 0 ? (trackCount / totalNeighborhoodSize) : 0,
      };

      // Group outliers separately as requested
      if (isOutlier) {
        console.log(`🚫 CORE OUTLIER: ${directionKey} has too few tracks (${trackCount} < 5) - marked as OUTLIER - [${feature.name}]`);
        explorerData.outliers[directionKey] = explorerData.directions[directionKey];
      } else {
        console.log(`✅ CORE VALID: ${directionKey} passes all checks - [${feature.name}]`);
      }

      console.log(`🎯 Original feature ${directionKey}: ${trackCount}/${totalNeighborhoodSize} tracks, diversity: ${diversityScore.toFixed(1)}, ${isOutlier ? 'OUTLIER' : 'VALID'} [${feature.name}]`);

    } catch (error) {
      console.error(`🚨 CORE SEARCH ERROR: Failed to explore original feature direction ${directionKey}:`, error);
      console.error(`🚨 CORE SEARCH ERROR: Full stack trace:`, error.stack);
      console.error(`🚨 CORE SEARCH ERROR: This suggests the legacy search method is broken or missing`);

      explorerData.directions[directionKey] = {
        direction: direction,
        description: feature.description,
        domain: 'original',
        component: feature.name,
        polarity: polarity,
        trackCount: 0,
        totalNeighborhoodSize: totalNeighborhoodSize,
        sampleTracks: [],
        diversityScore: 0,
        isOutlier: true,
        error: error.message
      };
    }
  }

  // Calculate diversity score based on neighborhood splitting
  // Optimal discriminator creates 75/25 split (clear direction + meaningful alternative)
  // 50/50 is acceptable, 95/5 or 5/95 is poor (no clear direction or no alternative)
  calculateDirectionDiversity(trackCount, totalNeighborhoodSize) {
    if (trackCount === 0 || totalNeighborhoodSize === 0) return 0;

    const ratio = trackCount / totalNeighborhoodSize;

    // Reward ratios that give us both direction and alternative
    // Peak scoring at 75/25 (0.75) and 25/75 (0.25)
    let score;

    if (ratio >= 0.70 && ratio <= 0.80) {
      // 70-80% range: ideal discriminator (clear majority + meaningful minority)
      score = 100 - Math.abs(ratio - 0.75) * 200; // Peak at 0.75
    } else if (ratio >= 0.20 && ratio <= 0.30) {
      // 20-30% range: good minority direction (meaningful alternative)
      score = 100 - Math.abs(ratio - 0.25) * 200; // Peak at 0.25
    } else if (ratio >= 0.45 && ratio <= 0.55) {
      // 45-55% range: balanced split (acceptable but less directional pull)
      score = 80 - Math.abs(ratio - 0.50) * 100; // Peak at 0.50, max 80 points
    } else if (ratio >= 0.30 && ratio <= 0.70) {
      // 30-70% range: decent discriminators
      const distanceFrom50 = Math.abs(ratio - 0.50);
      const distanceFrom75 = Math.min(Math.abs(ratio - 0.75), Math.abs(ratio - 0.25));
      score = 60 + (distanceFrom50 * 40) - (distanceFrom75 * 20);
    } else {
      // < 20% or > 80%: poor discriminators (too extreme)
      const extremeness = ratio < 0.20 ? (0.20 - ratio) : (ratio - 0.80);
      score = Math.max(0, 40 - (extremeness * 200));
    }

    return Math.max(0, Math.min(100, score));
  }

  calculateVariance(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  }

  // Strategic deduplication using "teaching value" - which direction benefits most from each track
  deduplicateTracksStrategically(directions) {
    // Phase 1: Collect all tracks from all directions and build priority-ordered stack list
    const allTracks = new Map(); // trackId -> track
    const stacks = []; // Array of {directionKey, direction, isPCA}

    // Gather all unique tracks
    Object.entries(directions).forEach(([directionKey, direction]) => {
      if (!direction.sampleTracks) return;

      // Classify direction type
      const isPCA = directionKey.includes('_pc') || directionKey.includes('primary_d');
      stacks.push({ directionKey, direction, isPCA });

      direction.sampleTracks.forEach(track => {
        const trackId = track.identifier || track.track?.identifier;
        if (trackId && !allTracks.has(trackId)) {
          allTracks.set(trackId, track.track || track);
        }
      });
    });

    // Sort stacks by priority: PCA first, then core
    stacks.sort((a, b) => {
      if (a.isPCA !== b.isPCA) {
        return a.isPCA ? -1 : 1; // PCA comes first
      }
      return 0; // Maintain order within same type
    });

    // Phase 2: Initialize empty stacks
    const finalDirections = {};
    stacks.forEach(stack => {
      finalDirections[stack.directionKey] = {
        ...stack.direction,
        sampleTracks: []
      };
    });

    // Phase 3: Breadth-first dealing - deal cards round-robin to stacks
    const maxCardsPerStack = 8;
    let dealtCount = 0;

    // Deal cards level by level (breadth-first)
    for (let level = 0; level < maxCardsPerStack; level++) {
      // For each stack at this level, try to deal one card
      for (let stackIndex = 0; stackIndex < stacks.length; stackIndex++) {
        const stack = stacks[stackIndex];

        // Skip if this stack is already full
        if (finalDirections[stack.directionKey].sampleTracks.length >= maxCardsPerStack) {
          continue;
        }

        // Find the next available track from this direction's original pool
        const availableTrack = stack.direction.sampleTracks.find(t => {
          const trackId = t.identifier || t.track?.identifier;
          // Check if this track hasn't been dealt yet
          return !Object.values(finalDirections).some(dir =>
            dir.sampleTracks.some(dealt =>
              (dealt.identifier || dealt.track?.identifier) === trackId
            )
          );
        });

        if (availableTrack) {
          finalDirections[stack.directionKey].sampleTracks.push(availableTrack.track || availableTrack);
          dealtCount++;
        }
      }
    }

    console.log(`🃏 Breadth-first dealing: ${dealtCount} cards dealt to ${stacks.length} stacks (PCA first, then core)`);

    return finalDirections;
  }


  // Helper: Extract dimensional value for a track given a direction key
  getTrackDimensionValue(track, directionKey) {
    // Handle PCA directions (e.g., 'spectral_pc1_positive', 'tonal_pc2_negative')
    const pcaMatch = directionKey.match(/^(tonal|spectral|rhythmic)_pc(\d+)_(positive|negative)$/);
    if (pcaMatch) {
      const [, domain, componentNum, polarity] = pcaMatch;
      const componentIndex = parseInt(componentNum) - 1; // pc1 -> 0, pc2 -> 1, pc3 -> 2

      if (track.pca && track.pca[domain]) {
        return track.pca[domain][componentIndex];
      }
      return null;
    }

    // Handle primary_d direction
    if (directionKey === 'primary_d_positive' || directionKey === 'primary_d_negative') {
      if (track.pca && track.pca.primary_d !== undefined) {
        return track.pca.primary_d;
      }
      return null;
    }

    // Handle traditional feature directions (faster/slower, brighter/darker, etc.)
    const featureMap = {
      'faster': 'bpm', 'slower': 'bpm',
      'brighter': 'spectral_centroid', 'darker': 'spectral_centroid',
      'more_energetic': 'energy', 'calmer': 'energy',
      'more_danceable': 'danceability', 'less_danceable': 'danceability',
      'more_tonal': 'harmony', 'more_atonal': 'harmony',
      'more_complex': 'spectral_complexity', 'simpler': 'spectral_complexity',
      'more_punchy': 'spectral_rolloff', 'smoother': 'spectral_rolloff',
      'denser_onsets': 'tempo', 'sparser_onsets': 'tempo'
    };

    const featureName = featureMap[directionKey];
    if (featureName && track.features && track.features[featureName] !== undefined) {
      return track.features[featureName];
    }

    return null; // Unknown dimension
  }

  // Debug: Check for duplicate cards across all stacks and validate dimension values
  debugDuplicateCards(directions) {
    const trackPositions = new Map(); // trackId -> [{direction, position, distance, value, dimValue}]
    const opposites = new Map(); // direction -> oppositeDirection

    // Build opposite direction mappings
    Object.keys(directions).forEach(dirKey => {
      const opposite = this.getOppositeDirection(dirKey);
      if (opposite && directions[opposite]) {
        opposites.set(dirKey, opposite);
      }
    });

    // Collect all track positions with dimension values
    Object.entries(directions).forEach(([dirKey, dirData]) => {
      dirData.sampleTracks?.forEach((track, position) => {
        const trackId = track.identifier || track.track?.identifier;
        if (!trackId) return;

        const fullTrack = track.track || track; // Handle nested track structure
        const dimValue = this.getTrackDimensionValue(fullTrack, dirKey);

        if (!trackPositions.has(trackId)) {
          trackPositions.set(trackId, []);
        }

        trackPositions.get(trackId).push({
          direction: dirKey,
          position: position,
          distance: track.distance,
          dimValue: dimValue,
          title: track.title || track.track?.title || 'Unknown',
          artist: track.artist || track.track?.artist || 'Unknown'
        });
      });
    });

    // Check for duplicates and validate dimension values
    let totalDuplicates = 0;
    let oppositeDuplicates = 0;
    let dimensionViolations = 0;

    trackPositions.forEach((positions, trackId) => {
      if (positions.length > 1) {
        totalDuplicates++;

        // Check if any duplicates are in opposite directions
        const hasOpposites = positions.some(pos1 =>
          positions.some(pos2 =>
            pos1.direction !== pos2.direction &&
            opposites.get(pos1.direction) === pos2.direction
          )
        );

        if (hasOpposites) {
          oppositeDuplicates++;

          // For opposite pairs, validate they differ by expected amount
          positions.forEach(pos1 => {
            const opposite = opposites.get(pos1.direction);
            const pos2 = positions.find(p => p.direction === opposite);

            if (pos2 && pos1.dimValue !== null && pos2.dimValue !== null) {
              const isNegativeDir = isNegativeDirection(pos1.direction);
              const expectedDifference = isNegativeDir ?
                pos2.dimValue - pos1.dimValue : // negative direction should have lower value
                pos1.dimValue - pos2.dimValue;  // positive direction should have higher value

              if (expectedDifference <= 0) {
                dimensionViolations++;
                console.error(`🎯❌ DIMENSION VIOLATION: "${pos1.title}" in ${pos1.direction} has value ${pos1.dimValue?.toFixed(3)}, in ${pos2.direction} has ${pos2.dimValue?.toFixed(3)} - expected separation!`);
              } else {
                console.log(`🎯✅ Dimension validated: "${pos1.title}" ${pos1.direction}=${pos1.dimValue?.toFixed(3)} vs ${pos2.direction}=${pos2.dimValue?.toFixed(3)} (diff: ${expectedDifference.toFixed(3)})`);
              }
            }
          });

          console.error(`🃏❌ OPPOSITE DUPLICATE: "${positions[0].title}" appears in opposite directions:`,
            positions.map(p => `${p.direction}[${p.position}] (dist: ${p.distance?.toFixed(3)}, dim: ${p.dimValue?.toFixed(3)})`).join(', ')
          );
        } else {
          console.log(`🃏⚠️  Cross-dimensional duplicate: "${positions[0].title}" in ${positions.length} stacks:`,
            positions.map(p => `${p.direction}[${p.position}] (dim: ${p.dimValue?.toFixed(3)})`).join(', ')
          );
        }
      }
    });

    console.log(`🃏 DUPLICATE SUMMARY: ${totalDuplicates} total duplicates, ${oppositeDuplicates} in opposite directions`);
    console.log(`🎯 DIMENSION SUMMARY: ${dimensionViolations} dimension violations found`);

    if (oppositeDuplicates > 0) {
      console.error(`🃏🚨 CRITICAL: Found ${oppositeDuplicates} tracks in opposite directions - radial search inner radius may be too small!`);
    }

    if (dimensionViolations > 0) {
      console.error(`🎯🚨 CRITICAL: Found ${dimensionViolations} dimension violations - tracks not properly separated by dimensional values!`);
    }
  }

  // Final deduplication: Each card appears in only one stack (highest position wins)
  finalDeduplication(directions) {
    const trackAssignments = new Map(); // trackId -> {bestDirection, bestPosition, track}

    // Find the best position for each track across all directions
    Object.entries(directions).forEach(([dirKey, dirData]) => {
      dirData.sampleTracks?.forEach((track, position) => {
        const trackId = track.identifier || track.track?.identifier;
        if (!trackId) return;

        const existing = trackAssignments.get(trackId);
        if (!existing || position < existing.bestPosition) {
          trackAssignments.set(trackId, {
            bestDirection: dirKey,
            bestPosition: position,
            track: track
          });
        }
      });
    });

    // Remove tracks from all stacks except their best position
    const finalDirections = {};
    Object.entries(directions).forEach(([dirKey, dirData]) => {
      finalDirections[dirKey] = {
        ...dirData,
        sampleTracks: dirData.sampleTracks?.filter(track => {
          const trackId = track.identifier || track.track?.identifier;
          if (!trackId) return false;
          const assignment = trackAssignments.get(trackId);
          return assignment && assignment.bestDirection === dirKey;
        }) || []
      };
    });

    console.log(`🃏 FINAL DEDUPLICATION: Removed duplicates, each card appears in exactly one stack`);
    return finalDirections;
  }

  // ⚖️ Prioritize bidirectional directions: larger stack becomes primary, smaller becomes opposite
  prioritizeBidirectionalDirections(directions) {
    console.log(`⚖️ PRIORITIZATION START: Processing ${Object.keys(directions).length} directions`);
    console.log(`⚖️ Direction keys:`, Object.keys(directions));

    const pairs = new Map(); // baseKey -> {positive: dirData, negative: dirData}
    const processedKeys = new Set();
    const finalDirections = {};

    // Group directions into bidirectional pairs
    Object.entries(directions).forEach(([directionKey, directionData]) => {
      // Skip if already processed as part of a pair
      if (processedKeys.has(directionKey)) return;

      // Check for bidirectional pairs (positive/negative)
      const positiveMatch = directionKey.match(/^(.+)_positive$/);
      const negativeMatch = directionKey.match(/^(.+)_negative$/);

      console.log(`⚖️ CHECKING: ${directionKey} -> positive: ${!!positiveMatch}, negative: ${!!negativeMatch}`);

      if (positiveMatch) {
        const baseKey = positiveMatch[1];
        const negativeKey = `${baseKey}_negative`;

        const positiveData = directionData;
        const negativeData = directions[negativeKey] || directionData.oppositeDirection;

        if (negativeData) {
          const parseCount = (direction) => {
            const raw = direction?.trackCount;
            const numeric = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(numeric) || numeric <= 0) {
              return direction?.sampleTracks?.length || 0;
            }
            return numeric;
          };

          const positiveSamples = positiveData.sampleTracks?.length || 0;
          const negativeSamples = negativeData.sampleTracks?.length || 0;
          const positiveCount = parseCount(positiveData);
          const negativeCount = parseCount(negativeData);

          console.log(`⚖️ BIDIRECTIONAL PAIR: ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

          let primaryDirection, oppositeDirection, primaryKey, oppositeKey;

          if (positiveSamples > negativeSamples || (positiveSamples === negativeSamples && positiveCount >= negativeCount)) {
            primaryDirection = positiveData;
            oppositeDirection = negativeData;
            primaryKey = directionKey;
            oppositeKey = negativeKey;
          } else if (negativeSamples > positiveSamples || (negativeSamples === positiveSamples && negativeCount > positiveCount)) {
            primaryDirection = negativeData;
            oppositeDirection = positiveData;
            primaryKey = negativeKey;
            oppositeKey = directionKey;
          } else {
            console.log(`⚖️ Equal sizes (${positiveSamples} samples), preferring positive for ${baseKey}`);
            primaryDirection = positiveData;
            oppositeDirection = negativeData;
            primaryKey = directionKey;
            oppositeKey = negativeKey;
          }

          finalDirections[primaryKey] = {
            ...primaryDirection,
            hasOpposite: true,
            oppositeDirection: {
              ...oppositeDirection,
              key: oppositeKey,
              hasOpposite: true
            }
          };

          console.log(`⚖️ PRIMARY: ${primaryKey} (${primaryDirection.sampleTracks?.length || 0} tracks) with embedded opposite ${oppositeKey} (${oppositeDirection.sampleTracks?.length || 0} tracks)`);

          processedKeys.add(directionKey);
          processedKeys.add(negativeKey);
        } else {
          console.log(`⚖️ BIDIRECTIONAL PAIR: nothing found for negative ${negativeKey}`);
          finalDirections[directionKey] = {
            ...directionData,
            hasOpposite: directionData.oppositeDirection ? true : directionData.hasOpposite
          };
          processedKeys.add(directionKey);
        }
      } else if (negativeMatch) {
        const baseKey = negativeMatch[1];
        const positiveKey = `${baseKey}_positive`;

        if (directions[positiveKey]) {
          return;
        }

        const positiveData = directionData.oppositeDirection || directions[positiveKey];
        if (positiveData) {
          console.log(`⚖️ NEGATIVE MATCH using embedded positive for ${baseKey}`);

          const parseCount = (direction) => {
            const raw = direction?.trackCount;
            const numeric = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(numeric) || numeric <= 0) {
              return direction?.sampleTracks?.length || 0;
            }
            return numeric;
          };

          const positiveSamples = positiveData.sampleTracks?.length || 0;
          const negativeSamples = directionData.sampleTracks?.length || 0;
          const positiveCount = parseCount(positiveData);
          const negativeCount = parseCount(directionData);

          console.log(`⚖️ BIDIRECTIONAL PAIR (negative first): ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

          let primaryDirection, oppositeDirection, primaryKey, oppositeKey;
          if (negativeSamples > positiveSamples || (negativeSamples === positiveSamples && negativeCount >= positiveCount)) {
            primaryDirection = directionData;
            oppositeDirection = positiveData;
            primaryKey = directionKey;
            oppositeKey = positiveKey;
          } else {
            primaryDirection = positiveData;
            oppositeDirection = directionData;
            primaryKey = positiveKey;
            oppositeKey = directionKey;
          }

          finalDirections[primaryKey] = {
            ...primaryDirection,
            hasOpposite: true,
            oppositeDirection: {
              ...oppositeDirection,
              key: oppositeKey,
              hasOpposite: true
            }
          };

          processedKeys.add(directionKey);
          processedKeys.add(positiveKey);
        } else {
          console.log(`⚖️ BIDIRECTIONAL PAIR: nothing found for positive ${positiveKey}`);
          finalDirections[directionKey] = {
            ...directionData,
            hasOpposite: directionData.oppositeDirection ? true : directionData.hasOpposite
          };
          processedKeys.add(directionKey);
        }
      } else {
        finalDirections[directionKey] = directionData;
        processedKeys.add(directionKey);
      }
    });

    console.log(`⚖️ BIDIRECTIONAL PRIORITIZATION: Processed ${Object.keys(directions).length} dimensions -> ${Object.keys(finalDirections).length} final dimensions`);
    return finalDirections;
  }

  // Assign tracks exclusively to their best-fitting directions (legacy method)
  deduplicateTracksAcrossDirections(directions) {
    // Collect all track-direction assignments with scores
    const trackAssignments = new Map(); // trackId -> [{directionKey, score}, ...]

    // Collect all candidates from all directions
    Object.entries(directions).forEach(([directionKey, directionInfo]) => {
      if (directionInfo.sampleTracks) {
        directionInfo.sampleTracks.forEach(track => {
          const trackId = track.identifier || track.track?.identifier;
          if (!trackId) return;

          if (!trackAssignments.has(trackId)) {
            trackAssignments.set(trackId, []);
          }

          // Use diversity score or distance as assignment score (higher = better fit)
          const score = track.diversityScore || (1 / (track.distance || 1));
          trackAssignments.get(trackId).push({
            directionKey,
            score,
            track: track.track || track
          });
        });
      }
    });

    // Assign each track to its best-fitting direction
    const exclusiveDirections = {};
    Object.keys(directions).forEach(key => {
      exclusiveDirections[key] = {
        ...directions[key],
        sampleTracks: []
      };
    });

    trackAssignments.forEach((assignments, trackId) => {
      // Find the direction with the highest score for this track
      const bestAssignment = assignments.sort((a, b) => b.score - a.score)[0];

      // Add track only to its best-fitting direction
      exclusiveDirections[bestAssignment.directionKey].sampleTracks.push(bestAssignment.track);
    });

    console.log(`🎯 Deduplication complete: ${trackAssignments.size} unique tracks distributed across ${Object.keys(directions).length} directions`);

    return exclusiveDirections;
  }

  // Limit directions to top N dimensions with quota system ensuring 1/3 are core indices
  limitToTopDimensions(directions, maxDimensions = 12) {
    // Define core indices that should be prioritized
    const coreIndices = [
      'bpm', 'danceability', 'onset_rate', 'beat_punch', 'tonal_clarity',
      'spectral_centroid', 'spectral_energy', 'sub_drive', 'air_sizzle',
      'chord_strength', 'tuning_purity', 'fifths_strength'
    ];
    console.log(`📊 Defined core indices: [${coreIndices.join(', ')}]`);

    const dimensionMap = new Map();
    const coreMap = new Map();
    const pcaMap = new Map();

    // Group directions by their base dimension and classify as core or PCA
    console.log(`🔍 Processing ${Object.keys(directions).length} directions for dimension classification...`);
    Object.entries(directions).forEach(([key, directionInfo]) => {
      let dimensionName = key;
      console.log(`🔍 Processing direction: ${key}`);

      // Extract base dimension by removing common suffixes
      const suffixes = ['_positive', '_negative', '_pc1', '_pc2', '_pc3'];
      for (const suffix of suffixes) {
        if (dimensionName.endsWith(suffix)) {
          dimensionName = dimensionName.replace(suffix, '');
          console.log(`🔍   Extracted base dimension: ${dimensionName} (removed ${suffix})`);
          break;
        }
      }

      const directionObj = { key, ...directionInfo };

      // Classify as core or PCA dimension
      const isCore = coreIndices.includes(dimensionName);
      console.log(`🔍   Is '${dimensionName}' a core index? ${isCore}`);
      if (isCore) {
        console.log(`✅   Adding '${dimensionName}' to CORE map`);
      } else {
        console.log(`🧮   Adding '${dimensionName}' to PCA map`);
      }
      const targetMap = isCore ? coreMap : pcaMap;

      if (!targetMap.has(dimensionName)) {
        targetMap.set(dimensionName, []);
      }
      targetMap.get(dimensionName).push(directionObj);

      // Also add to general map for fallback
      if (!dimensionMap.has(dimensionName)) {
        dimensionMap.set(dimensionName, []);
      }
      dimensionMap.get(dimensionName).push(directionObj);
    });

    console.log(`🔍 Classification complete:`);
    console.log(`🔍   Core indices found: [${Array.from(coreMap.keys()).join(', ')}]`);
    console.log(`🔍   PCA indices found: [${Array.from(pcaMap.keys()).join(', ')}]`);
    console.log(`🔍   Total dimensions: [${Array.from(dimensionMap.keys()).join(', ')}]`);

    const selectedDirections = {};

    // Calculate quota: 50/50 split between core and PCA indices
    const coreQuota = Math.floor(maxDimensions / 2);
    const pcaQuota = maxDimensions - coreQuota;

    console.log(`🎯 Dimension quota: ${coreQuota} core indices, ${pcaQuota} PCA dimensions (max: ${maxDimensions})`);
    console.log(`🎯 Available dimensions: ${coreMap.size} core, ${pcaMap.size} PCA, ${dimensionMap.size} total`);

    // Helper function to select best directions from dimension list
    // Returns both directions if they form a good discriminator (75/25 split)
    const selectBestDirections = (dirList, dimName = 'unknown') => {
      console.log(`🔍 selectBestDirections for '${dimName}': ${dirList.length} total directions`);
      dirList.forEach((dir, i) => {
        console.log(`🔍   [${i}] ${dir.key}: ${dir.trackCount} tracks, outlier: ${dir.isOutlier}, diversity: ${dir.diversityScore?.toFixed(1) || 'N/A'}`);
      });

      const validDirs = dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier);
      console.log(`🔍   -> ${validDirs.length} valid directions after filtering`);

      if (validDirs.length === 0) {
        console.log(`🚫   -> NO VALID DIRECTIONS for '${dimName}'`);
        return [];
      }

      // Sort by diversity score
      const sortedDirs = validDirs.sort((a, b) => {
        if (Math.abs(a.diversityScore - b.diversityScore) < 0.1) {
          return b.trackCount - a.trackCount; // Prefer larger if diversity is similar
        }
        return b.diversityScore - a.diversityScore; // Higher diversity wins
      });

      // Check if we have a good discriminator (both directions score well)
      const threshold = 10; // Lower threshold - if both directions have tracks, they likely form a discriminator
      const topDirection = sortedDirs[0];

      if (sortedDirs.length >= 2) {
        const secondDirection = sortedDirs[1];

        // If both directions have decent diversity scores, keep both (good discriminator)
        // The key insight: if both directions exist with tracks, they likely form a meaningful split
        if (topDirection.diversityScore >= threshold && secondDirection.diversityScore >= threshold) {
          console.log(`✅   -> Good discriminator for '${dimName}': keeping both directions`);
          console.log(`✅     Primary: '${topDirection.key}' (${topDirection.trackCount} tracks, diversity: ${topDirection.diversityScore?.toFixed(1)})`);
          console.log(`✅     Secondary: '${secondDirection.key}' (${secondDirection.trackCount} tracks, diversity: ${secondDirection.diversityScore?.toFixed(1)})`);
          return [topDirection, secondDirection];
        }
      }

      // Otherwise, just return the best direction
      console.log(`✅   -> Selected single direction '${topDirection.key}' for '${dimName}': ${topDirection.trackCount} tracks, diversity: ${topDirection.diversityScore?.toFixed(1)}`);
      return [topDirection];
    };

    // Step 1: Select core indices (guaranteed quota)
    console.log(`🎯 Core indices available:`, Array.from(coreMap.keys()));
    console.log(`🎯 Core indices with valid directions:`,
      Array.from(coreMap.entries())
        .map(([dimName, dirList]) => ({
          dimName,
          validDirections: dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier).length,
          totalDirections: dirList.length
        }))
    );

    const sortedCoreDimensions = Array.from(coreMap.entries())
      .map(([dimName, dirList]) => ({
        dimName,
        bestDirections: selectBestDirections(dirList, dimName),
        isCore: true,
        allDirections: dirList.length,
        validDirections: dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier).length
      }))
      .filter(dim => {
        if (dim.bestDirections.length === 0) {
          console.log(`🚫 Core dimension '${dim.dimName}' has no valid directions (${dim.validDirections}/${dim.allDirections})`);
          return false;
        }
        return true;
      })
      .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
      .slice(0, coreQuota);

    console.log(`🎯 Selected ${sortedCoreDimensions.length}/${coreQuota} core dimensions:`,
      sortedCoreDimensions.map(d => `${d.dimName} (${d.bestDirections.length} directions, primary diversity: ${d.bestDirections[0].diversityScore.toFixed(1)})`));

    // Step 2: Select PCA/other dimensions for remaining slots
    const sortedPcaDimensions = Array.from(pcaMap.entries())
      .map(([dimName, dirList]) => ({
        dimName,
        bestDirections: selectBestDirections(dirList, dimName),
        isCore: false
      }))
      .filter(dim => dim.bestDirections.length > 0) // Only dimensions with valid directions
      .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
      .slice(0, pcaQuota);

    console.log(`🎯 Selected ${sortedPcaDimensions.length} PCA dimensions:`,
      sortedPcaDimensions.map(d => d.dimName));

    // Combine core and PCA selections
    const finalDimensions = [...sortedCoreDimensions, ...sortedPcaDimensions];

    // If we don't have enough dimensions (shouldn't happen), fill from general pool
    if (finalDimensions.length < maxDimensions) {
      const usedDimensions = new Set(finalDimensions.map(d => d.dimName));
      const remainingDimensions = Array.from(dimensionMap.entries())
        .filter(([dimName]) => !usedDimensions.has(dimName))
        .map(([dimName, dirList]) => ({
          dimName,
          bestDirections: selectBestDirections(dirList, dimName),
          isCore: false
        }))
        .filter(dim => dim.bestDirections.length > 0)
        .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
        .slice(0, maxDimensions - finalDimensions.length);

      finalDimensions.push(...remainingDimensions);
    }

    // Build final directions object - only send primary direction but store opposite info
    finalDimensions.forEach(({ bestDirections }) => {
      const primaryDirection = bestDirections[0]; // Most populous direction
      const hasOpposite = bestDirections.length > 1; // Whether opposite exists

      selectedDirections[primaryDirection.key] = {
        direction: primaryDirection.direction,
        description: primaryDirection.description,
        domain: primaryDirection.domain,
        component: primaryDirection.component,
        polarity: primaryDirection.polarity,
        trackCount: primaryDirection.trackCount,
        totalNeighborhoodSize: primaryDirection.totalNeighborhoodSize,
        sampleTracks: primaryDirection.sampleTracks,
        diversityScore: primaryDirection.diversityScore,
        isOutlier: primaryDirection.isOutlier,
        splitRatio: primaryDirection.splitRatio,
        hasOpposite: hasOpposite, // Flag for frontend Uno Reverse
        oppositeDirection: hasOpposite ? bestDirections[1] : null // Store opposite for Uno Reverse
      };
    });

    console.log(`🎯 Selected ${finalDimensions.length} dimensions producing ${Object.keys(selectedDirections).length} total directions`);
    return selectedDirections;
  }

  // Calculate overall explorer diversity metrics
  calculateExplorerDiversityMetrics(directions) {
    const directionEntries = Object.entries(directions);
    const validDirections = directionEntries.filter(([_, dir]) => dir.trackCount > 0);

    return {
      totalDirections: directionEntries.length,
      validDirections: validDirections.length,
      averageDiversityScore: validDirections.length > 0 ?
        validDirections.reduce((sum, [_, dir]) => sum + dir.diversityScore, 0) / validDirections.length : 0,
      highestDiversityDirection: validDirections.length > 0 ?
        validDirections.reduce((best, [key, dir]) =>
          dir.diversityScore > best[1].diversityScore ? [key, dir] : best
        )[0] : null,
      totalAvailableTracks: directionEntries.reduce((sum, [_, dir]) => sum + dir.trackCount, 0)
    };
  }

  // Select next track based on weighted diversity score favoring original features
  async selectNextTrackFromExplorer(explorerData) {
    const validDirections = Object.entries(explorerData.directions)
      .filter(([_, dir]) => dir.trackCount > 0 && !dir.isOutlier)
      .map(([key, dir]) => {
        // Weight original features higher due to their real data value and user familiarity
        const isOriginalFeature = dir.domain === 'original';
        const weightedScore = isOriginalFeature ?
          dir.diversityScore * 1.5 : // 50% bonus for original features
          dir.diversityScore;

        return [key, { ...dir, weightedDiversityScore: weightedScore }];
      })
      .sort((a, b) => b[1].weightedDiversityScore - a[1].weightedDiversityScore);

    if (validDirections.length === 0) {
      // Fallback to any available track from outliers
      const anyDirection = Object.values(explorerData.directions)
        .find(dir => dir.sampleTracks.length > 0);

      if (anyDirection) {
        return {
          ...anyDirection.sampleTracks[0],
          nextTrackDirection: anyDirection.direction,
          transitionReason: 'autopilot', // Stuck in a zone, using outliers
          diversityScore: anyDirection.diversityScore,
          directionKey: Object.keys(explorerData.directions).find(key =>
            explorerData.directions[key] === anyDirection
          )
        };
      }
      return null;
    }

    // Select from highest diversity direction
    const [bestDirectionKey, bestDirection] = validDirections[0];
    const selectedTrack = bestDirection.sampleTracks[0]; // First track in the list

    const weightedScore = bestDirection.weightedDiversityScore || bestDirection.diversityScore;
    const domainLabel = bestDirection.domain === 'original' ? '📊 Original' : '🧮 PCA';
    const componentDetail = bestDirection.domain !== 'original' ?
      ` [${bestDirection.domain}_${bestDirection.component}_${bestDirection.polarity}]` :
      ` [${bestDirection.component}_${bestDirection.polarity}]`;
    console.log(`🎯 Next track selected from direction '${bestDirection.direction}'${componentDetail} (${domainLabel}, weighted diversity: ${weightedScore.toFixed(1)})`);

    return {
      ...selectedTrack,
      nextTrackDirection: bestDirection.direction,
      transitionReason: 'explorer', // Roaming free based on diversity
      diversityScore: bestDirection.diversityScore,
      weightedDiversityScore: bestDirection.weightedDiversityScore,
      domain: bestDirection.domain,
      directionKey: bestDirectionKey,
      directionDescription: bestDirection.description
    };
  }

  // Calculate session diversity based on history
  calculateSessionDiversity() {
    if (this.sessionHistory.length < 2) return 0;

    // Measure diversity as variance in PCA space across session history
    const recentTracks = this.sessionHistory.slice(-10); // Last 10 tracks
    let diversityScore = 0;

    // Calculate variance in primary discriminator
    const primaryDValues = recentTracks
      .filter(t => t.pca && t.pca.primary_d)
      .map(t => t.pca.primary_d);

    if (primaryDValues.length > 1) {
      diversityScore = this.calculateVariance(primaryDValues) * 10;
    }

    return Math.min(diversityScore, 100); // Normalized to 0-100
  }

  // Legacy explorer data for non-PCA tracks
  async getLegacyExplorerData() {
    const directions = [
      'brighter', 'darker', 'faster', 'slower', 'more_complex', 'simpler',
      'more_energetic', 'calmer', 'more_danceable', 'less_danceable',
      'more_tonal', 'more_atonal', 'more_punchy', 'less_punchy',
      'denser_onsets', 'sparser_onsets', 'purer_tuning', 'impurer_tuning',
      'stronger_chords', 'weaker_chords', 'more_air_sizzle', 'less_air_sizzle'
    ];

    const explorerData = {
      directions: {},
      outliers: {},
      nextTrack: null,
      diversityMetrics: { legacy: true }
    };

    // Get candidates for each legacy direction
    for (const direction of directions) {
      try {
        const candidates = await this.radialSearch.getDirectionalCandidates(
          this.currentTrack.identifier,
          direction
          // No limit - get all available candidates
        );

        const trackCount = candidates.totalAvailable || 0;
        const filteredCandidates = this.filterSessionRepeats(candidates.candidates || []);
        const sampleTracks = this.selectStrategicSamples(filteredCandidates, this.currentTrack, 50);

        // Skip directions with 0 tracks (completely ignore them)
        if (trackCount === 0) {
          continue;
        }

        explorerData.directions[direction] = {
          direction: direction,
          description: `Legacy ${direction} direction`,
          trackCount: trackCount,
          sampleTracks: sampleTracks.map(track => ({
            identifier: track.identifier,
            title: track.title,
            artist: track.artist,
            duration: track.length,
            distance: track.distance || track.similarity
          })),
          diversityScore: Math.random() * 50, // Placeholder diversity
          isOutlier: trackCount < 10
        };

        if (trackCount < 10) {
          explorerData.outliers[direction] = explorerData.directions[direction];
        }

      } catch (error) {
        console.error(`Failed to get legacy candidates for ${direction}:`, error);
        explorerData.directions[direction] = {
          direction: direction,
          trackCount: 0,
          sampleTracks: [],
          diversityScore: 0,
          isOutlier: true
        };
      }
    }

    // Select next track from direction with most candidates
    const directionEntries = Object.entries(explorerData.directions)
      .filter(([key, dir]) => dir.sampleTracks.length > 0)
      .sort(([keyA, dirA], [keyB, dirB]) => dirB.trackCount - dirA.trackCount);

    // Format nextTrack with directionKey and track properties for UI
    if (directionEntries.length > 0) {
      const [bestDirectionKey, bestDirection] = directionEntries[0];
      explorerData.nextTrack = {
        directionKey: bestDirectionKey,
        direction: bestDirection.direction,
        track: bestDirection.sampleTracks[0]
      };
    } else {
      explorerData.nextTrack = null;
    }

    return explorerData;
  }

  // Reset the drift (like page reload)
  resetDrift() {
    console.log('🔄 Resetting drift...');
    this.driftPlayer.reset();

    if (this.currentProcess) {
      this.currentProcess.kill();
    }

    if (this.isActive) {
      this.startDriftPlayback();
    }
  }

  // Trigger user-directed flow (immediate transition)
  async triggerDirectionalFlow(direction) {
    console.log(`🎛️ User directed flow: ${direction}`);

    // Set the new direction
    this.driftPlayer.currentDirection = direction;

    // Broadcast direction change event
    this.broadcastEvent({
      type: 'direction_change',
      timestamp: Date.now(),
      direction: direction,
      trigger: 'user'
    });

    // Immediately transition to a track in that direction
    this.triggerGaplessTransition();
  }

  // Get current session/drift stats
  getStats() {
    const driftState = this.driftPlayer.getDriftState();

    return {
      sessionId: this.sessionId,
      clients: this.clients.size,
      isActive: this.isActive,
      isDriftMode: true,
      currentTrack: this.currentTrack ? {
        title: this.currentTrack.title,
        artist: this.currentTrack.artist,
        identifier: this.currentTrack.identifier
      } : null,
      nextTrack: this.nextTrack ? {
        title: this.nextTrack.title,
        artist: this.nextTrack.artist,
        identifier: this.nextTrack.identifier
      } : null,
      driftDirection: driftState.currentDirection,
      stepCount: driftState.stepCount,
      recentHistory: driftState.recentHistory
    };
  }

  // Get the adjusted track duration from advanced audio mixer
  getAdjustedTrackDuration() {
    // Try to get the adjusted duration from the advanced audio mixer
    const mixerStatus = this.audioMixer.getStatus();
    if (mixerStatus.currentTrack.estimatedDuration) {
      console.log(`📏 Using adjusted track duration: ${mixerStatus.currentTrack.estimatedDuration.toFixed(1)}s (original: ${this.currentTrack.length}s)`);
      return mixerStatus.currentTrack.estimatedDuration;
    }

    // Fallback to original duration if mixer doesn't have adjusted duration yet
    console.log(`📏 Using original track duration: ${this.currentTrack.length}s (mixer not ready)`);
    return this.currentTrack.length;
  }

  // Clean up
  destroy() {
    console.log(`🧹 Destroying drift mixer for session: ${this.sessionId}`);
    this.stopStreaming();

    if (this.pendingUserSelectionTimer) {
      clearTimeout(this.pendingUserSelectionTimer);
      this.pendingUserSelectionTimer = null;
    }

    this.pendingPreparationPromise = null;
    this.isUserSelectionPending = false;

    // Destroy advanced mixer
    this.audioMixer.destroy();

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.end();
      } catch (err) {
        // Ignore errors when closing
      }
    }
    this.clients.clear();
  }
}

module.exports = DriftAudioMixer;
