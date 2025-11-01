const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { setImmediate: setImmediatePromise } = require('timers/promises');
const DirectionalDriftPlayer = require('./directional-drift-player');
const AdvancedAudioMixer = require('./advanced-audio-mixer');
const fingerprintRegistry = require('./fingerprint-registry');

const VERBOSE_EXPLORER = process.env.LOG_EXPLORER === '1';
const VERBOSE_CACHE = process.env.LOG_CACHE === '1';

function explorerLog(...args) {
  if (VERBOSE_EXPLORER) {
    console.log(...args);
  }
}

function cacheLog(...args) {
  if (VERBOSE_CACHE) {
    console.log(...args);
  }
}

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const CROSSFADE_GUARD_MS = 6000;

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
    this.pendingCurrentTrack = null;
    this.nextTrack = null;
    this.trackStartTime = null;
    this.isTransitioning = false;
    this._lastBroadcastTrackId = null;
    this.lastTrackEventPayload = null;
    this.lastTrackEventTimestamp = 0;

    // Session history and exploration data
    this.sessionHistory = []; // Array of previous tracks with timestamps and metadata
    this.maxHistorySize = 50; // Keep last 50 tracks in history

    // Stack-based journey state (Named Sessions)
    this.stack = []; // Journey as sequence of {identifier, direction, scope} objects
    this.stackIndex = 0; // Current position in stack (0-indexed)
    this.positionSeconds = 0; // Position within current track
    this.ephemeral = false; // true = stop persisting changes (past end of stack)
    this.sessionType = 'anonymous'; // 'anonymous', 'named', 'playlist'
    this.sessionName = null; // Session identifier for named/playlist sessions

    // Session-level filtering flags
    this.noAlbum = true; // Default: prevent album repeats in session
    this.noArtist = true; // Default: prevent artist repeats in session
    this.seenArtists = new Set(); // Track artists from played tracks
    this.seenAlbums = new Set(); // Track albums from played tracks

    // Session-level explorer data cache for layered search
    this.explorerDataCache = new Map(); // key: 'trackMd5_resolution' -> explorerData

    // Track exposure: tracks the user has actually SEEN (displayed on top of stacks or selected)
    this.seenTracks = new Set(); // Track IDs that were displayed (top of stack OR selected as next track)
    this.seenTrackArtists = new Set(); // Artists from seen tracks
    this.seenTrackAlbums = new Set(); // Albums from seen tracks
    this.pendingUserOverrideDirection = null; // Persist direction metadata until override hydrates
    this.pendingUserOverrideTrackId = null; // Track identifier awaiting override preparation
    this.pendingUserOverrideGeneration = null; // Generation id for the in-flight manual override
    this.manualSelectionGeneration = 0; // Bumps per-track whenever the user requests an override
    this.autoRecoveryTimer = null; // Timer handle for auto requeue after failure

    // Broadcast caching for lean event comms
    this.lastHeartbeatPayload = null;
    this.lastHeartbeatSerialized = null;
    this.lastHeartbeatTimestamp = 0;
    this.lastExplorerSnapshotPayload = null;
    this.lastExplorerSnapshotSerialized = null;
    this.lastExplorerSnapshotTimestamp = 0;

    // Cleanup callback supplied by session manager
    this.onIdle = null;
    this.cleanupTimer = null;

    // Explorer configuration
    this.explorerResolution = 'magnifying_glass';

    // Track loading state to prevent concurrent playCurrentTrack calls
    this.currentTrackLoadingPromise = null; // Seeding vs seeded distinction
    this.visualCurrentTrack = null;
    this.visualTrackStartTime = null;
    this.pendingVisualCurrentTrack = null;
    this.pendingVisualTrackStartTime = null;

    // Audio configuration
    this.sampleRate = config.audio.sampleRate;
    this.channels = config.audio.channels;
    this.bitRate = config.audio.bitRate;

    // Initialize advanced audio mixer
    this.audioMixer = new AdvancedAudioMixer({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitRate: this.bitRate
    });

    const explorerConfig = config.explorer || {};
    const totalCount = explorerConfig.stackTotalCount;
    const randomCount = explorerConfig.stackRandomCount;
    this.stackTotalCount = Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 15;
    this.stackRandomCount = Number.isFinite(randomCount) && randomCount >= 0
      ? Math.min(Math.floor(randomCount), this.stackTotalCount)
      : Math.min(3, this.stackTotalCount);

    // Set up mixer callbacks
    this.audioMixer.onData = (chunk) => {
      this.broadcastToClients(chunk);
    };

    // Provide client count checker to avoid streaming to nobody
    this.audioMixer.hasClients = () => {
      return this.clients.size > 0;
    };

    this.audioMixer.onTrackStart = (reason) => {
      console.log(`🎵 Advanced mixer: Track started (${reason || 'normal'})`);

      let promoted = false;

      if (this.pendingCurrentTrack) {
        this.currentTrack = this.pendingCurrentTrack;
        this.pendingCurrentTrack = null;
        promoted = true;
      } else if (reason === 'crossfade_complete' && this.nextTrack) {
        this.currentTrack = this.hydrateTrackRecord(this.nextTrack) || this.nextTrack;
        this.nextTrack = null;
        promoted = true;
      }

      // Handle stack initialization for first track
      if (promoted && this.currentTrack && this.currentTrack.identifier) {
        this.ensureTrackInStack(this.currentTrack.identifier);
      }

      if (promoted && this.currentTrack && this.lockedNextTrackIdentifier === this.currentTrack.identifier) {
        this.lockedNextTrackIdentifier = null;
      }

      if (promoted) {
        this.resetManualOverrideLock();
      }

      if (reason === 'crossfade_complete') {
        this.crossfadeStartedAt = null;
        const shouldReapplyOverride = this.userSelectionDeferredForCrossfade && this.pendingUserOverrideTrackId;
        this.userSelectionDeferredForCrossfade = false;
        if (shouldReapplyOverride) {
          setTimeout(() => {
            this.applyUserSelectedTrackOverride(this.pendingUserOverrideTrackId);
          }, 0);
        }
      }

      if (reason !== 'crossfade_complete') {
        this.crossfadeStartedAt = null;
        this.userSelectionDeferredForCrossfade = false;
      }

      const engineStartTime = this.audioMixer?.engine?.streamingStartTime;
      this.trackStartTime = engineStartTime || Date.now();
      const visualStartTime = this.pendingVisualTrackStartTime || this.trackStartTime;
      this.setDisplayCurrentTrack(this.currentTrack, { startTime: visualStartTime });
      this.pendingVisualCurrentTrack = null;
      this.pendingVisualTrackStartTime = null;

      if (!this.currentTrack) {
        console.warn('📡 Track started but currentTrack is undefined; pending metadata may be missing');
        return;
      }

      const identifier = this.currentTrack.identifier || null;
      if (identifier) {
        const fingerprint = fingerprintRegistry.rotateFingerprint(
          this.sessionId,
          {
            trackId: identifier,
            startTime: this.trackStartTime
          }
        );
        this.currentFingerprint = fingerprint;
      }

      console.log(`📡 Audio started - now broadcasting track event: ${this.currentTrack.title}`);
      this.broadcastTrackEvent(true, { reason: reason || 'track-started' }).catch(err => {
        console.error('📡 Failed to broadcast track event:', err);
      });

      // Kick off next-track preparation immediately so UI has a recommendation
      this.prepareNextTrackForCrossfade({ reason: 'auto-initial' }).catch(err => {
        console.warn('⚠️ Initial auto prepare failed:', err?.message || err);
      });
    };

    this.audioMixer.onTrackEnd = () => {
      console.log('🎵 Advanced mixer: Track ended');
      // Automatically load next track
      this.crossfadeStartedAt = null;
      this.loadNextTrackIntoMixer();
    };

    this.audioMixer.onCrossfadeStart = (info) => {
      console.log(`🔄 Advanced mixer: Crossfade started (${info.currentBPM} → ${info.nextBPM} BPM)`);
      this.crossfadeStartedAt = Date.now();
      this.pendingVisualCurrentTrack = this.nextTrack
        ? this.hydrateTrackRecord(this.nextTrack) || this.nextTrack
        : null;
      this.pendingVisualTrackStartTime = this.crossfadeStartedAt;
    };

    this.audioMixer.onError = (error) => {
      console.error('🚨 Advanced mixer error:', error);
      this.fallbackToNoise();
    };

    // User override handling
    this.userSelectionDebounceMs = 5000; // milliseconds to coalesce rapid selections
    this.pendingUserSelectionTimer = null;
    this.pendingUserSelectionResolve = null;
    this.isUserSelectionPending = false;

    // Keep user's chosen track locked until it becomes current
    this.lockedNextTrackIdentifier = null;

    // Track preparation coordination
    this.pendingPreparationPromise = null;
    this.userSelectionDeferredForCrossfade = false;
    this.nextTrackLoadPromise = null;
    this.crossfadeStartedAt = null;

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

  setDisplayCurrentTrack(track, { startTime = Date.now() } = {}) {
    if (!track) {
      return;
    }
    const liveIdentifier = this.currentTrack?.identifier || null;
    if (liveIdentifier && track.identifier && track.identifier !== liveIdentifier) {
      console.warn('🛰️ [display] Ignoring visual update for non-current track', {
        sessionId: this.sessionId,
        requestedId: track.identifier,
        liveIdentifier,
        pendingVisualId: this.pendingVisualCurrentTrack?.identifier || null
      });
      return;
    }
    const previousDisplayId = this.visualCurrentTrack?.identifier || null;
    this.visualCurrentTrack = track;
    this.visualTrackStartTime = startTime;
    if (previousDisplayId !== track.identifier) {
      console.log('🛰️ [display] Visual current track updated', {
        sessionId: this.sessionId,
        previousDisplayId,
        newDisplayId: track.identifier,
        startTime,
        liveCurrentId: this.currentTrack?.identifier || null,
        lockedNextId: this.lockedNextTrackIdentifier || null,
        preparedNextId: this.nextTrack?.identifier || null
      });
    }
  }

  getDisplayCurrentTrack() {
    return this.visualCurrentTrack || this.currentTrack || null;
  }

  getDisplayTrackStartTime() {
    return this.visualTrackStartTime || this.trackStartTime || null;
  }

  // Start the drift playback
  async startDriftPlayback() {
    if (this.currentProcess) {
      this.currentProcess.kill();
    }

    try {
      // Start the drift
      const seededTrack = await this.driftPlayer.startDrift();
      this.pendingCurrentTrack = this.hydrateTrackRecord(seededTrack, { transitionReason: 'drift-start' }) || seededTrack;
      await this.playCurrentTrack();

    } catch (error) {
      console.error('Failed to start drift playback:', error);
      this.fallbackToNoise();
    }
  }

  // Play the current track using advanced mixer
  async playCurrentTrack() {
    const trackToPlay = this.pendingCurrentTrack || this.currentTrack;

    if (!trackToPlay || !trackToPlay.path) {
      console.error('No valid track to play');
      this.fallbackToNoise();
      return;
    }

    // If already loading this track, wait for it instead of starting concurrent load
    if (this.currentTrackLoadingPromise) {
      console.log('🔄 Track already loading (seeding), waiting for completion...');
      await this.currentTrackLoadingPromise;
      console.log('✅ Concurrent load completed, track now seeded');
      return;
    }

    // Create loading promise to prevent concurrent loads
    let resolveLoading;
    let rejectLoading;
    this.currentTrackLoadingPromise = new Promise((resolve, reject) => {
      resolveLoading = resolve;
      rejectLoading = reject;
    });

    // Convert Buffer path to string if needed
    let trackPath = trackToPlay.path;
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

    console.log(`🎵 ${trackToPlay.title} by ${trackToPlay.artist}`);
    this.trackStartTime = null;

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

        if (this.currentProcess) {
          console.log('🌊 Stopping noise fallback due to successful track start');
          try {
            this.currentProcess.kill('SIGKILL');
          } catch (err) {
            console.warn('⚠️ Failed to kill noise fallback process:', err?.message || err);
          }
          this.currentProcess = null;
        }

        // DON'T broadcast here - the onTrackStart callback will handle it when audio actually starts
        // this.broadcastTrackEvent();

        // Schedule next track preparation for crossfading
        if (trackToPlay.length && trackToPlay.length > 10) {
          const crossfadeStartTime = (trackToPlay.length - 2.5) * 1000; // Start crossfade 2.5s before end

          setTimeout(() => {
            if (this.currentTrack && this.isActive) {
              this.prepareNextTrackForCrossfade();
            }
          }, Math.max(1000, crossfadeStartTime)); // At least 1s delay
        }

        if (resolveLoading) {
          resolveLoading();
        }
        this.currentTrackLoadingPromise = null;

      } else {
        console.log(`🔧 DEBUG: startStreaming() failed - mixer state may be invalid`);
        console.log(`🔧 DEBUG: audioMixer properties: ${Object.keys(this.audioMixer)}`);
        this.pendingCurrentTrack = this.pendingCurrentTrack || trackToPlay;
        throw new Error('Failed to start advanced mixer streaming - startStreaming() returned false');
      }

    } catch (error) {
      console.error('❌ Advanced mixer playback failed:', error);
      console.error('❌ Stack trace:', error.stack);
      console.log(`🔧 DEBUG: Error occurred while processing track: ${trackToPlay?.title} by ${trackToPlay?.artist}`);
      if (rejectLoading) {
        rejectLoading(error);
      }
      this.fallbackToNoise();
      // Clear loading state - track is now seeded (or failed)
      this.currentTrackLoadingPromise = null;
      this.pendingCurrentTrack = null;
    }
  }

  async handleUserSelectedNextTrack(trackMd5, options = {}) {
    if (!trackMd5) {
      console.warn('⚠️ Ignoring user track override without a trackMd5');
      return;
    }

    const { direction = null, debounceMs = this.userSelectionDebounceMs } = options;

    console.log(`🎯 [override] handleUserSelectedNextTrack requested ${trackMd5} (direction=${direction || 'none'})`);

    this.manualSelectionGeneration += 1;
    const selectionGeneration = this.manualSelectionGeneration;

    if (direction) {
      this.driftPlayer.currentDirection = direction;
    }
    this.pendingUserOverrideDirection = direction || null;
    this.pendingUserOverrideTrackId = trackMd5;
    this.isUserSelectionPending = true;
    this.lockedNextTrackIdentifier = trackMd5;
    this.pendingUserOverrideGeneration = selectionGeneration;

    // Clear any preloaded auto-selection so mixer won't consume it while debounce runs
    if (typeof this.audioMixer?.clearNextTrackSlot === 'function') {
      this.audioMixer.clearNextTrackSlot();
    }
    if (this.nextTrack) {
      console.log('🧹 [override] Clearing previously prepared next track to honor manual selection');
    }
    this.nextTrack = null;

    this.broadcastHeartbeat('user-selection-pending', { force: true }).catch(() => {});

    const effectiveDelay = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : this.userSelectionDebounceMs;

    this.broadcastSelectionEvent('selection_ack', {
      status: 'pending',
      trackId: trackMd5,
      direction: this.pendingUserOverrideDirection,
      debounceMs: effectiveDelay,
      generation: selectionGeneration
    });

    if (this.pendingUserSelectionTimer) {
      clearTimeout(this.pendingUserSelectionTimer);
      this.pendingUserSelectionTimer = null;
    }
    if (this.pendingUserSelectionResolve) {
      this.pendingUserSelectionResolve();
      this.pendingUserSelectionResolve = null;
    }

    if (effectiveDelay > 0) {
      console.log(`🕓 Debouncing user-selected track override for ${effectiveDelay}ms`);
      await new Promise(resolve => {
        const timerId = setTimeout(() => {
          if (this.pendingUserSelectionTimer === timerId) {
            this.pendingUserSelectionTimer = null;
          }
          if (this.pendingUserSelectionResolve === resolve) {
            this.pendingUserSelectionResolve = null;
          }
          resolve();
        }, effectiveDelay);
        this.pendingUserSelectionTimer = timerId;
        this.pendingUserSelectionResolve = resolve;
      });
    }

    this.pendingUserSelectionTimer = null;
    this.pendingUserSelectionResolve = null;

    if (this.pendingUserOverrideTrackId !== trackMd5) {
      return;
    }

    await this.applyUserSelectedTrackOverride(trackMd5);
  }

  clearPendingUserSelection(expectedGeneration = null) {
    if (expectedGeneration !== null && this.pendingUserOverrideGeneration !== null && expectedGeneration !== this.pendingUserOverrideGeneration) {
      return;
    }
    this.isUserSelectionPending = false;
    this.pendingUserOverrideTrackId = null;
    this.pendingUserOverrideDirection = null;
    this.pendingUserOverrideGeneration = null;
  }

  resetManualOverrideLock() {
    this.clearPendingUserSelection();
    this.lockedNextTrackIdentifier = null;
    this.manualSelectionGeneration = 0;
    this.pendingUserOverrideGeneration = null;
  }

  async applyUserSelectedTrackOverride(trackMd5) {
    if (!trackMd5 || (this.pendingUserOverrideTrackId && this.pendingUserOverrideTrackId !== trackMd5)) {
      if (!this.pendingUserOverrideTrackId) {
        this.clearPendingUserSelection();
      }
      return;
    }

    console.log(`🎯 [override] applyUserSelectedTrackOverride beginning for ${trackMd5}`);

    const mixerStatus = (this.audioMixer && typeof this.audioMixer.getStatus === 'function')
      ? this.audioMixer.getStatus()
      : null;

    if (mixerStatus?.isCrossfading) {
      const crossfadeAge = this.crossfadeStartedAt ? Date.now() - this.crossfadeStartedAt : null;

      if (crossfadeAge && crossfadeAge > CROSSFADE_GUARD_MS && typeof this.audioMixer?.forceTransition === 'function') {
        console.warn(`⚠️ Crossfade still active after ${crossfadeAge}ms; forcing completion to honor user selection`);
        const forced = this.audioMixer.forceTransition('cut');
        this.userSelectionDeferredForCrossfade = false;

        if (forced) {
          this.crossfadeStartedAt = null;
          setTimeout(() => {
            this.applyUserSelectedTrackOverride(trackMd5);
          }, 0);
          return;
        }
      }

      if (!this.userSelectionDeferredForCrossfade) {
        console.log('⏳ Crossfade in progress; deferring user-selected override until fade completes');
        this.userSelectionDeferredForCrossfade = true;
      }

      await new Promise(resolve => setTimeout(resolve, 750));

      if (this.pendingUserOverrideTrackId !== trackMd5) {
        console.log(`🎯 [override] Pending override changed during crossfade defer; aborting apply for ${trackMd5}`);
        return;
      }

      return this.applyUserSelectedTrackOverride(trackMd5);
    }

    this.userSelectionDeferredForCrossfade = false;

    const selectionGeneration = this.pendingUserOverrideGeneration;

    if (this.nextTrack && this.nextTrack.identifier === trackMd5) {
      console.log('🎯 User-selected track already prepared after debounce; no refresh needed');
      this.nextTrack = this.hydrateTrackRecord(this.nextTrack, {
        nextTrackDirection: this.pendingUserOverrideDirection || this.nextTrack?.nextTrackDirection,
        transitionReason: 'user'
      });
      this.clearPendingUserSelection();
      this.broadcastHeartbeat('user-selection-already-prepared', { force: true }).catch(() => {});
      this.broadcastSelectionEvent('selection_ready', {
        status: 'prepared',
        trackId: trackMd5,
        direction: this.pendingUserOverrideDirection || this.driftPlayer.currentDirection || null,
        note: 'already_prepared',
        generation: selectionGeneration
      });
      return;
    }

    if (typeof this.audioMixer?.clearNextTrackSlot === 'function') {
      this.audioMixer.clearNextTrackSlot();
    }

    this.nextTrack = null;

    await this.prepareNextTrackForCrossfade({
      forceRefresh: true,
      reason: 'user-selection',
      overrideTrackId: trackMd5,
      overrideDirection: this.pendingUserOverrideDirection,
      overrideGeneration: selectionGeneration
    });
  }

  scheduleAutoRecoveryAfterSelectionFailure() {
    if (this.autoRecoveryTimer) {
      return;
    }

    if (this.pendingUserOverrideTrackId) {
      return;
    }

    this.autoRecoveryTimer = setTimeout(async () => {
      this.autoRecoveryTimer = null;

      if (this.pendingUserOverrideTrackId || this.nextTrack) {
        return;
      }

      try {
        await this.prepareNextTrackForCrossfade({
          forceRefresh: true,
          reason: 'auto-recovery'
        });

        if (this.nextTrack) {
          this.broadcastSelectionEvent('selection_auto_requeued', {
            status: 'prepared',
            trackId: this.nextTrack.identifier,
            direction: this.nextTrack.nextTrackDirection || this.driftPlayer.currentDirection || null
          });
        }
      } catch (recoveryErr) {
        console.warn('⚠️ Auto-recovery next-track prepare failed:', recoveryErr?.message || recoveryErr);
      }
    }, 200);
  }

  // Prepare next track for crossfading
  async prepareNextTrackForCrossfade(options = {}) {
    const {
      forceRefresh = false,
      reason = 'auto',
      overrideTrackId = null,
      overrideDirection = null,
      overrideGeneration = null
    } = options;

    console.log(`🎯 [prepare] begin (reason=${reason}, force=${forceRefresh}, override=${overrideTrackId || 'none'})`);

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

    if (forceRefresh && reason === 'user-selection' && !overrideTrackId && !this.pendingUserOverrideTrackId) {
      console.log('🔁 Skipping forced preparation: user selection already resolved');
      return;
    }

    if (this.isUserSelectionPending && !forceRefresh) {
      console.log('⏳ Skipping auto next-track preparation while user selection is pending');
      return;
    }

    if (!forceRefresh && this.lockedNextTrackIdentifier && this.nextTrack &&
        this.nextTrack.identifier === this.lockedNextTrackIdentifier) {
      console.log('🔒 User-selected next track locked; skipping auto preparation');
      return;
    }

    const manualGenerationAtStart = overrideTrackId ? (overrideGeneration ?? this.pendingUserOverrideGeneration) : null;

    const preparation = (async () => {
      try {
        let hydratedNextTrack = null;
        let preparationReason = reason;

        if (overrideTrackId) {
          const annotations = {
            transitionReason: 'user'
          };
          if (overrideDirection || this.pendingUserOverrideDirection) {
            annotations.nextTrackDirection = overrideDirection || this.pendingUserOverrideDirection;
          }
          hydratedNextTrack = this.hydrateTrackRecord(overrideTrackId, annotations);

          if (!hydratedNextTrack?.path && !forceRefresh) {
            const pendingTracks = [this.nextTrack, this.pendingCurrentTrack].filter(Boolean);
            const collision = pendingTracks.find(track => track?.identifier === overrideTrackId);
            if (collision) {
              console.warn(`⚠️ [prepare] Pending autopilot track ${overrideTrackId} collided with override; waiting for its slot to clear before preparing user selection`);
              try {
                await Promise.race([
                  this.nextTrackLoadPromise,
                  new Promise(resolve => setTimeout(resolve, 1000))
                ]);
              } catch (waitErr) {
                console.warn('⚠️ [prepare] Collision wait failed:', waitErr?.message || waitErr);
              }
              hydratedNextTrack = this.hydrateTrackRecord(overrideTrackId, annotations);
            }
          }

          if (!hydratedNextTrack || !hydratedNextTrack.path) {
            console.error(`❌ [prepare] User-selected track not available for crossfade preparation (id=${overrideTrackId}, path=${hydratedNextTrack?.path || 'missing'})`);
            this.lockedNextTrackIdentifier = null;
            this.clearPendingUserSelection(manualGenerationAtStart);
            return;
          }

          preparationReason = 'user-selection';
          console.log(`🎯 [prepare] Hydrated override track ${hydratedNextTrack.title} (${hydratedNextTrack.identifier})`);
        } else {
          const nextTrack = await this.selectNextFromCandidates();
          hydratedNextTrack = this.hydrateTrackRecord(nextTrack);

          if (!hydratedNextTrack || !hydratedNextTrack.path) {
            console.warn('❌ No next track selected for crossfade preparation; attempting drift fallback');

            let fallbackCandidate = null;
            try {
              fallbackCandidate = await this.driftPlayer.getNextTrack();
            } catch (fallbackErr) {
              console.error('⚠️ Drift fallback selection failed:', fallbackErr?.message || fallbackErr);
            }

            const fallbackAnnotations = { transitionReason: 'drift-fallback' };
            const hydratedFallback = fallbackCandidate
              ? this.hydrateTrackRecord(fallbackCandidate, fallbackAnnotations)
              : null;

            if (hydratedFallback && hydratedFallback.path) {
              hydratedNextTrack = hydratedFallback;
              preparationReason = 'drift-fallback';
              console.log(`🎯 [prepare] Hydrated fallback track ${hydratedNextTrack.title} (${hydratedNextTrack.identifier})`);
            } else {
              console.error('🚫 Fallback track unavailable; scheduling retry in 5s');
              setTimeout(() => {
                this.prepareNextTrackForCrossfade('auto-retry', null, { force: true })
                  .catch(err => console.error('❌ Auto-retry preparation failed:', err));
              }, 5000);
              return;
            }
          } else {
            console.log(`🎯 [prepare] Hydrated auto track ${hydratedNextTrack.title} (${hydratedNextTrack.identifier})`);
          }
        }

        if (!hydratedNextTrack.transitionReason) {
          hydratedNextTrack.transitionReason = preparationReason;
        }

        console.log(`🎯 Preparing next track for crossfade (${preparationReason}): ${hydratedNextTrack.title}`);
        console.log(`🔧 DEBUG: Next track path: ${hydratedNextTrack.path}`);
        console.log(`🔧 DEBUG: Current this.nextTrack: ${this.nextTrack?.title || 'null'}`);

        if (!forceRefresh && this.nextTrack && this.nextTrack.identifier === hydratedNextTrack.identifier) {
          console.log(`⚠️ Same next track already prepared, skipping duplicate processing: ${hydratedNextTrack.title}`);
          return;
        }

        const previousNext = this.nextTrack;
        this.nextTrack = hydratedNextTrack;
        this.nextTrackLoadPromise = (async () => {
          try {
            console.log(`🎯 [prepare] Loading track into mixer (${hydratedNextTrack.path})`);
            return await this.audioMixer.loadTrack(hydratedNextTrack.path, 'next');
          } catch (loadErr) {
            this.nextTrack = previousNext || null;
            if (overrideTrackId) {
              this.lockedNextTrackIdentifier = null;
              this.clearPendingUserSelection();
            }
            console.error(`❌ [prepare] loadTrack failed for ${hydratedNextTrack.identifier}:`, loadErr?.message || loadErr);
            throw loadErr;
          }
        })();

        let nextTrackInfo;
        try {
          nextTrackInfo = await this.nextTrackLoadPromise;
        } finally {
          this.nextTrackLoadPromise = null;
        }
        console.log(`📊 Next track analysis: BPM=${nextTrackInfo.bpm}, Key=${nextTrackInfo.key}`);
        if (overrideTrackId) {
          const isLatestSelection = manualGenerationAtStart !== null && manualGenerationAtStart === this.pendingUserOverrideGeneration;

          if (!isLatestSelection) {
            console.log('↩️ [override] Prepared override superseded by newer selection; skipping commit');
            this.nextTrack = null;
            return;
          }

          this.lockedNextTrackIdentifier = hydratedNextTrack.identifier;
          console.log('🛰️ [override] Locked next track after user selection', {
            sessionId: this.sessionId,
            lockedId: this.lockedNextTrackIdentifier,
            preparedNextId: this.nextTrack?.identifier || null,
            pendingOverrideId: this.pendingUserOverrideTrackId || null,
            manualGenerationAtStart,
            currentTrackId: this.currentTrack?.identifier || null
          });
          await this.broadcastHeartbeat('user-next-prepared', { force: true });
        } else if (this.lockedNextTrackIdentifier && this.lockedNextTrackIdentifier !== hydratedNextTrack.identifier) {
          // Lock no longer applies if a different track is queued
          this.lockedNextTrackIdentifier = null;
          await this.broadcastHeartbeat('auto-next-prepared', { force: false });
        } else {
          await this.broadcastHeartbeat('auto-next-prepared', { force: false });
        }
        if (overrideTrackId) {
          const isCurrentSelection = this.pendingUserOverrideGeneration !== null
            && manualGenerationAtStart !== null
            && manualGenerationAtStart === this.pendingUserOverrideGeneration
            && this.pendingUserOverrideTrackId === hydratedNextTrack.identifier;

          if (isCurrentSelection || this.lockedNextTrackIdentifier === hydratedNextTrack.identifier) {
            this.broadcastSelectionEvent('selection_ready', {
              status: 'prepared',
              trackId: hydratedNextTrack.identifier,
              direction: this.pendingUserOverrideDirection || hydratedNextTrack.nextTrackDirection || this.driftPlayer.currentDirection || null,
              generation: manualGenerationAtStart
            });
            this.clearPendingUserSelection(manualGenerationAtStart);
          }
        } else if (this.pendingUserOverrideTrackId === hydratedNextTrack.identifier || this.lockedNextTrackIdentifier === hydratedNextTrack.identifier) {
          this.broadcastSelectionEvent('selection_ready', {
            status: 'prepared',
            trackId: hydratedNextTrack.identifier,
            direction: this.pendingUserOverrideDirection || hydratedNextTrack.nextTrackDirection || this.driftPlayer.currentDirection || null
          });
          this.clearPendingUserSelection();
        }
        console.log(`✅ Next track prepared successfully: ${hydratedNextTrack.title}`);
      } catch (error) {
        console.error('❌ Failed to prepare next track:', error);
        console.error('❌ Error details:', error.stack);
        if (overrideTrackId) {
          this.lockedNextTrackIdentifier = null;
          this.clearPendingUserSelection(manualGenerationAtStart);
          await this.broadcastHeartbeat('user-next-failed', { force: true });
          this.broadcastSelectionEvent('selection_failed', {
            trackId: overrideTrackId,
            status: 'failed',
            reason: error?.message || 'load_failed',
            generation: manualGenerationAtStart
          });
        } else {
          await this.broadcastHeartbeat('auto-next-failed', { force: true });
        }

        this.scheduleAutoRecoveryAfterSelectionFailure();
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
      if (this.nextTrackLoadPromise) {
        console.log('⏳ Waiting for pending next-track load to complete before transition');
        try {
          await this.nextTrackLoadPromise;
        } catch (err) {
          console.error('❌ Next-track load failed during transition:', err);
          this.nextTrack = null;
          this.lockedNextTrackIdentifier = null;
          this.clearPendingUserSelection();
          this.nextTrackLoadPromise = null;
          await this.transitionToNext();
          return;
        } finally {
          this.nextTrackLoadPromise = null;
        }
      }

      // Commit prepared track as pending until streaming actually starts
      this.pendingCurrentTrack = this.hydrateTrackRecord(this.nextTrack) || this.nextTrack;
      this.nextTrack = null;
      this.trackStartTime = null;

      if (this.lockedNextTrackIdentifier && this.pendingCurrentTrack && this.lockedNextTrackIdentifier === this.pendingCurrentTrack.identifier) {
        this.lockedNextTrackIdentifier = null;
      }

      // Clear mixdown cache on significant transitions (when we've moved to a new track)
      // This ensures we don't hold onto old neighborhood data
      this.audioMixer.clearMixdownCache();

      // DON'T broadcast here - let the audio mixer broadcast when it actually starts streaming
      // The broadcast will happen in the audioMixer.onTrackStart callback -> broadcastTrackEvent()
      console.log(`🔧 Track loaded into mixer: ${(this.pendingCurrentTrack || {}).title || 'unknown'} - waiting for audio to start before broadcasting`);

      if (!this.audioMixer?.engine?.isStreaming) {
        try {
          await this.playCurrentTrack();
        } catch (playErr) {
          console.error('❌ Failed to start playback after promoting next track:', playErr);
          this.fallbackToNoise();
          return;
        }
      } else {
        console.log('🎵 Mixer already streaming; skipping immediate restart after track promotion');
      }

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

  // Next track selection - explorer-based selection with drift fallback
  async selectNextFromCandidates() {
    try {
      console.log('🎯 Using explorer-based selection for next track');
      const explorerData = await this.getComprehensiveExplorerData();
      const nextTrackFromExplorer = await this.selectNextTrackFromExplorer(explorerData);

      if (nextTrackFromExplorer) {
        const explorerAnnotations = {
          transitionReason: nextTrackFromExplorer.transitionReason || 'explorer'
        };
        if (nextTrackFromExplorer.nextTrackDirection) {
          explorerAnnotations.nextTrackDirection = nextTrackFromExplorer.nextTrackDirection;
        }
        if (nextTrackFromExplorer.directionKey) {
          explorerAnnotations.directionKey = nextTrackFromExplorer.directionKey;
        }
        if (nextTrackFromExplorer.directionDescription) {
          explorerAnnotations.directionDescription = nextTrackFromExplorer.directionDescription;
        }
        if (nextTrackFromExplorer.diversityScore !== undefined) {
          explorerAnnotations.diversityScore = nextTrackFromExplorer.diversityScore;
        }
        if (nextTrackFromExplorer.weightedDiversityScore !== undefined) {
          explorerAnnotations.weightedDiversityScore = nextTrackFromExplorer.weightedDiversityScore;
        }
        if (nextTrackFromExplorer.domain) {
          explorerAnnotations.domain = nextTrackFromExplorer.domain;
        }

        const track = this.hydrateTrackRecord(nextTrackFromExplorer, explorerAnnotations);
        if (track) {
          if (this.lockedNextTrackIdentifier && this.lockedNextTrackIdentifier !== track.identifier) {
            this.lockedNextTrackIdentifier = null;
          }
          console.log(`✅ Using explorer-selected track: ${track.title} by ${track.artist} via ${nextTrackFromExplorer.nextTrackDirection}`);
          return track;
        }
      }

      console.log('🎯 Explorer selection failed, using drift player fallback');
      const driftTrack = await this.driftPlayer.getNextTrack();
      if (this.lockedNextTrackIdentifier && driftTrack && this.lockedNextTrackIdentifier !== driftTrack.identifier) {
        this.lockedNextTrackIdentifier = null;
      }
      return this.hydrateTrackRecord(driftTrack, { transitionReason: 'drift' });
    } catch (error) {
      console.error('Failed to select next track:', error);
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

    explorerLog(`🎯 New direction: ${chosenDirection} (${flowOptions[chosenDirection].candidates.length} candidates)`);
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

      const nextTrack = await this.selectNextFromCandidates();
      this.pendingCurrentTrack = this.hydrateTrackRecord(nextTrack) || nextTrack;
      
      // Add track to stack (organic exploration)
      if (this.pendingCurrentTrack && this.pendingCurrentTrack.identifier) {
        const direction = this.driftPlayer.getDriftState().currentDirection;
        this.pushToStack(
          this.pendingCurrentTrack.identifier,
          direction,
          this.explorerResolution || 'magnify'
        );
        
        // Advance stack index to new track
        this.stackIndex = this.stack.length - 1;
        this.positionSeconds = 0;
      }
      
      await this.playCurrentTrack();

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

    this.pendingCurrentTrack = null;

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

    // Ensure advanced mixer is fully stopped so future restarts succeed
    try {
      this.audioMixer.stopStreaming();
    } catch (err) {
      console.warn('⚠️ Failed to stop advanced mixer before noise fallback:', err?.message || err);
    }

    this.currentTrack = null;
    this.trackStartTime = null;

    if (this.nextTrackLoadPromise) {
      this.nextTrackLoadPromise = null;
    }

    const ffmpegArgs = [
      '-f', 'lavfi',
      '-i', `anoisesrc=color=brown:sample_rate=${config.audio.sampleRate}:duration=3600`, // 1 hour of brown noise
      '-ac', config.audio.channels.toString(),
      '-ar', config.audio.sampleRate.toString(),
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
      if (this.audioMixer?.engine?.isStreaming) {
        console.log('🔄 Drift already active; skipping auto-resume');
        return;
      }

      console.log('🔄 Attempting to resume drift...');
      this.pendingCurrentTrack = this.hydrateTrackRecord(await this.selectNextFromCandidates());
      await this.playCurrentTrack();
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
  async startStreaming() {
    if (this.isActive) return;

    console.log(`🎵 Starting drift streaming for session: ${this.sessionId}`);
    this.isActive = true;

    // If the mixer is already streaming (preload) just start serving clients
    if (this.audioMixer?.engine?.isStreaming) {
      console.log('🎵 Mixer already streaming from preload; keeping current track');
      return;
    }

    // If track is seeding, wait for it to become seeded
    if (this.currentTrackLoadingPromise) {
      console.log(`🌱 Track is seeding, waiting for it to become seeded...`);
      await this.currentTrackLoadingPromise;
      console.log(`🌳 Track seeded and ready`);
      return;
    }

    // Respect any pre-seeded track (e.g., contrived MD5 journey)
    if (this.currentTrack && this.currentTrack.path) {
      console.log(`🎵 Using pre-seeded track for session start: ${this.currentTrack.title || this.currentTrack.identifier}`);
      await this.playCurrentTrack();
    } else {
      await this.startDriftPlayback();
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

    // Clear playback state so monitoring endpoints stop reporting this session as active
    this.trackStartTime = null;
    this.currentTrack = null;
    this.nextTrack = null;
    this.pendingCurrentTrack = null;
    this._lastBroadcastTrackId = null;
    this.lastTrackEventPayload = null;
    this.lastTrackEventTimestamp = 0;

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

  async restartStream(reason = 'manual-restart') {
    console.log(`🔄 Restarting stream for session ${this.sessionId} (${reason})`);

    try {
      this.stopStreaming();
    } catch (error) {
      console.warn('⚠️ restartStream stopStreaming error:', error?.message || error);
    }

    this.clearPendingUserSelection();
    this.lockedNextTrackIdentifier = null;

    try {
      await this.startDriftPlayback();
      await this.broadcastTrackEvent(true, { reason: reason || 'manual-restart' });
      console.log(`✅ Stream restarted for session ${this.sessionId}`);
    } catch (error) {
      console.error('❌ restartStream failed:', error);
      throw error;
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

    if (this.lastTrackEventPayload) {
      try {
        const payloadJson = JSON.stringify(this.lastTrackEventPayload);
        eventClient.write(`data: ${payloadJson}\n\n`);
      } catch (replayError) {
        console.error('📡 Failed to replay cached track event to new SSE client:', replayError);
      }
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

  // Determine whether the audio stream should be considered alive
  isStreamAlive() {
    if (this.audioMixer?.engine?.isStreaming) {
      return true;
    }

    if (this.clients.size > 0) {
      if (this.currentTrack && this.trackStartTime) {
        const now = Date.now();
        let nominalDurationMs = null;

        try {
          const adjustedSeconds = this.getAdjustedTrackDuration();
          if (Number.isFinite(adjustedSeconds) && adjustedSeconds > 0) {
            nominalDurationMs = adjustedSeconds * 1000;
          }
        } catch (durationError) {
          nominalDurationMs = null;
        }

        if (!nominalDurationMs && this.currentTrack.length) {
          nominalDurationMs = this.currentTrack.length * 1000;
        }

        if (!nominalDurationMs) {
          return true; // Cannot determine duration; assume alive while clients exist
        }

        const elapsedMs = now - this.trackStartTime;
        if (elapsedMs >= 0 && elapsedMs <= nominalDurationMs + 15000) {
          return true;
        }
      } else {
        return true; // Clients present but no timing metadata - err on side of alive
      }
    }

    return false;
  }

  getStreamSummary() {
    const cloneTrack = (track) => {
      if (!track) return null;
      return {
        identifier: track.identifier,
        title: track.title,
        artist: track.artist,
        album: track.album || null,
        direction: track.nextTrackDirection || track.direction || null,
        length: track.length || null,
        duration: track.duration || track.length || null
      };
    };

    let summaryNextTrack = cloneTrack(this.nextTrack);
    if (!summaryNextTrack && this.lockedNextTrackIdentifier) {
      summaryNextTrack = cloneTrack(this.hydrateTrackRecord({ identifier: this.lockedNextTrackIdentifier }));
      if (summaryNextTrack) {
        summaryNextTrack.transitionReason = 'user';
      }
    }

    return {
      sessionId: this.sessionId,
      isStreaming: Boolean(this.audioMixer?.engine?.isStreaming),
      audioClientCount: this.clients.size,
      eventClientCount: this.eventClients.size,
      trackStartTime: this.trackStartTime,
      currentTrack: cloneTrack(this.currentTrack),
      pendingTrack: cloneTrack(this.pendingCurrentTrack),
      nextTrack: summaryNextTrack,
      lastBroadcast: this.lastTrackEventPayload ? {
        timestamp: this.lastTrackEventTimestamp,
        trackId: this.lastTrackEventPayload.currentTrack?.identifier || null
      } : null
    };
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

  broadcastToEventClients(eventType, payload = {}) {
    if (!eventType) {
      return;
    }

    const eventPayload = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...payload,
      type: eventType
    };

    this.broadcastEvent(eventPayload);
  }

  broadcastSelectionEvent(type, payload = {}) {
    if (!type) {
      return;
    }
    const event = {
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...payload
    };
    console.log(`📡 Session ${this.sessionId} selection event`, event);
    this.broadcastEvent(event);
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

  selectStrategicSamples(candidates, currentTrack) {
    if (!candidates || candidates.length === 0) return [];
    if (candidates.length === 1) return candidates;

    const withMetrics = candidates.map(c => ({
      ...c,
      track: c.track || c,
      dirDist: c.distance || c.similarity || 0,
      priDist: Math.abs((c.track || c).pca?.primary_d || 0)
    }));

    // Two sorted arrays: by direction distance and by primary distance
    const byDir = [...withMetrics].sort((a, b) => a.dirDist - b.dirDist);
    const byPri = [...withMetrics].sort((a, b) => a.priDist - b.priDist);

    const dealt = new Set();
    const result = [];

    const currentIdentifier = currentTrack?.identifier || null;

    const tryDeal = (arr, idx) => {
      if (idx < 0 || idx >= arr.length) return false;
      const c = arr[idx];
      const id = c.track?.identifier || c.identifier;
      if (!id) return false;
      if (currentIdentifier && id === currentIdentifier) return false; // Never surface the current track in suggestion stacks
      if (dealt.has(id)) return false;
      dealt.add(id);
      result.push(c);
      return true;
    };

    // Interleave: front of byDir, back of byDir, front of byPri, back of byPri
    for (let i = 0; result.length < candidates.length && i < Math.max(byDir.length, byPri.length); i++) {
      tryDeal(byDir, i);                    // Closest by direction
      tryDeal(byDir, byDir.length - 1 - i); // Furthest by direction
      tryDeal(byPri, i);                    // Closest by primary
      tryDeal(byPri, byPri.length - 1 - i); // Furthest by primary
    }

    return result;
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
      const wasPlayed = this.sessionHistory.some(({identifier}) =>
        identifier === track.identifier
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

  summarizeTrackMinimal(track) {
    if (!track) {
      return null;
    }

    const identifier = track.identifier || null;
    if (!identifier) {
      return null;
    }

    return {
      identifier,
      title: track.title || null,
      artist: track.artist || null,
      duration: track.length || track.duration || null,
      albumCover: track.albumCover || null
    };
  }

  buildNextTrackSummary() {
    let candidate = null;

    if (this.nextTrack && this.nextTrack.identifier) {
      candidate = this.hydrateTrackRecord(this.nextTrack);
    } else if (this.lockedNextTrackIdentifier) {
      candidate = this.hydrateTrackRecord({
        identifier: this.lockedNextTrackIdentifier,
        nextTrackDirection: this.pendingUserOverrideDirection || null,
        transitionReason: 'user'
      });
    } else if (this.pendingUserOverrideTrackId) {
      candidate = this.hydrateTrackRecord({
        identifier: this.pendingUserOverrideTrackId,
        nextTrackDirection: this.pendingUserOverrideDirection || null,
        transitionReason: 'user'
      });
    }

    if (!candidate) {
      return null;
    }

    const summary = this.summarizeTrackMinimal(candidate);
    if (!summary) {
      return null;
    }

    const direction = candidate.nextTrackDirection || candidate.direction || null;
    const directionKey = candidate.directionKey || null;

    return {
      directionKey: directionKey || null,
      direction,
      transitionReason: candidate.transitionReason || (this.lockedNextTrackIdentifier === summary.identifier ? 'user' : 'auto'),
      track: summary
    };
  }

  buildHeartbeatPayload(reason = 'status') {
    const displayTrack = this.getDisplayCurrentTrack();
    if (!displayTrack) {
      return null;
    }

    const now = Date.now();
    const displayStartTime = this.getDisplayTrackStartTime();

    let durationSeconds = null;
    if (displayTrack.identifier && this.currentTrack?.identifier === displayTrack.identifier) {
      durationSeconds = this.getAdjustedTrackDuration(this.currentTrack, { logging: false });
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      durationSeconds = displayTrack.length || displayTrack.duration || null;
    }

    const durationMs = Number.isFinite(durationSeconds) ? Math.max(Math.round(durationSeconds * 1000), 0) : null;
    const elapsedMs = displayStartTime ? Math.max(now - displayStartTime, 0) : null;
    const remainingMs = durationMs != null && elapsedMs != null
      ? Math.max(durationMs - elapsedMs, 0)
      : null;

    const nextSummary = this.buildNextTrackSummary();
    const overrideId = this.pendingUserOverrideTrackId || this.lockedNextTrackIdentifier || null;
    let overrideStatus = null;
    if (overrideId) {
      if (nextSummary?.track?.identifier === overrideId) {
        overrideStatus = 'prepared';
      } else if (this.pendingUserOverrideTrackId === overrideId) {
        overrideStatus = 'pending';
      } else {
        overrideStatus = 'locked';
      }
    }

    const beetsMeta = displayTrack.beetsMeta || this.lookupTrackBeetsMeta(displayTrack.identifier) || null;

    const currentTrackPayload = {
      identifier: displayTrack.identifier,
      title: displayTrack.title,
      artist: displayTrack.artist,
      startTime: displayStartTime,
      durationMs
    };

    if (beetsMeta) {
      try {
        currentTrackPayload.beetsMeta = JSON.parse(JSON.stringify(beetsMeta));
      } catch (err) {
        currentTrackPayload.beetsMeta = beetsMeta;
      }
    }

    return {
      type: 'heartbeat',
      timestamp: now,
      reason,
      fingerprint: this.currentFingerprint || fingerprintRegistry.getFingerprintForSession(this.sessionId) || null,
      currentTrack: currentTrackPayload,
      timing: {
        elapsedMs,
        remainingMs
      },
      nextTrack: nextSummary,
      override: overrideId ? {
        identifier: overrideId,
        status: overrideStatus,
        direction: this.pendingUserOverrideDirection || nextSummary?.direction || null
      } : null,
      session: {
        id: this.sessionId,
        audioClients: this.clients.size,
        eventClients: this.eventClients.size
      },
      drift: {
        currentDirection: this.driftPlayer.currentDirection
      }
    };
  }

  async broadcastHeartbeat(reason = 'status', { force = false } = {}) {
    const displayTrack = this.getDisplayCurrentTrack();
    if (!displayTrack) {
      return;
    }

    if (this.currentFingerprint) {
      fingerprintRegistry.touch(this.currentFingerprint);
    }

    const payload = this.buildHeartbeatPayload(reason);
    if (!payload) {
      return;
    }

    const serialized = JSON.stringify(payload);
    if (!force && serialized === this.lastHeartbeatSerialized) {
      return;
    }

    this.lastHeartbeatPayload = payload;
    this.lastHeartbeatSerialized = serialized;
    this.lastHeartbeatTimestamp = payload.timestamp;

    if (this.eventClients.size === 0) {
      return;
    }

    this.broadcastEvent(payload);
  }

  async broadcastExplorerSnapshot(force = false, reason = 'snapshot') {
    const displayTrack = this.getDisplayCurrentTrack();
    if (!displayTrack) {
      console.log('📡 No current track available for snapshot');
      return;
    }

    if (this.currentFingerprint) {
      fingerprintRegistry.touch(this.currentFingerprint);
    }

    const displayStartTime = this.getDisplayTrackStartTime();
    const currentTrackId = displayTrack.identifier;
    const preparedNextId = this.nextTrack?.identifier || this.lockedNextTrackIdentifier || null;

    const activeTrack = this.currentTrack && this.currentTrack.identifier === currentTrackId
      ? this.currentTrack
      : null;

    const lastSnapshotMatches = this._lastBroadcastTrackId === currentTrackId
      && this.lastExplorerSnapshotPayload
      && this.lastExplorerSnapshotPayload.currentTrack?.identifier === currentTrackId
      && (!preparedNextId || this.lastExplorerSnapshotPayload.nextTrack?.track?.identifier === preparedNextId);

    if (!force && lastSnapshotMatches) {
      console.log(`📡 Skipping duplicate explorer snapshot for ${currentTrackId}`);
      return;
    }

    let snapshotEvent = null;

    try {
      console.log(`📡 Building explorer snapshot for: ${displayTrack.title} by ${displayTrack.artist}`);

      if (this.sessionHistory.length === 0 ||
          this.sessionHistory[this.sessionHistory.length - 1].identifier !== currentTrackId) {
        this.addToHistory(displayTrack, displayStartTime, this.driftPlayer.currentDirection);
        console.log(`📡 Added track to history, total: ${this.sessionHistory.length}`);
      }

      let explorerData;
      try {
        explorerData = await this.getComprehensiveExplorerData();
        console.log(`📊 Explorer data loaded: ${Object.keys(explorerData.directions || {}).length} directions, ${Object.keys(explorerData.outliers || {}).length} outliers`);
      } catch (explorerError) {
        console.error('🚨 Explorer data load failed:', explorerError);
        explorerData = {
          directions: {},
          outliers: {},
          nextTrack: null,
          diversityMetrics: {
            error: true,
            message: 'Explorer data unavailable',
            originalError: explorerError.message
          }
        };
      }

      let explorerRetryAttempts = 0;
      while (Object.keys(explorerData.directions || {}).length === 0 && explorerRetryAttempts < 2) {
        explorerRetryAttempts += 1;

        if (this.nextTrackLoadPromise) {
          console.log('⏳ Explorer data empty while next track is loading; awaiting load before retrying snapshot');
          try {
            await this.nextTrackLoadPromise;
          } catch (loadErr) {
            console.warn('⚠️ Next-track load failed while waiting for explorer snapshot:', loadErr?.message || loadErr);
          }
        } else if (this.isUserSelectionPending) {
          console.log('⏳ Explorer data empty and user selection pending; deferring snapshot');
          await new Promise(resolve => setTimeout(resolve, 300));
        } else {
          break;
        }

        try {
          explorerData = await this.getComprehensiveExplorerData();
          console.log(`📊 Explorer retry #${explorerRetryAttempts}: ${Object.keys(explorerData.directions || {}).length} directions`);
        } catch (retryError) {
          console.warn('⚠️ Explorer retry failed:', retryError?.message || retryError);
          break;
        }
      }

      if (Object.keys(explorerData.directions || {}).length === 0) {
        console.warn('⚠️ Explorer data still empty after retries; skipping snapshot to avoid blank UI');
        return;
      }

      const nominatedDirectionKey =
        explorerData.nextTrack?.directionKey ||
        explorerData.nextTrack?.nextTrackDirection ||
        explorerData.nextTrack?.direction;
      if (nominatedDirectionKey && !(explorerData.directions || {}).hasOwnProperty(nominatedDirectionKey)) {
        const availableKeys = Object.keys(explorerData.directions || {});
        console.error('📉 Explorer snapshot missing direction payload for nominated nextTrack', {
          sessionId: this.sessionId,
          currentTrackId,
          nominatedDirectionKey,
          availableDirectionKeys: availableKeys.slice(0, 24),
          totalDirectionKeys: availableKeys.length
        });
      }

      let nextTrackSummary = explorerData.nextTrack;
      if (!nextTrackSummary || !nextTrackSummary.track) {
        nextTrackSummary = this.buildNextTrackSummary();
        explorerData.nextTrack = nextTrackSummary;
      }

      const featuresFallback = this.lookupTrackFeatures(currentTrackId);
      const pcaFallback = this.lookupTrackPca(currentTrackId);
      const artFallback = this.lookupTrackAlbumCover(currentTrackId);
      const beetsFallback = this.lookupTrackBeetsMeta(currentTrackId);

      let durationSeconds = null;
      if (activeTrack) {
        durationSeconds = this.getAdjustedTrackDuration(activeTrack, { logging: false });
      }
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        const fallbackDuration = Number(displayTrack.length ?? displayTrack.duration);
        durationSeconds = Number.isFinite(fallbackDuration) && fallbackDuration > 0
          ? fallbackDuration
          : 0;
      }

      const hydratedCurrent = this.hydrateTrackRecord(displayTrack, {
        startTime: displayStartTime,
        duration: durationSeconds,
        albumCover: displayTrack.albumCover || activeTrack?.albumCover || artFallback || null,
        features: displayTrack.features || activeTrack?.features || featuresFallback || {},
        pca: displayTrack.pca || activeTrack?.pca || pcaFallback || null
      }) || {};

      const beetsMeta = displayTrack.beetsMeta || activeTrack?.beetsMeta || beetsFallback || null;
      if (beetsMeta) {
        try {
          hydratedCurrent.beetsMeta = JSON.parse(JSON.stringify(beetsMeta));
        } catch (err) {
          hydratedCurrent.beetsMeta = beetsMeta;
        }
      }

      const currentTrackPayload = this.sanitizeTrackForClient(hydratedCurrent, {
        includeFeatures: true,
        includePca: true
      }) || {
        identifier: currentTrackId,
        title: displayTrack.title,
        artist: displayTrack.artist,
        duration: durationSeconds,
        albumCover: displayTrack.albumCover || activeTrack?.albumCover || artFallback || null,
        startTime: displayStartTime
      };
      if (currentTrackPayload && !currentTrackPayload.startTime && displayStartTime) {
        currentTrackPayload.startTime = displayStartTime;
      }
      if (currentTrackPayload && !currentTrackPayload.duration && Number.isFinite(durationSeconds)) {
        currentTrackPayload.duration = durationSeconds;
        currentTrackPayload.length = durationSeconds;
      }

      const sanitizedExplorer = this.serializeExplorerSnapshotForClient(explorerData);
      const sanitizedNextTrack = this.serializeNextTrackForClient(nextTrackSummary || explorerData.nextTrack || null, {
        includeFeatures: true,
        includePca: true
      });

      snapshotEvent = {
        type: 'explorer_snapshot',
        timestamp: Date.now(),
        reason,
        fingerprint: this.currentFingerprint || fingerprintRegistry.getFingerprintForSession(this.sessionId) || null,
        currentTrack: currentTrackPayload,
        nextTrack: sanitizedNextTrack || null,
        sessionHistory: this.sessionHistory.slice(-10).map(entry => ({
          identifier: entry.identifier,
          title: entry.title,
          artist: entry.artist,
          startTime: entry.startTime,
          direction: entry.direction,
          transitionReason: entry.transitionReason
        })),
        driftState: {
          currentDirection: this.driftPlayer.currentDirection,
          stepCount: this.driftPlayer.stepCount,
          sessionDuration: Date.now() - (this.sessionHistory[0]?.startTime || Date.now())
        },
        explorer: sanitizedExplorer,
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

      console.log(`📡 Broadcasting explorer snapshot: ${displayTrack.title} by ${displayTrack.artist}`);
      if (snapshotEvent.nextTrack?.track?.identifier) {
        console.log(`📊 Next track candidate: ${snapshotEvent.nextTrack.track.identifier.substring(0, 8)} (${snapshotEvent.nextTrack.transitionReason || 'unknown'})`);
      }
    } catch (error) {
      console.error('📡 Explorer snapshot error:', error);

      try {
        const fallbackCurrent = this.sanitizeTrackForClient({
          identifier: displayTrack.identifier,
          title: displayTrack.title,
          artist: displayTrack.artist,
          duration: this.getAdjustedTrackDuration(activeTrack || displayTrack, { logging: false }),
          albumCover: displayTrack.albumCover || activeTrack?.albumCover || null,
          startTime: displayStartTime
        }, {
          includeFeatures: true,
          includePca: true
        }) || {
          identifier: displayTrack.identifier,
          title: displayTrack.title,
          artist: displayTrack.artist,
          duration: this.getAdjustedTrackDuration(activeTrack || displayTrack, { logging: false }),
          albumCover: displayTrack.albumCover || activeTrack?.albumCover || null,
          startTime: displayStartTime
        };

        snapshotEvent = {
          type: 'explorer_snapshot',
          timestamp: Date.now(),
          reason,
          fingerprint: this.currentFingerprint || fingerprintRegistry.getFingerprintForSession(this.sessionId) || null,
          currentTrack: fallbackCurrent,
          explorer: { error: true, message: error.message },
          session: {
            id: this.sessionId,
            clients: this.clients.size,
            totalTracksPlayed: this.sessionHistory.length
          }
        };
      } catch (fallbackError) {
        console.error('📡 Even explorer fallback failed:', fallbackError);
        snapshotEvent = null;
      }
    }

    if (!snapshotEvent) {
      return;
    }

    const serialized = JSON.stringify(snapshotEvent);

    this._lastBroadcastTrackId = currentTrackId;
    this.lastTrackEventPayload = snapshotEvent;
    this.lastTrackEventTimestamp = snapshotEvent.timestamp;
    this.lastExplorerSnapshotPayload = snapshotEvent;
    this.lastExplorerSnapshotSerialized = serialized;
    this.lastExplorerSnapshotTimestamp = snapshotEvent.timestamp;

    if (this.eventClients.size === 0) {
      console.log('📡 No event clients, caching explorer snapshot for future subscribers');
      return;
    }

    this.broadcastEvent(snapshotEvent);
  }

  async broadcastTrackEvent(force = false, options = {}) {
    const reason = options.reason || 'track-update';
    await this.broadcastHeartbeat(reason, { force: true });
    if (force || reason === 'track-update' || reason === 'track-started') {
      await this.broadcastExplorerSnapshot(force, reason);
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

    // Check session-level cache first
    const resolution = this.explorerResolution || 'magnifying_glass';
    const cacheKey = `${this.currentTrack.identifier}_${resolution}`;

    if (this.explorerDataCache.has(cacheKey)) {
      console.log(`🚀 Explorer cache HIT: ${this.currentTrack.identifier.substring(0,8)} @ ${resolution} (${this.explorerDataCache.size} cached)`);
      return this.explorerDataCache.get(cacheKey);
    }

    console.log(`📊 Computing explorer data for ${this.currentTrack.identifier.substring(0,8)} @ ${resolution} (cache miss)`);

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

    if (currentTrackData.vae?.latent && Array.isArray(currentTrackData.vae.latent)) {
      console.log(`🧠 Exploring VAE latent directions (${currentTrackData.vae.latent.length} axes)`);
      await this.exploreVaeDirections(explorerData);
    }

    const summarizeDirectionsByDomain = (label, directions) => {
      const summary = Object.entries(directions || {}).reduce((acc, [key, info]) => {
        const domain = info?.domain || 'unknown';
        if (!acc[domain]) {
          acc[domain] = { count: 0, keys: [] };
        }
        acc[domain].count += 1;
        if (acc[domain].keys.length < 8) {
          acc[domain].keys.push(key);
        }
        return acc;
      }, {});
      console.log('🧭 Explorer direction domain summary', {
        label,
        summary,
        total: Object.keys(directions || {}).length
      });
      if (!summary.vae) {
        console.log('🧠 VAE directions missing at stage:', label);
      }
    };

    summarizeDirectionsByDomain('pre-limit', explorerData.directions);

    // Limit to maximum 12 dimensions for UI performance
    explorerData.directions = await this.limitToTopDimensions(explorerData.directions, 12);

    summarizeDirectionsByDomain('post-limit', explorerData.directions);

    // Strategic deduplication: PCA directions take precedence over similar core directions
    // TODO explorerData.directions = this.deduplicateTracksStrategically(explorerData.directions);

    // 🃏 DEBUG: Verify no duplicate cards across stacks
    // TODO this.debugDuplicateCards(explorerData.directions);

    // 🃏 FINAL DEDUPLICATION: Each card appears in exactly one stack (highest position wins)
    explorerData.directions = this.finalDeduplication(explorerData.directions);

    // Recalculate diversity metrics based on post-deduplication reality
    Object.entries(explorerData.directions).forEach(([directionKey, direction]) => {
      const actualCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;

      direction.actualTrackCount = actualCount;
      direction.isOutlier = actualCount < 3;
      direction.totalNeighborhoodSize = totalNeighborhoodSize;

      const optionsBonus = Math.min(actualCount / 10, 2.0);
      const baseScore = totalNeighborhoodSize > 0
        ? this.calculateDirectionDiversity(actualCount, totalNeighborhoodSize)
        : this.calculateDirectionDiversity(actualCount, actualCount || 1);
      direction.diversityScore = baseScore;
      direction.trackCount = actualCount;
      direction.adjustedDiversityScore = baseScore * optionsBonus;

      explorerLog(`🎯 Adjusted diversity for ${directionKey}: base=${baseScore.toFixed(2)}, count=${actualCount}, ` +
                  `bonus=${optionsBonus.toFixed(2)}, adjusted=${direction.adjustedDiversityScore.toFixed(2)}`);
    });

    // After deduplication, limit each direction back to 24 sample tracks for UI
    /* TODO
    Object.keys(explorerData.directions).forEach(directionKey => {
      const direction = explorerData.directions[directionKey];
      if (direction.sampleTracks && direction.sampleTracks.length > 24) {
        direction.sampleTracks = this.selectStrategicSamples(
          direction.sampleTracks.map(track => ({ track })),
          this.currentTrack
        ).map(sample => sample.track);
      }
    });
    */


    if (VERBOSE_EXPLORER) {
      Object.entries(explorerData.directions).forEach(([key, data]) => {
          explorerLog(`🚫🚫BEFORE🚫🚫 ${key} ${data.sampleTracks.length} ${data.hasOpposite}`);
      });
    }

    // ⚖️ BIDIRECTIONAL PRIORITIZATION: Make larger stack primary, smaller stack opposite
    // Do this AFTER final sampling so we prioritize based on actual final track counts
    explorerData.directions = this.prioritizeBidirectionalDirections(explorerData.directions);

    // 🧼 SAFETY NET: Remove any residual duplicates introduced by prioritization embedding
    explorerData.directions = this.sanitizeDirectionalStacks(explorerData.directions);
    explorerData.directions = this.removeEmptyDirections(explorerData.directions);
    explorerData.directions = this.applyStackBudget(explorerData.directions);
    explorerData.directions = this.selectTopTrack(explorerData.directions);

    if (VERBOSE_EXPLORER) {
      Object.entries(explorerData.directions).forEach(([key, data]) => {
        if (data.oppositeDirection) {
          const opKey = data.oppositeDirection.key;
          explorerLog(`🚫🚫AFTER🚫🚫 ${key} ${data.sampleTracks.length}, ${data.oppositeDirection.sampleTracks.length} ${opKey}`);
        } else {
          explorerLog(`🚫🚫AFTER🚫🚫 ${key} ${data.sampleTracks.length} ${data.hasOpposite}`);
        }
      });
    }

    // Calculate diversity scores and select next track
    explorerData.diversityMetrics = this.calculateExplorerDiversityMetrics(explorerData.directions, totalNeighborhoodSize);
    explorerData.nextTrack = await this.selectNextTrackFromExplorer(explorerData);
    explorerData.resolution = this.explorerResolution;

    // Cache the computed explorer data for this session
    this.explorerDataCache.set(cacheKey, explorerData);
    console.log(`💾 Cached explorer data for ${this.currentTrack.identifier.substring(0,8)} @ ${resolution} (cache size: ${this.explorerDataCache.size})`);

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
      // const smartFiltered = this.filterAndDeprioritizeCandidates(candidates.candidates || []);
      // TODO: later?
      const strategicSamples = this.selectStrategicSamples(candidates.candidates || [], this.currentTrack);

      const formattedTracks = strategicSamples.map(sample => {
        const track = sample.track || sample;
        const pcaSlices = this.radialSearch.kdTree.calculatePcaContributionFractions(
          this.currentTrack,
          track,
          domain,
          `${directionKey}:${track.identifier}`,
          component
        );
        const distanceSlices = {
          kind: 'pca',
          domain,
          reference: {
            key: pcaSlices.referenceKey,
            distance: pcaSlices.referenceDistance
          },
          total: pcaSlices.total,
          slices: pcaSlices.slices
        };
        return {
          identifier: track.identifier,
          title: track.title,
          artist: track.artist,
          albumCover: track.albumCover,
          duration: track.length,
          distance: sample.distance,
          pca: track.pca,
          features: track.features,
          distanceSlices,
          pcaDistanceSlices: {
            referenceKey: pcaSlices.referenceKey,
            referenceDistance: pcaSlices.referenceDistance,
            total: pcaSlices.total,
            slices: pcaSlices.slices
          }
        };
      });

      const originalSamples = formattedTracks.map(track => ({
        ...track,
        features: track.features ? { ...track.features } : track.features
      }));

      // Skip directions with 0 tracks (completely ignore them)
      if (trackCount === 0) {
        return;
      }

      // Skip directions that select nearly everything (useless)
      if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
        console.log(`🚫 Ignoring direction ${directionKey}: selects too many tracks (${trackCount}/${totalNeighborhoodSize})`);
        return; // Don't even add to explorerData
      }

      explorerData.directions[directionKey] = {
        direction: directionName,
        description: description,
        domain: domain,
        component: component,
        polarity: polarity,
        trackCount: formattedTracks.length,
        totalNeighborhoodSize: totalNeighborhoodSize,
        diversityScore: this.calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
        isOutlier: formattedTracks.length < 3,
        splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
        sampleTracks: formattedTracks,
        originalSampleTracks: originalSamples
      };
    } catch (error) {
      console.error(`Failed to explore direction ${directionKey}:`, error);
      explorerData.directions[directionKey] = {
        direction: directionName,
        description: description,
        domain: domain,
        component: component,
        polarity: polarity,
        sampleTracks: [],
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

      const strategicSamples = this.selectStrategicSamples(filteredCandidates, this.currentTrack, 50);
      console.log(`🔍 CORE SAMPLING: Selected ${strategicSamples.length} sample tracks from ${filteredCandidates.length} filtered candidates`);

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

      const formattedTracks = strategicSamples.map(sample => {
        const track = sample.track || sample;
        const directionDim = this.radialSearch.kdTree.getDirectionDimension(direction);
        const activeDimensions = this.radialSearch.kdTree.dimensions.filter(dim => dim !== directionDim);
        const featureSlices = this.radialSearch.kdTree.calculateFeatureContributionFractions(
          this.currentTrack,
          track,
          activeDimensions,
          null,
          `${directionKey}:${track.identifier || track.track?.identifier}`,
          directionDim
        );
        const distanceSlices = {
          kind: 'feature',
          dimensions: activeDimensions,
          reference: {
            key: directionDim,
            distance: featureSlices.referenceDistance
          },
          total: featureSlices.total,
          slices: featureSlices.slices
        };
        return {
          identifier: track.identifier || track.track?.identifier,
          title: track.title || track.track?.title,
          artist: track.artist || track.track?.artist,
          duration: track.length || track.track?.length,
          distance: sample.distance || sample.similarity,
          features: track.features || track.track?.features,
          albumCover: track.albumCover || track.track?.albumCover,
          distanceSlices,
          featureDistanceSlices: {
            referenceKey: directionDim,
            referenceDistance: featureSlices.referenceDistance,
            total: featureSlices.total,
            slices: featureSlices.slices
          }
        };
      });

      const originalSamples = formattedTracks.map(track => ({
        ...track,
        features: track.features ? { ...track.features } : track.features
      }));

      explorerData.directions[directionKey] = {
        direction: direction,
        description: feature.description,
        domain: 'original',
        component: feature.name,
        polarity: polarity,
        trackCount: formattedTracks.length,
        totalNeighborhoodSize: totalNeighborhoodSize,
        diversityScore: this.calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
        isOutlier: formattedTracks.length < 3,
        splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
        sampleTracks: formattedTracks,
        originalSampleTracks: originalSamples
      };

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

  async exploreVaeDirection(explorerData, latentIndex, polarity, options = {}) {
    const directionKey = `vae_latent_${latentIndex}_${polarity}`;
    const description = `Latent axis ${latentIndex + 1} (${polarity === 'positive' ? '+' : '-'})`;

    try {
      const result = await this.radialSearch.getVAEDirectionalCandidates(
        this.currentTrack.identifier,
        latentIndex,
        polarity,
        {
          resolution: this.explorerResolution || 'magnifying_glass',
          limit: options.limit || 24
        }
      );

      const candidates = result?.candidates || [];
      if (candidates.length === 0) {
        console.log(`🚫 VAE direction ${directionKey} returned no candidates`);
        return;
      }

      const formattedTracks = candidates.map(candidate => {
        const track = candidate.track || {};
        return {
          identifier: track.identifier,
          title: track.title,
          artist: track.artist,
          albumCover: track.albumCover,
          duration: track.length,
          distance: candidate.distance,
          latentValue: candidate.latentValue,
          latentDelta: candidate.delta,
          vae: track.vae,
          features: track.features
        };
      });

      const totalAvailable = result.totalAvailable || formattedTracks.length;
      const neighborhoodSize = totalAvailable > 0 ? totalAvailable : formattedTracks.length;

      explorerData.directions[directionKey] = {
        direction: polarity === 'positive'
          ? `increase latent ${latentIndex + 1}`
          : `decrease latent ${latentIndex + 1}`,
        description,
        domain: 'vae',
        component: `latent_${latentIndex}`,
        polarity,
        trackCount: formattedTracks.length,
        totalNeighborhoodSize: neighborhoodSize,
        diversityScore: this.calculateDirectionDiversity(formattedTracks.length, neighborhoodSize),
        isOutlier: formattedTracks.length < 3,
        splitRatio: neighborhoodSize > 0 ? (formattedTracks.length / neighborhoodSize) : 0,
        sampleTracks: formattedTracks,
        originalSampleTracks: formattedTracks.map(track => ({ ...track }))
      };
    } catch (error) {
      console.error(`🚨 VAE SEARCH ERROR: Failed to explore latent direction ${directionKey}:`, error);
    }
  }

  async exploreVaeDirections(explorerData) {
    const latentVector = this.currentTrack?.vae?.latent;
    if (!Array.isArray(latentVector) || latentVector.length === 0) {
      return;
    }

    for (let index = 0; index < latentVector.length; index += 1) {
      await this.exploreVaeDirection(explorerData, index, 'positive');
      await this.exploreVaeDirection(explorerData, index, 'negative');
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
        sampleTracks: dirData.sampleTracks?.filter((track, position) => {
          const trackId = track.identifier || track.track?.identifier;
          if (!trackId) return false;
          const assignment = trackAssignments.get(trackId);
          return assignment && assignment.bestDirection === dirKey && assignment.bestPosition === position;
        }) || []
      };
    });

    console.log(`🃏 FINAL DEDUPLICATION: Removed duplicates, each card appears in exactly one stack`);
    return finalDirections;
  }

  // Pick the most suitable top track for each direction (prefer unique album covers and real art)
  selectTopTrack(directions) {
    const DEFAULT_ALBUM = '/images/albumcover.png';
    const DEFAULT_KEY = '__default__';
    const coverOwners = new Map(); // coverKey -> { directionKey, count }

    const orderedDirections = Object.entries(directions)
      .sort((a, b) => {
        const countA = a[1].actualTrackCount ?? (Array.isArray(a[1].sampleTracks) ? a[1].sampleTracks.length : 0);
        const countB = b[1].actualTrackCount ?? (Array.isArray(b[1].sampleTracks) ? b[1].sampleTracks.length : 0);
        if (countA !== countB) return countA - countB;
        return a[0].localeCompare(b[0]);
      });

    orderedDirections.forEach(([directionKey, direction]) => {
      const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.slice() : [];
      if (samples.length === 0) {
        return;
      }

      const actualCount = direction.displayTrackCount
        ?? direction.actualTrackCount
        ?? samples.length;

      const candidates = samples.map((entry, index) => {
        const track = entry.track || entry;
        const cover = track?.albumCover || DEFAULT_ALBUM;
        const defaultCover = !cover || cover === DEFAULT_ALBUM;
        const coverKey = defaultCover ? DEFAULT_KEY : cover;
        const owner = coverOwners.get(coverKey);
        const penalized = owner && owner.count < actualCount && !defaultCover;

        let score = 0;
        if (!owner) {
          score += defaultCover ? 15 : 100;
        } else if (!defaultCover) {
          score += penalized ? 5 : 40;
        } else {
          score += owner.count < actualCount ? 1 : 5;
        }

        score -= index;

        return { entry, track, cover, coverKey, defaultCover, score, penalized, index };
      });

      candidates.sort((a, b) => b.score - a.score);

      const preferred = candidates.find(candidate => {
        const owner = coverOwners.get(candidate.coverKey);
        if (!owner) return true;
        if (candidate.defaultCover) return owner.count >= actualCount;
        return owner.count >= actualCount;
      }) || candidates[0];

      if (preferred && preferred.index > 0) {
        const reordered = samples.slice();
        reordered.splice(preferred.index, 1);
        reordered.unshift(preferred.entry);
        direction.sampleTracks = reordered;
      } else {
        direction.sampleTracks = samples;
      }

      const coverKey = preferred?.defaultCover ? DEFAULT_KEY : preferred?.cover;
      if (coverKey && !coverOwners.has(coverKey)) {
        coverOwners.set(coverKey, { directionKey, count: actualCount });
      }

      explorerLog(`🎨 Top card for ${directionKey}: ${preferred?.track?.title || 'unknown'} ` +
                  `(cover=${preferred?.cover || 'default'}, count=${actualCount})`);
    });

    return directions;
  }

  applyStackBudget(directions) {
    if (!directions || typeof directions !== 'object') {
      return directions;
    }

    const total = this.stackTotalCount || 0;
    if (!Number.isFinite(total) || total <= 0) {
      return directions;
    }

    const randomCount = Math.min(this.stackRandomCount || 0, total);
    const deterministicLimit = Math.max(total - randomCount, 0);
    const usedIds = new Set();

    Object.entries(directions).forEach(([directionKey, direction]) => {
      const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
      let trimmed;

      if (deterministicLimit === 0) {
        trimmed = [];
      } else {
        trimmed = samples.slice(0, Math.min(samples.length, deterministicLimit));
      }

      direction.sampleTracks = trimmed;
      direction.displayTrackCount = trimmed.length;
      trimmed.forEach(sample => {
        const track = sample.track || sample;
        const id = track?.identifier;
        if (id) {
          usedIds.add(id);
        }
      });
    });

    Object.entries(directions).forEach(([directionKey, direction]) => {
      if (!Array.isArray(direction.sampleTracks)) {
        direction.sampleTracks = [];
      }

      const currentTracks = direction.sampleTracks;
      const existingIds = new Set(currentTracks.map(sample => (sample.track || sample)?.identifier).filter(Boolean));
      const needed = total - currentTracks.length;

      if (needed <= 0) {
        return;
      }

      const source = Array.isArray(direction.originalSampleTracks) && direction.originalSampleTracks.length > 0
        ? direction.originalSampleTracks
        : currentTracks;

      const available = source.filter(sample => {
        const track = sample.track || sample;
        const id = track?.identifier;
        if (!id) return false;
        if (existingIds.has(id)) return false;
        if (usedIds.has(id)) return false;
        return true;
      });

      const picks = this.getRandomSubset(available, needed);

      picks.forEach(sample => {
        const clone = {
          ...sample,
          features: sample.features ? { ...sample.features } : sample.features
        };
        const track = clone.track || clone;
        const id = track?.identifier;
        if (id) {
          usedIds.add(id);
          existingIds.add(id);
        }
        currentTracks.push(clone);
      });

      direction.sampleTracks = currentTracks;
      const finalCount = currentTracks.length;
      direction.displayTrackCount = finalCount;
      direction.actualTrackCount = finalCount;
      direction.trackCount = finalCount;
    });

    return directions;
  }

  getRandomSubset(array, size) {
    if (!Array.isArray(array) || array.length === 0 || size <= 0) {
      return [];
    }

    const copy = array.slice();
    this.shuffleArray(copy);
    return copy.slice(0, Math.min(size, copy.length));
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  lookupTrackFeatures(identifier) {
    if (!identifier) return null;
    const track = this.radialSearch?.kdTree?.getTrack(identifier);
    if (!track) return this.findTrackInCurrentExplorer(identifier)?.features || null;
    return track.features || this.findTrackInCurrentExplorer(identifier)?.features || null;
  }

  lookupTrackPca(identifier) {
    if (!identifier) return null;
    const track = this.radialSearch?.kdTree?.getTrack(identifier);
    if (!track) return this.findTrackInCurrentExplorer(identifier)?.pca || null;
    return track.pca || this.findTrackInCurrentExplorer(identifier)?.pca || null;
  }

  lookupTrackAlbumCover(identifier) {
    if (!identifier) return null;
    const track = this.radialSearch?.kdTree?.getTrack(identifier);
    if (!track) return this.findTrackInCurrentExplorer(identifier)?.albumCover || null;
    return track.albumCover || this.findTrackInCurrentExplorer(identifier)?.albumCover || null;
  }

  lookupTrackBeetsMeta(identifier) {
    if (!identifier) return null;
    const track = this.radialSearch?.kdTree?.getTrack(identifier);
    if (!track) {
      return this.findTrackInCurrentExplorer(identifier)?.beetsMeta || null;
    }
    return track.beetsMeta || this.findTrackInCurrentExplorer(identifier)?.beetsMeta || null;
  }

  cloneFeatureMap(features) {
    if (!features || typeof features !== 'object') return null;
    const clone = {};
    for (const [key, value] of Object.entries(features)) {
      if (value === undefined) continue;
      clone[key] = value;
    }
    return clone;
  }

  clonePcaMap(pca) {
    if (!pca || typeof pca !== 'object') return null;
    const clone = {};
    if (pca.primary_d !== undefined) {
      clone.primary_d = pca.primary_d;
    }
    ['tonal', 'spectral', 'rhythmic'].forEach(domain => {
      const domainValue = pca[domain];
      if (Array.isArray(domainValue)) {
        clone[domain] = domainValue.slice();
      } else if (domainValue !== undefined && domainValue !== null) {
        clone[domain] = domainValue;
      }
    });
    return clone;
  }

  cloneVaeData(vae) {
    if (!vae || typeof vae !== 'object') return null;
    const clone = {};
    if (Array.isArray(vae.latent)) {
      clone.latent = vae.latent.slice();
    } else {
      clone.latent = null;
    }
    if (vae.model_version !== undefined) {
      clone.model_version = vae.model_version;
    }
    if (vae.computed_at !== undefined) {
      clone.computed_at = vae.computed_at;
    }
    return clone;
  }

  cloneBaseTrack(track) {
    if (!track || typeof track !== 'object') return null;
    const clone = {
      identifier: track.identifier,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumCover: track.albumCover,
      path: track.path,
      length: track.length,
      duration: track.duration !== undefined ? track.duration : track.length,
      love: track.love,
      bpm: track.bpm,
      key: track.key
    };

    if (track.features) {
      clone.features = this.cloneFeatureMap(track.features);
    }
    if (track.pca) {
      clone.pca = this.clonePcaMap(track.pca);
    }
    if (track.vae) {
      clone.vae = this.cloneVaeData(track.vae);
    }
    if (track.beetsMeta) {
      try {
        clone.beetsMeta = JSON.parse(JSON.stringify(track.beetsMeta));
      } catch (err) {
        clone.beetsMeta = track.beetsMeta;
      }
    }
    if (track.analysis) {
      try {
        clone.analysis = JSON.parse(JSON.stringify(track.analysis));
      } catch (err) {
        // Non-serializable analysis structures can be ignored for hydration purposes
      }
    }

    return clone;
  }

  sanitizeTrackForClient(track, options = {}) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const {
      includeFeatures = true,
      includePca = true
    } = options;

    const duration = Number.isFinite(track.duration)
      ? track.duration
      : (Number.isFinite(track.length) ? track.length : null);

    const payload = {
      identifier: track.identifier,
      title: track.title,
      artist: track.artist,
      album: track.album || null,
      albumCover: track.albumCover || null,
      duration,
      length: duration,
      directionKey: track.directionKey || track.baseDirection || track.dimensionKey || null,
      direction: track.direction || track.baseDirection || null,
      transitionReason: track.transitionReason || track.reason || null
    };

    if (track.stackDirection) {
      payload.stackDirection = track.stackDirection;
    }
    if (track.baseDirection) {
      payload.baseDirection = track.baseDirection;
    }
    if (track.baseDirectionKey) {
      payload.baseDirectionKey = track.baseDirectionKey;
    }
    if (track.startTime) {
      payload.startTime = track.startTime;
    }
    if (track.previewDirectionKey) {
      payload.previewDirectionKey = track.previewDirectionKey;
    }
    if (track.directionMeta) {
      payload.directionMeta = { ...track.directionMeta };
    }

    if (includeFeatures && track.features) {
      const features = this.cloneFeatureMap(track.features);
      if (features && Object.keys(features).length > 0) {
        payload.features = features;
      }
    }

    if (includePca && track.pca) {
      const pca = this.clonePcaMap(track.pca);
      if (pca) {
        payload.pca = pca;
      }
    }

    return payload;
  }

  sanitizeSampleTrackEntry(entry, options = {}) {
    if (!entry) {
      return null;
    }

    const { includeFeatures = true, includePca = true } = options;
    const track = entry.track || entry;
    const sanitizedTrack = this.sanitizeTrackForClient(track, { includeFeatures, includePca });
    if (!sanitizedTrack) {
      return null;
    }

    if (entry.track) {
      const wrapper = { ...entry };
      delete wrapper.track;
      delete wrapper.distance;
      delete wrapper.similarity;
      delete wrapper.distanceSlices;
      delete wrapper.featureDistanceSlices;
      delete wrapper.analysis;
      delete wrapper.beets;
      delete wrapper.beetsMeta;
      delete wrapper.features;
      delete wrapper.pca;
      return { ...wrapper, track: sanitizedTrack };
    }

    return sanitizedTrack;
  }

  sanitizeSampleTrackList(entries, options = {}) {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map(entry => this.sanitizeSampleTrackEntry(entry, options))
      .filter(Boolean);
  }

  sanitizeExplorerDirection(direction, options = {}) {
    if (!direction) {
      return direction;
    }

    const sanitized = { ...direction };
    sanitized.sampleTracks = this.sanitizeSampleTrackList(
      direction.sampleTracks,
      options
    );

    if (direction.oppositeDirection) {
      sanitized.oppositeDirection = {
        ...direction.oppositeDirection,
        sampleTracks: this.sanitizeSampleTrackList(
          direction.oppositeDirection.sampleTracks,
          options
        )
      };
    }

    delete sanitized.originalSampleTracks;
    delete sanitized.distanceSlices;
    delete sanitized.featureDistanceSlices;
    delete sanitized.analysis;
    delete sanitized.beets;
    delete sanitized.beetsMeta;

    return sanitized;
  }

  serializeNextTrackForClient(nextTrack, options = {}) {
    if (!nextTrack) {
      return null;
    }

    if (typeof nextTrack === 'string') {
      return nextTrack;
    }

    const sanitized = { ...nextTrack };
    if (nextTrack.track) {
      sanitized.track = this.sanitizeTrackForClient(nextTrack.track, options);
    }
    delete sanitized.distanceSlices;
    delete sanitized.featureDistanceSlices;
    delete sanitized.analysis;
    delete sanitized.beets;
    delete sanitized.beetsMeta;
    return sanitized;
  }

  serializeExplorerSnapshotForClient(explorerData) {
    if (!explorerData) {
      return null;
    }

    const sanitized = { ...explorerData };

    if (explorerData.directions) {
      const sanitizedDirections = {};
      for (const [key, direction] of Object.entries(explorerData.directions)) {
        sanitizedDirections[key] = this.sanitizeExplorerDirection(direction, {
          includeFeatures: true,
          includePca: true
        });
      }
      sanitized.directions = sanitizedDirections;
    }

    if (explorerData.outliers) {
      const sanitizedOutliers = {};
      for (const [key, direction] of Object.entries(explorerData.outliers)) {
        sanitizedOutliers[key] = this.sanitizeExplorerDirection(direction, {
          includeFeatures: true,
          includePca: true
        });
      }
      sanitized.outliers = sanitizedOutliers;
    }

    sanitized.nextTrack = this.serializeNextTrackForClient(
      explorerData.nextTrack,
      { includeFeatures: true, includePca: true }
    );

    if (explorerData.currentTrack) {
      sanitized.currentTrack = this.sanitizeTrackForClient(
        explorerData.currentTrack,
        { includeFeatures: true, includePca: true }
      );
    }

    return sanitized;
  }

  mergeFeatureMaps(...sources) {
    const merged = {};
    let hasValue = false;

    sources.forEach(source => {
      if (!source || typeof source !== 'object') return;
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined || value === null) continue;
        merged[key] = value;
        hasValue = true;
      }
    });

    return hasValue ? merged : null;
  }

  mergePcaMaps(...sources) {
    let merged = null;

    sources.forEach(source => {
      const clone = this.clonePcaMap(source);
      if (!clone) return;

      if (!merged) {
        merged = clone;
        return;
      }

      if (clone.primary_d !== undefined) {
        merged.primary_d = clone.primary_d;
      }

      ['tonal', 'spectral', 'rhythmic'].forEach(domain => {
        if (clone[domain]) {
          merged[domain] = clone[domain];
        }
      });
    });

    return merged;
  }

  hydrateTrackRecord(trackCandidate, annotations = {}) {
    if (!trackCandidate && !annotations.identifier) {
      return null;
    }

    let overlay = {};
    let nestedCandidate = null;

    if (typeof trackCandidate === 'string') {
      overlay.identifier = trackCandidate;
    } else if (trackCandidate && typeof trackCandidate === 'object') {
      const { track: nested, ...rest } = trackCandidate;
      overlay = { ...rest };

      if (nested && typeof nested === 'object') {
        nestedCandidate = nested;
        for (const [key, value] of Object.entries(nested)) {
          if (!(key in overlay)) {
            overlay[key] = value;
          }
        }
      } else {
        nestedCandidate = trackCandidate;
      }
    }

    const identifier = annotations.identifier
      || overlay.identifier
      || nestedCandidate?.identifier
      || null;

    if (!identifier) {
      return null;
    }

    const kdTrack = this.radialSearch?.kdTree?.getTrack(identifier);
    const baseClone = this.cloneBaseTrack(kdTrack) || {};

    const result = {
      ...baseClone,
      ...overlay,
      ...annotations
    };

    delete result.track;

    result.identifier = identifier;
    if (!result.length && typeof result.duration === 'number') {
      result.length = result.duration;
    }
    if (!result.duration && typeof result.length === 'number') {
      result.duration = result.length;
    }
    if (!result.path && baseClone.path) {
      result.path = baseClone.path;
    }
    result.albumCover = result.albumCover || baseClone.albumCover || null;
    result.title = result.title || baseClone.title;
    result.artist = result.artist || baseClone.artist;

    const beetsSources = [baseClone?.beetsMeta, overlay?.beetsMeta, annotations?.beetsMeta, nestedCandidate?.beetsMeta];
    const beetsMeta = beetsSources.find(meta => meta && Object.keys(meta).length > 0) || null;
    if (beetsMeta) {
      try {
        result.beetsMeta = JSON.parse(JSON.stringify(beetsMeta));
      } catch (err) {
        result.beetsMeta = beetsMeta;
      }
    } else {
      delete result.beetsMeta;
    }

    const mergedFeatures = this.mergeFeatureMaps(
      baseClone.features,
      nestedCandidate?.features,
      overlay.features,
      annotations.features
    );
    if (mergedFeatures) {
      result.features = mergedFeatures;
    } else if (result.features) {
      result.features = this.cloneFeatureMap(result.features) || {};
    } else {
      result.features = {};
    }

    const mergedPca = this.mergePcaMaps(
      baseClone.pca,
      nestedCandidate?.pca,
      overlay.pca,
      annotations.pca
    );
    if (mergedPca) {
      result.pca = mergedPca;
    } else if (result.pca) {
      result.pca = this.clonePcaMap(result.pca);
    } else {
      result.pca = null;
    }

    const vaeSources = [overlay.vae, annotations.vae, nestedCandidate?.vae, baseClone.vae].filter(Boolean);
    const resolvedVae = vaeSources.find(source => Array.isArray(source?.latent)) || vaeSources[0] || null;
    if (resolvedVae) {
      result.vae = this.cloneVaeData(resolvedVae);
    } else if (result.vae) {
      result.vae = this.cloneVaeData(result.vae);
    } else {
      result.vae = null;
    }

    return result;
  }

  findTrackInCurrentExplorer(identifier) {
    if (!identifier || !this.explorerDataCache?.size) return null;
    for (const [, explorerData] of this.explorerDataCache) {
      if (!explorerData || !explorerData.directions) continue;
      for (const direction of Object.values(explorerData.directions)) {
        const inspect = (dir) => {
          if (!dir) return null;
          const primary = dir.sampleTracks || [];
          for (const sample of primary) {
            const candidate = sample.track || sample;
            if (candidate?.identifier === identifier) {
              return candidate;
            }
          }
          return null;
        };

        const primaryHit = inspect(direction);
        if (primaryHit) return primaryHit;

        if (direction.oppositeDirection) {
          const oppositeHit = inspect(direction.oppositeDirection);
          if (oppositeHit) return oppositeHit;
        }
      }
    }
    return null;
  }

  // Ensure each stack reports unique tracks (within the stack and across all stacks)
  sanitizeDirectionalStacks(directions) {
    if (!directions || typeof directions !== 'object') {
      return directions;
    }

    const globalAssignments = new Map(); // trackId -> { directionKey, location }
    let duplicatesRemoved = 0;
    let missingIdentifiers = 0;

    const normalizeStack = (directionKey, direction, location = 'primary') => {
      if (!direction || !Array.isArray(direction.sampleTracks)) {
        return;
      }

      const localSeen = new Set();
      const sanitized = [];

      direction.sampleTracks.forEach((entry, index) => {
        const trackId = entry?.identifier || entry?.track?.identifier;

        if (!trackId) {
          missingIdentifiers += 1;
          console.warn(`🧼 STACK SANITIZE: Dropping track without identifier from ${directionKey}/${location} (index ${index})`);
          return;
        }

        if (localSeen.has(trackId)) {
          duplicatesRemoved += 1;
          console.warn(`🧼 STACK SANITIZE: Removed local duplicate ${trackId} from ${directionKey}/${location} (index ${index})`);
          return;
        }

        const existing = globalAssignments.get(trackId);
        if (existing) {
          duplicatesRemoved += 1;
          const title = entry?.title || entry?.track?.title || trackId;
          console.warn(`🧼 STACK SANITIZE: Removed ${title} (${trackId}) from ${directionKey}/${location}; already assigned to ${existing.directionKey}/${existing.location}`);
          return;
        }

        localSeen.add(trackId);
        globalAssignments.set(trackId, { directionKey, location });
        sanitized.push(entry);
      });

      direction.sampleTracks = sanitized;

      if (direction.oppositeDirection) {
        const oppositeKey = direction.oppositeDirection.key || `${directionKey}_opposite`;
        normalizeStack(oppositeKey, direction.oppositeDirection, 'opposite');
      }
    };

    Object.entries(directions).forEach(([directionKey, direction]) => {
      normalizeStack(directionKey, direction, 'primary');
    });

    const summaryParts = [`${globalAssignments.size} unique tracks retained`];
    if (duplicatesRemoved > 0) {
      summaryParts.push(`removed ${duplicatesRemoved} duplicates`);
    }
    if (missingIdentifiers > 0) {
      summaryParts.push(`dropped ${missingIdentifiers} missing-id entries`);
    }
    console.log(`🧼 STACK SANITIZE: ${summaryParts.join(', ')}`);

    return directions;
  }

  // Remove directions that lost all candidates after sanitization
  removeEmptyDirections(directions) {
    if (!directions || typeof directions !== 'object') {
      return directions;
    }

    const cleaned = {};

    Object.entries(directions).forEach(([directionKey, direction]) => {
      const primaryTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
      const hasPrimaryTracks = primaryTracks.length > 0;

      const opposite = direction.oppositeDirection;
      const oppositeTracks = Array.isArray(opposite?.sampleTracks) ? opposite.sampleTracks : [];
      const hasOppositeTracks = oppositeTracks.length > 0;

      if (hasPrimaryTracks) {
        if (opposite && !hasOppositeTracks) {
          console.warn(`🧼 STACK SANITIZE: Dropping empty opposite stack for ${directionKey}`);
          direction.hasOpposite = false;
          delete direction.oppositeDirection;
        }
        cleaned[directionKey] = direction;
        return;
      }

      if (hasOppositeTracks) {
        const promotedKey = opposite.key || `${directionKey}_opposite`;
        console.warn(`🧼 STACK SANITIZE: Promoting opposite stack ${promotedKey} after ${directionKey} lost all candidates`);
        cleaned[promotedKey] = {
          ...opposite,
          hasOpposite: false
        };
        return;
      }

      console.warn(`🧼 STACK SANITIZE: Removing ${directionKey} entirely (no candidates remain)`);
    });

    return cleaned;
  }

  // ⚖️ Prioritize bidirectional directions: larger stack becomes primary, smaller becomes opposite
  prioritizeBidirectionalDirections(directions) {
    explorerLog(`⚖️ PRIORITIZATION START: Processing ${Object.keys(directions).length} directions`);
    explorerLog(`⚖️ Direction keys:`, Object.keys(directions));

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

      explorerLog(`⚖️ CHECKING: ${directionKey} -> positive: ${!!positiveMatch}, negative: ${!!negativeMatch}`);

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

          explorerLog(`⚖️ BIDIRECTIONAL PAIR: ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

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
            explorerLog(`⚖️ Equal sizes (${positiveSamples} samples), preferring positive for ${baseKey}`);
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

          explorerLog(`⚖️ PRIMARY: ${primaryKey} (${primaryDirection.sampleTracks?.length || 0} tracks) with embedded opposite ${oppositeKey} (${oppositeDirection.sampleTracks?.length || 0} tracks)`);

          processedKeys.add(directionKey);
          processedKeys.add(negativeKey);
        } else {
          explorerLog(`⚖️ BIDIRECTIONAL PAIR: nothing found for negative ${negativeKey}`);
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
          explorerLog(`⚖️ NEGATIVE MATCH using embedded positive for ${baseKey}`);

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

          explorerLog(`⚖️ BIDIRECTIONAL PAIR (negative first): ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

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
          explorerLog(`⚖️ BIDIRECTIONAL PAIR: nothing found for positive ${positiveKey}`);
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

    explorerLog(`⚖️ BIDIRECTIONAL PRIORITIZATION: Processed ${Object.keys(directions).length} dimensions -> ${Object.keys(finalDirections).length} final dimensions`);
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
  async limitToTopDimensions(directions, maxDimensions = 12) {
    // Define core indices that should be prioritized
    const coreIndices = [
      'bpm', 'danceability', 'onset_rate', 'beat_punch', 'tonal_clarity',
      'spectral_centroid', 'spectral_energy', 'sub_drive', 'air_sizzle',
      'chord_strength', 'tuning_purity', 'fifths_strength'
    ];
    console.log(`📊 Defined core indices: [${coreIndices.join(', ')}]`);

    const logVaeSummary = (tag, map) => {
      const vaeDimensions = Array.from(map.entries())
        .filter(([_, dirs]) => Array.isArray(dirs) && dirs.some(dir => dir?.domain === 'vae'))
        .map(([name, dirs]) => ({
          name,
          count: dirs.filter(dir => dir?.domain === 'vae').length,
          total: dirs.length
        }));

      if (vaeDimensions.length > 0) {
        console.log(`🧠 VAE visibility (${tag}):`, vaeDimensions);
      } else {
        console.log(`🧠 VAE visibility (${tag}): none`);
      }
    };

    const dimensionMap = new Map();
    const coreMap = new Map();
    const pcaMap = new Map();
    const vaeMap = new Map();

    // Group directions by their base dimension and classify as core or PCA
    const directionEntries = Object.entries(directions);
    console.log(`🔍 Processing ${directionEntries.length} directions for dimension classification...`);
    for (let idx = 0; idx < directionEntries.length; idx++) {
      const [key, directionInfo] = directionEntries[idx];
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
      if (directionObj.vae && !directionObj.domain) {
        directionObj.domain = 'vae';
      }

      // Classify as core or PCA dimension
      const domain = directionObj.domain || null;
      const isCore = coreIndices.includes(dimensionName);
      if (domain === 'vae') {
        console.log('🧠 VAE direction candidate detected', {
          key,
          dimensionName,
          trackCount: directionObj.sampleTracks?.length || 0,
          diversityScore: directionObj.diversityScore,
          isOutlier: directionObj.isOutlier
        });
      }
      console.log(`🔍   Is '${dimensionName}' a core index? ${isCore}`);
      if (isCore) {
        console.log(`✅   Adding '${dimensionName}' to CORE map`);
      } else if (domain === 'vae') {
        console.log(`🧠   Adding '${dimensionName}' to VAE map`);
      } else {
        console.log(`🧮   Adding '${dimensionName}' to PCA map`);
      }
      let targetMap;
      if (isCore) {
        targetMap = coreMap;
      } else if (domain === 'vae') {
        targetMap = vaeMap;
      } else {
        targetMap = pcaMap;
      }

      if (!targetMap.has(dimensionName)) {
        targetMap.set(dimensionName, []);
      }
      targetMap.get(dimensionName).push(directionObj);

      // Also add to general map for fallback
      if (!dimensionMap.has(dimensionName)) {
        dimensionMap.set(dimensionName, []);
      }
      dimensionMap.get(dimensionName).push(directionObj);
      // Yield to the event loop periodically so audio streaming keeps flowing
      if ((idx + 1) % 5 === 0) {
        await setImmediatePromise();
      }
    }

    logVaeSummary('post-grouping', dimensionMap);
    logVaeSummary('core-map', coreMap);
    logVaeSummary('pca-map', pcaMap);
    logVaeSummary('vae-map', vaeMap);

    console.log(`🔍 Classification complete:`);
    console.log(`🔍   Core indices found: [${Array.from(coreMap.keys()).join(', ')}]`);
    console.log(`🔍   PCA indices found: [${Array.from(pcaMap.keys()).join(', ')}]`);
    console.log(`🔍   Total dimensions: [${Array.from(dimensionMap.keys()).join(', ')}]`);

    const selectedDirections = {};

    // Calculate quota: 50/50 split between core and PCA indices
    const totalVaeDirections = Array.from(vaeMap.values()).reduce((sum, dirs) => sum + dirs.length, 0);
    const remainingSlots = Math.max(maxDimensions - totalVaeDirections, 0);
    const coreQuota = Math.floor(remainingSlots / 2);
    const pcaQuota = remainingSlots - coreQuota;
    console.log(`🎯 Dimension quota: ${coreQuota} core indices, ${pcaQuota} PCA dimensions (max: ${maxDimensions})`);
    console.log(`🎯 Available dimensions: ${coreMap.size} core, ${pcaMap.size} PCA, ${vaeMap.size} VAE groups (${totalVaeDirections} directions), ${dimensionMap.size} total`);

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
      const topDirection = sortedDirs[0];

      if (sortedDirs.length >= 2) {
        const isVaeDimension = sortedDirs.some(dir => dir.domain === 'vae');
        if (isVaeDimension) {
          console.log(`✅   -> Keeping all VAE directions for '${dimName}' (${sortedDirs.length} variants)`);
          return sortedDirs;
        }
        const limited = sortedDirs.slice(0, 2);
        console.log(`✅   -> Keeping both polarities for '${dimName}' (primary '${limited[0].key}', secondary '${limited[1].key}')`);
        return limited;
      }

      console.log(`✅   -> Only one usable direction '${topDirection.key}' for '${dimName}' (${topDirection.trackCount} tracks, diversity: ${topDirection.diversityScore?.toFixed(1)})`);
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

    const coreCandidates = [];
    const coreEntries = Array.from(coreMap.entries());
    for (let idx = 0; idx < coreEntries.length; idx++) {
      const [dimName, dirList] = coreEntries[idx];
      const candidate = {
        dimName,
        bestDirections: selectBestDirections(dirList, dimName),
        isCore: true,
        allDirections: dirList.length,
        validDirections: dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier).length
      };
      coreCandidates.push(candidate);
      if ((idx + 1) % 3 === 0) {
        await setImmediatePromise();
      }
    }

    const vaeCandidates = Array.from(vaeMap.entries()).map(([dimName, dirList]) => ({
      dimName,
      bestDirections: selectBestDirections(dirList, dimName),
      isCore: false,
      isVae: true
    })).filter(dim => dim.bestDirections.length > 0);

    const limitedVaeDimensions = vaeCandidates.slice(0, maxDimensions);

    const sortedCoreDimensions = coreCandidates
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
    const pcaCandidates = [];
    const pcaEntries = Array.from(pcaMap.entries());
    for (let idx = 0; idx < pcaEntries.length; idx++) {
      const [dimName, dirList] = pcaEntries[idx];
      pcaCandidates.push({
        dimName,
        bestDirections: selectBestDirections(dirList, dimName),
        isCore: false
      });
      if ((idx + 1) % 3 === 0) {
        await setImmediatePromise();
      }
    }

    const sortedPcaDimensions = pcaCandidates
      .filter(dim => dim.bestDirections.length > 0) // Only dimensions with valid directions
      .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
      .slice(0, pcaQuota);

    console.log(`🎯 Selected ${sortedPcaDimensions.length} PCA dimensions:`,
      sortedPcaDimensions.map(d => d.dimName));

    // Combine core and PCA selections
    const finalDimensions = [...limitedVaeDimensions, ...sortedCoreDimensions, ...sortedPcaDimensions];

    // If we don't have enough dimensions (shouldn't happen), fill from general pool
    if (finalDimensions.length < maxDimensions) {
      const usedDimensions = new Set(finalDimensions.map(d => d.dimName));
      const remainingCandidates = [];
      const dimensionEntries = Array.from(dimensionMap.entries())
        .filter(([dimName]) => !usedDimensions.has(dimName));

      for (let idx = 0; idx < dimensionEntries.length; idx++) {
        const [dimName, dirList] = dimensionEntries[idx];
        remainingCandidates.push({
          dimName,
          bestDirections: selectBestDirections(dirList, dimName),
          isCore: false
        });
        if ((idx + 1) % 5 === 0) {
          await setImmediatePromise();
        }
      }

      const remainingDimensions = remainingCandidates
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
      .filter(([_, dir]) => (dir.actualTrackCount ?? dir.trackCount ?? 0) > 0 && !dir.isOutlier)
      .map(([key, dir]) => {
        const baseScore = dir.adjustedDiversityScore ?? dir.diversityScore ?? 0;
        const isOriginalFeature = dir.domain === 'original';
        const weightedScore = isOriginalFeature ? baseScore * 1.5 : baseScore;

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
    const playedTrackIds = new Set(this.sessionHistory.map(entry => entry.identifier));
    if (this.currentTrack?.identifier) {
      playedTrackIds.add(this.currentTrack.identifier);
    }

    let selectedDirectionKey = null;
    let selectedDirection = null;
    let selectedTrack = null;
    let skippedCandidates = 0;

    for (const [directionKey, directionData] of validDirections) {
      if (!Array.isArray(directionData.sampleTracks) || directionData.sampleTracks.length === 0) {
        continue;
      }

      const candidateIndex = directionData.sampleTracks.findIndex(candidate => {
        const candidateId = candidate?.identifier || candidate?.track?.identifier;
        return candidateId && !playedTrackIds.has(candidateId);
      });

      if (candidateIndex === -1) {
        skippedCandidates += directionData.sampleTracks.length;
        continue;
      }

      selectedDirectionKey = directionKey;
      selectedDirection = directionData;
      selectedTrack = directionData.sampleTracks[candidateIndex];

      if (candidateIndex > 0) {
        skippedCandidates += candidateIndex;
      }

      break;
    }

    if (!selectedTrack) {
      const [fallbackDirectionKey, fallbackDirection] = validDirections[0];
      selectedDirectionKey = fallbackDirectionKey;
      selectedDirection = fallbackDirection;
      selectedTrack = fallbackDirection.sampleTracks[0];
      console.warn('🎯📼 All candidate tracks were repeats; falling back to top-ranked option');
    }

    const selectedTrackId = selectedTrack?.identifier || selectedTrack?.track?.identifier || 'unknown';
    const weightedScore = selectedDirection.weightedDiversityScore || selectedDirection.diversityScore;
    const directionLabel = selectedDirection.direction || selectedDirectionKey;
    const domainLabel = selectedDirection.domain === 'original' ? '📊 Original' : '🧮 PCA';
    const componentDetail = selectedDirection.domain !== 'original' ?
      ` [${selectedDirection.domain}_${selectedDirection.component}_${selectedDirection.polarity}]` :
      ` [${selectedDirection.component}_${selectedDirection.polarity}]`;

    if (skippedCandidates > 0) {
      console.log(`🎯 Skipped ${skippedCandidates} previously played candidates before selecting '${selectedTrack?.title || selectedTrackId}'`);
    }

    console.log(`🎯 Next track selected from direction '${directionLabel}'${componentDetail} (${domainLabel}, weighted diversity: ${weightedScore.toFixed(1)})`);

    const distanceSlices = selectedTrack.distanceSlices
      || selectedTrack.featureDistanceSlices
      || selectedTrack.pcaDistanceSlices;
    if (distanceSlices?.slices?.length) {
      const referenceLabel = distanceSlices.reference?.key || distanceSlices.referenceKey || 'n/a';
      const referenceDist = Number(distanceSlices.reference?.distance ?? distanceSlices.referenceDistance ?? 0);
      const topSlices = [...distanceSlices.slices]
        .sort((a, b) => {
          const aRel = a.relative !== null && a.relative !== undefined ? Math.abs(Number(a.relative)) : 0;
          const bRel = b.relative !== null && b.relative !== undefined ? Math.abs(Number(b.relative)) : 0;
          if (aRel !== bRel) {
            return bRel - aRel;
          }
          const aFrac = a.fraction !== null && a.fraction !== undefined ? Math.abs(Number(a.fraction)) : 0;
          const bFrac = b.fraction !== null && b.fraction !== undefined ? Math.abs(Number(b.fraction)) : 0;
          if (aFrac !== bFrac) {
            return bFrac - aFrac;
          }
          return Math.abs(Number(b.delta || 0)) - Math.abs(Number(a.delta || 0));
        })
        .slice(0, 6)
        .map(slice => {
          const rel = slice.relative !== null && slice.relative !== undefined
            ? `${Number(slice.relative).toFixed(3)}×`
            : 'n/a';
          const frac = slice.fraction !== null && slice.fraction !== undefined
            ? Number(slice.fraction).toFixed(3)
            : 'n/a';
          const delta = slice.delta !== null && slice.delta !== undefined
            ? Number(slice.delta).toFixed(3)
            : 'n/a';
          const marker = referenceLabel && slice.key === referenceLabel ? '★' : '';
          return `${slice.key}${marker} Δ=${delta} rel=${rel} frac=${frac}`;
        });
      console.log(`🧭 Contribution breakdown (reference=${referenceLabel}, refDist=${referenceDist.toFixed(4)}): ${topSlices.join(' | ')}`);
    }

    return {
      ...selectedTrack,
      nextTrackDirection: selectedDirection.direction,
      transitionReason: 'explorer', // Roaming free based on diversity
      diversityScore: selectedDirection.diversityScore,
      weightedDiversityScore: selectedDirection.weightedDiversityScore,
      domain: selectedDirection.domain,
      directionKey: selectedDirectionKey,
      directionDescription: selectedDirection.description
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
        const sampleTracks = this.selectStrategicSamples(filteredCandidates, this.currentTrack);

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
      recentHistory: driftState.recentHistory,
      // Stack-based journey info
      sessionType: this.sessionType,
      sessionName: this.sessionName,
      stackLength: this.stack.length,
      stackIndex: this.stackIndex,
      positionSeconds: this.positionSeconds,
      ephemeral: this.ephemeral,
      canAdvance: !this.isAtStackEnd()
    };
  }

  // ==================== STACK MANAGEMENT METHODS ====================

  // Initialize session as named or playlist session
  initializeSession(sessionType, sessionName, initialStack = null) {
    this.sessionType = sessionType; // 'named', 'playlist', 'anonymous'
    this.sessionName = sessionName;
    
    if (initialStack) {
      this.stack = [...initialStack];
      this.stackIndex = 0;
      this.positionSeconds = 0;
    } else if (sessionType === 'anonymous') {
      // For anonymous sessions, build retroactive stack when tracks are available
      // This will be called again from ensureTrackInStack when first track loads
      this.buildRetroactiveStack();
    }
    
    this.ephemeral = false;
    console.log(`📚 Initialized session: ${sessionType} (${sessionName || 'anonymous'})`);
  }

  // Build stack from current session state (for anonymous sessions)
  buildRetroactiveStack() {
    this.stack = [];
    
    if (this.currentTrack) {
      this.stack.push({
        identifier: this.currentTrack.identifier,
        direction: null, // First track has no incoming direction
        scope: this.explorerResolution || 'magnify'
      });
    }
    
    if (this.nextTrack) {
      this.stack.push({
        identifier: this.nextTrack.identifier,
        direction: this.driftPlayer.getDriftState().currentDirection || null,
        scope: this.explorerResolution || 'magnify'
      });
      this.stackIndex = 0; // Currently on first track
    } else {
      this.stackIndex = 0;
    }
  }

  // Add track to stack (organic exploration)
  pushToStack(identifier, direction = null, scope = 'magnify') {
    if (this.ephemeral) {
      console.log('📚 Session is ephemeral, not adding to stack');
      return;
    }

    if (this.sessionType === 'playlist') {
      console.log('📚 Playlist session is read-only, not adding to stack');
      return;
    }

    const stackItem = {
      identifier,
      direction,
      scope
    };

    this.stack.push(stackItem);
    console.log(`📚 Added to stack: ${identifier} (${this.stack.length} total)`);
    
    // Notify of stack change
    this.broadcastStackUpdate();
  }

  // Navigate to specific position in stack
  jumpToStackPosition(index, positionSeconds = 0) {
    if (index < 0 || index >= this.stack.length) {
      throw new Error(`Invalid stack index: ${index} (stack length: ${this.stack.length})`);
    }

    this.stackIndex = index;
    this.positionSeconds = positionSeconds;
    
    const stackItem = this.stack[index];
    console.log(`📚 Jumping to stack position ${index}: ${stackItem.identifier} at ${positionSeconds}s`);
    
    // Load the track at this position
    this.loadTrackFromStack(stackItem);
    
    // Broadcast position change
    this.broadcastStackUpdate();
  }

  // Load track from stack item
  async loadTrackFromStack(stackItem) {
    const track = this.radialSearch.kdTree.getTrack(stackItem.identifier);
    if (!track) {
      throw new Error(`Track not found: ${stackItem.identifier}`);
    }

    // Set the track as current
    this.currentTrack = this.hydrateTrackRecord(track);
    this.pendingCurrentTrack = null;
    
    // Start playback at specified position
    await this.playCurrentTrack();
    
    if (this.positionSeconds > 0) {
      // TODO: Implement seeking to positionSeconds
      console.log(`🎵 Would seek to ${this.positionSeconds}s in track`);
    }
  }

  // Check if we're at the end of the stack
  isAtStackEnd() {
    return this.stackIndex >= this.stack.length - 1;
  }

  // Move to next track in stack
  advanceInStack() {
    if (this.isAtStackEnd()) {
      console.log('📚 Reached end of stack, entering ephemeral mode');
      this.ephemeral = true;
      return false;
    }

    this.stackIndex++;
    this.positionSeconds = 0;
    
    const stackItem = this.stack[this.stackIndex];
    console.log(`📚 Advancing to stack position ${this.stackIndex}: ${stackItem.identifier}`);
    
    this.loadTrackFromStack(stackItem);
    this.broadcastStackUpdate();
    return true;
  }

  // Get current stack state for export/serialization
  getStackState() {
    return {
      sessionType: this.sessionType,
      sessionName: this.sessionName,
      stack: [...this.stack],
      stackIndex: this.stackIndex,
      positionSeconds: this.positionSeconds,
      ephemeral: this.ephemeral,
      created: this.created || new Date().toISOString(),
      lastAccess: new Date().toISOString()
    };
  }

  // Load state from serialized stack
  loadStackState(state) {
    this.sessionType = state.sessionType || 'anonymous';
    this.sessionName = state.sessionName || null;
    this.stack = [...(state.stack || [])];
    this.stackIndex = state.stackIndex || 0;
    this.positionSeconds = state.positionSeconds || 0;
    this.ephemeral = state.ephemeral || false;
    this.created = state.created || new Date().toISOString();
    
    console.log(`📚 Loaded stack state: ${this.stack.length} tracks, position ${this.stackIndex}`);
    
    // Load current track if stack is not empty
    if (this.stack.length > 0 && this.stackIndex < this.stack.length) {
      const currentStackItem = this.stack[this.stackIndex];
      this.loadTrackFromStack(currentStackItem);
    }
  }

  // Broadcast stack update to SSE clients
  broadcastStackUpdate() {
    const stackInfo = {
      stackLength: this.stack.length,
      stackIndex: this.stackIndex,
      positionSeconds: this.positionSeconds,
      ephemeral: this.ephemeral,
      canAdvance: !this.isAtStackEnd(),
      currentStackItem: this.stack[this.stackIndex] || null
    };

    this.broadcastToEventClients('stack_update', stackInfo);
    
    // Trigger persistence for named sessions
    this.persistSessionState();
  }

  // Persist session state (event-driven)
  persistSessionState() {
    if (this.sessionType === 'named' && !this.ephemeral) {
      // Store in memory for now (in-memory session registry)
      const stackState = this.getStackState();
      console.log(`💾 Persisting named session state: ${this.sessionName} (${this.stack.length} tracks)`);
      
      // Store in global memory registry
      if (typeof global !== 'undefined') {
        global.namedSessionRegistry = global.namedSessionRegistry || new Map();
        global.namedSessionRegistry.set(this.sessionName, stackState);
      }
    }
  }

  // Ensure track is in stack (for initial track or stack gaps)
  ensureTrackInStack(identifier) {
    // Check if stack is empty or track is not at current position
    if (this.stack.length === 0) {
      // First track - add as seed with no direction
      this.pushToStack(identifier, null, this.explorerResolution || 'magnify');
      this.stackIndex = 0;
      this.positionSeconds = 0;
      console.log(`📚 Added seed track to stack: ${identifier}`);
    } else if (this.stackIndex < this.stack.length && 
               this.stack[this.stackIndex].identifier !== identifier) {
      // Track mismatch - this shouldn't happen in normal flow but handle gracefully
      console.warn(`📚 Track mismatch in stack at position ${this.stackIndex}: expected ${this.stack[this.stackIndex].identifier}, got ${identifier}`);
      // Could either fix the stack or log for debugging
    }
    
    // Update position tracking
    this.positionSeconds = 0;
  }

  // ==================== END STACK MANAGEMENT ====================

  // Get the adjusted track duration from advanced audio mixer
  getAdjustedTrackDuration(track = this.currentTrack, { logging = true } = {}) {
    // Try to get the adjusted duration from the advanced audio mixer when querying the active track
    const mixerStatus = typeof this.audioMixer?.getStatus === 'function' ? this.audioMixer.getStatus() : null;
    const estimatedDuration = mixerStatus?.currentTrack?.estimatedDuration;
    const usingActiveTrack = track && this.currentTrack && track.identifier === this.currentTrack.identifier;

    if (usingActiveTrack && Number.isFinite(estimatedDuration) && estimatedDuration > 0) {
      if (logging) {
        if (track?.length) {
          console.log(`📏 Using adjusted track duration: ${estimatedDuration.toFixed(1)}s (original: ${track.length}s)`);
        } else {
          console.log(`📏 Using adjusted track duration: ${estimatedDuration.toFixed(1)}s (no original length available)`);
        }
      }
      return estimatedDuration;
    }

    // Fallback to original duration if mixer doesn't have adjusted duration yet
    if (track?.length) {
      if (logging) {
        console.log(`📏 Using original track duration: ${track.length}s (mixer not ready)`);
      }
      return track.length;
    }

    if (logging) {
      console.warn('📏 Unable to determine track duration; returning 0');
    }
    return 0;
  }

  // Clean up
  destroy() {
    console.log(`🧹 Destroying drift mixer for session: ${this.sessionId}`);
    this.stopStreaming();

    fingerprintRegistry.removeBySession(this.sessionId);

    if (this.pendingUserSelectionTimer) {
      clearTimeout(this.pendingUserSelectionTimer);
      this.pendingUserSelectionTimer = null;
    }

    if (this.autoRecoveryTimer) {
      clearTimeout(this.autoRecoveryTimer);
      this.autoRecoveryTimer = null;
    }

    this.pendingPreparationPromise = null;
    this.isUserSelectionPending = false;
    this.lockedNextTrackIdentifier = null;
    this.userSelectionDeferredForCrossfade = false;
    this.nextTrackLoadPromise = null;
    this.crossfadeStartedAt = null;

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
