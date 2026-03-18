const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { setImmediate: setImmediatePromise } = require('timers/promises');
const DirectionalDriftPlayer = require('./directional-drift-player');
const AdvancedAudioMixer = require('./advanced-audio-mixer');
const fingerprintRegistry = require('./fingerprint-registry');
const { getTrackTitle } = require('./schemas/track-definitions');
const { MixerMetadata, validate } = require('./contracts-zod');
const ep = require('./services/explorer-pipeline');
const mb = require('./services/mixer-broadcast');
const tu = require('./services/track-utils');
const ExplorerCache = require('./services/explorer-cache');
const SessionState = require('./services/session-state');

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
const STREAM_IDLE_GRACE_MS = 5000;
const STREAM_OVERRIDE_GRACE_MS = 20000;
const HEARTBEAT_DIVERGENCE_THRESHOLD_MS = 2000;
const HEARTBEAT_ELAPSED_OVERSHOOT_WARN_MS = 4000;

// Re-export from extracted modules for local use
const { cloneAndSanitizeBeetsMeta } = tu;

class DriftAudioMixer {
  constructor(sessionId, radialSearch) {
    this.radialSearch = radialSearch;
    this.clients = new Set();
    this.eventClients = new Set(); // SSE clients for real-time events
    this.isActive = false;
    this.currentProcess = null;
    this.driftPlayer = new DirectionalDriftPlayer(radialSearch);
    this.halfwayFiredForTrack = null; // Track ID for which halfway was already fired
    this.onHalfwayReached = null;     // Callback: (identifier) => void
    this.onExplorerNeeded = null;     // Callback: async (trackId, opts) => explorerData|null — defer to worker
    this.pendingCurrentTrack = null;
    this.nextTrack = null;
    this.explorerRecommendedNext = null; // Sticky recommendation from explorer endpoint
    this.isTransitioning = false;
    this._lastBroadcastTrackId = null;
    this.lastTrackEventPayload = null;
    this.lastTrackEventTimestamp = 0;

    // Exploration event data
    this.explorerEventHistory = [];
    this.maxExplorerEventHistory = 200;

    // Session-level explorer data cache with TTL and eviction
    this.explorerDataCache = new ExplorerCache({ maxEntries: 50, ttlMs: 5 * 60 * 1000 });

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
    this.currentExplorerSummary = null;
    this.explorerHistory = [];
    this.maxExplorerHistory = 5;
    this.sessionEvents = [];
    this.maxSessionEvents = 200;

    // Cleanup callback supplied by session manager
    this.onIdle = null;
    this.cleanupTimer = null;
    this.streamingStopTimer = null;
    this.persistedOverrideState = null;

    // Explorer configuration (non-session)
    this.adaptiveRadiusCache = new Map();
    this.currentAdaptiveRadius = null;
    this.currentNeighborhoodSnapshot = null;
    this.pendingExplorerPromise = null;
    this.lastExplorerSnapshotSummary = null;
    this.pendingCrossfadePrepTimer = null;
    this.dynamicRadiusState = {
      currentRadius: null,
      minRadius: 0.05,
      maxRadius: 2.0,
      starvationStreak: 0,
      abundanceStreak: 0,
      lastAdjustment: null
    };

    // Track loading state to prevent concurrent playCurrentTrack calls
    this.currentTrackLoadingPromise = null; // Seeding vs seeded distinction

    // Audio configuration
    this.sampleRate = config.audio.sampleRate;
    this.channels = config.audio.channels;
    this.bitRate = config.audio.bitRate;

    this.pendingTrackReadyResolvers = new Set();
    this.liveStreamState = {
      trackId: null,
      title: null,
      artist: null,
      startedAt: null,
      lastChunkAt: null,
      chunkBytes: 0
    };

    // Session state (serializable)
    const explorerConfig = config.explorer || {};
    const totalCount = explorerConfig.stackTotalCount;
    const randomCount = explorerConfig.stackRandomCount;
    this.state = new SessionState({
      sessionId,
      stackTotalCount: Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 15,
      stackRandomCount: Number.isFinite(randomCount) && randomCount >= 0
        ? Math.min(Math.floor(randomCount), Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 15)
        : Math.min(3, Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 15),
    });

    // Initialize advanced audio mixer
    this.audioMixer = new AdvancedAudioMixer({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitRate: this.bitRate
    });

    // Set up mixer callbacks
    this.audioMixer.onData = (chunk) => {
      this.recordLivePlaybackChunk(chunk);
      this.broadcastToClients(chunk);
    };

    // Provide client count checker to avoid streaming to nobody
    this.audioMixer.hasClients = () => {
      return this.clients.size > 0;
    };

    this.audioMixer.onTrackStart = (reason) => {
      console.log(`🎵 Advanced mixer: Track started (${reason || 'normal'})`);

      let promoted = false;

      // Use audioMixer's metadata as source of truth for what's actually playing
      const mixerMetadata = this.audioMixer.getCurrentPlaybackMetadata();
      const metadataResult = validate(MixerMetadata, mixerMetadata);
      if (!metadataResult.success) {
        console.warn('⚠️ Invalid mixer metadata shape:', metadataResult.error.flatten());
      }
      const mixerTrackId = metadataResult.success ? metadataResult.data.identifier : null;

      if (this.pendingCurrentTrack) {
        // Verify pendingCurrentTrack matches what mixer is playing
        if (mixerTrackId && this.pendingCurrentTrack.identifier !== mixerTrackId) {
          console.warn(`⚠️ pendingCurrentTrack mismatch: expected ${this.pendingCurrentTrack.identifier?.substring(0,8)}, mixer has ${mixerTrackId.substring(0,8)}`);
          // Use mixer's track instead
          this.state.currentTrack = this.hydrateTrackRecord(mixerMetadata) || mixerMetadata;
        } else {
          this.state.currentTrack = this.pendingCurrentTrack;
        }
        this.pendingCurrentTrack = null;
        promoted = true;
      } else if (reason === 'crossfade_complete') {
        // Check if user selected a different track during crossfade
        const userOverrideActive = this.pendingUserOverrideTrackId &&
            mixerTrackId && this.pendingUserOverrideTrackId !== mixerTrackId;

        if (userOverrideActive) {
          console.log(`🎯 Skipping promotion - user selected ${this.pendingUserOverrideTrackId?.substring(0,8)}, but mixer playing ${mixerTrackId?.substring(0,8)}`);
          this.nextTrack = null;
          // Don't set promoted = true - the deferred override will handle setting currentTrack
        } else if (mixerTrackId) {
          // Use mixer's metadata as source of truth, hydrate with full track info
          const hydratedFromMixer = this.hydrateTrackRecord(mixerMetadata);
          if (hydratedFromMixer) {
            this.state.currentTrack = hydratedFromMixer;
          } else if (this.nextTrack?.identifier === mixerTrackId) {
            // Mixer matches our nextTrack, use the richer nextTrack data
            this.state.currentTrack = this.hydrateTrackRecord(this.nextTrack) || this.nextTrack;
          } else {
            // Fallback to mixer metadata directly
            console.warn(`⚠️ nextTrack mismatch: expected ${this.nextTrack?.identifier?.substring(0,8)}, mixer has ${mixerTrackId.substring(0,8)}`);
            this.state.currentTrack = mixerMetadata;
          }
          this.nextTrack = null;
          promoted = true;
        } else if (this.nextTrack) {
          // No mixer metadata available, fall back to nextTrack
          this.state.currentTrack = this.hydrateTrackRecord(this.nextTrack) || this.nextTrack;
          this.nextTrack = null;
          promoted = true;
        }
      }

      // Handle stack initialization for first track
      if (promoted && this.state.currentTrack && this.state.currentTrack.identifier) {
        this.ensureTrackInStack(this.state.currentTrack.identifier);
      }

      if (promoted && this.state.currentTrack && this.lockedNextTrackIdentifier === this.state.currentTrack.identifier) {
        this.lockedNextTrackIdentifier = null;
      }

      // Clear stale cached nextTrack when track is promoted
      if (promoted && this.lastExplorerSnapshotPayload?.nextTrack?.track?.identifier === this.state.currentTrack?.identifier) {
        this.lastExplorerSnapshotPayload.nextTrack = null;
      }
      // Clear explorer recommendation only if the recommended track is now playing
      if (promoted && this.explorerRecommendedNext?.trackId === this.state.currentTrack?.identifier) {
        this.explorerRecommendedNext = null;
      }

      if (promoted) {
        this.resetManualOverrideLock();

        // Reset live stream state to match the newly promoted track
        // This prevents stale timing from propagating to heartbeats
        const promotedTrackId = this.state.currentTrack?.identifier || null;
        if (promotedTrackId) {
          this.liveStreamState = {
            trackId: promotedTrackId,
            title: this.state.currentTrack?.title || null,
            artist: this.state.currentTrack?.artist || null,
            startedAt: Date.now(),
            lastChunkAt: Date.now(),
            chunkBytes: 0
          };
        }

        // Add track to session history for repeat prevention
        if (this.state.currentTrack && this.state.currentTrack.identifier) {
          const alreadyInHistory = this.state.sessionHistory.some(
            entry => entry.identifier === this.state.currentTrack.identifier
          );
          if (!alreadyInHistory) {
            this.addToHistory(
              this.state.currentTrack,
              Date.now(),
              this.driftPlayer?.currentDirection || null,
              reason || 'promoted'
            );
            console.log(`📝 Added to session history: ${this.state.currentTrack.title} (${this.state.sessionHistory.length} total)`);
          }
        }
      }

      if (reason === 'crossfade_complete') {
        this.crossfadeStartedAt = null;
        // Apply pending user override if one exists (either deferred during crossfade or set before)
        const shouldApplyOverride = this.pendingUserOverrideTrackId &&
            (!this.state.currentTrack || this.state.currentTrack.identifier !== this.pendingUserOverrideTrackId);
        this.userSelectionDeferredForCrossfade = false;
        if (shouldApplyOverride) {
          console.log(`🎯 Applying pending user override after crossfade: ${this.pendingUserOverrideTrackId?.substring(0,8)}`);
          setTimeout(() => {
            this.applyUserSelectedTrackOverride(this.pendingUserOverrideTrackId);
          }, 0);
        }
      }

      if (reason !== 'crossfade_complete') {
        this.crossfadeStartedAt = null;
        this.userSelectionDeferredForCrossfade = false;
      }

      // When a track is promoted, ALWAYS use fresh timestamp - engine's streamingStartTime may be stale
      // from a previous track or preparation phase. The visual timing should reset to NOW.
      const now = Date.now();
      const engineStartTime = this.audioMixer?.engine?.streamingStartTime;

      // Use engine time only if it's recent (within last 5 seconds) - otherwise it's stale
      const engineTimeIsRecent = engineStartTime && (now - engineStartTime) < 5000;
      this.state.trackStartTime = (promoted && !engineTimeIsRecent) ? now : (engineStartTime || now);

      const playbackMetadataSeconds = Number.isFinite(this.state.currentTrack?.length)
        ? this.state.currentTrack.length
        : Number.isFinite(this.state.currentTrack?.duration)
          ? this.state.currentTrack.duration
          : null;
      const playbackTrimmedSeconds = this.audioMixer?.engine?.currentTrack?.estimatedDuration || null;
      // Apply the promoted track's direction to drift state (deferred from user selection)
      if (promoted && this.state.currentTrack?.direction && this.driftPlayer) {
        this.driftPlayer.currentDirection = this.state.currentTrack.direction;
      }
      this.state.currentTrackDirection = this.driftPlayer?.currentDirection || null;
      console.log('🕒 [timing] Track playback started', {
        trackId: this.state.currentTrack?.identifier || null,
        title: this.state.currentTrack?.title || null,
        metadataSeconds: playbackMetadataSeconds,
        trimmedSeconds: playbackTrimmedSeconds,
        startTimestamp: this.state.trackStartTime
      });
      if (!this.state.currentTrack) {
        console.warn('📡 Track started but currentTrack is undefined; pending metadata may be missing');
        return;
      }

      // Rotate fingerprint FIRST so heartbeat has correct fingerprint
      const identifier = this.state.currentTrack.identifier || null;
      if (identifier) {
        const fingerprint = fingerprintRegistry.rotateFingerprint(
          this.state.sessionId,
          {
            trackId: identifier,
            startTime: this.state.trackStartTime
          }
        );
        this.currentFingerprint = fingerprint;
      }

      console.log(`📡 Audio started - now broadcasting track event: ${this.state.currentTrack.title}`);
      this.broadcastTrackEvent(true, { reason: reason || 'track-started' }).catch(err => {
        console.error('📡 Failed to broadcast track event:', err);
      });
      this.resolvePendingTrackReady(true);
      this.recordSessionEvent('track_started', {
        trackId: this.state.currentTrack.identifier || null,
        title: this.state.currentTrack.title || '',
        reason: reason || 'auto',
        startTime: this.state.trackStartTime
      });

      // Kick off next-track preparation after a short delay so audio can stabilize
      this.scheduleAutoCrossfadePrep(reason || 'auto-initial');
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
      this.broadcastHeartbeat('crossfade-start', { force: true }).catch(() => {});
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
    this._preparationInProgress = false;  // Sync guard for concurrent prepare calls
    this.userSelectionDeferredForCrossfade = false;
    this.nextTrackLoadPromise = null;
    this.crossfadeStartedAt = null;
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = 10000;

    console.log(`Created drift audio mixer for session: ${sessionId}`);
  }

  // Helper: Get the opposite direction for a given direction key
  getOppositeDirection(directionKey) {
    return ep.getOppositeDirection(directionKey);
  }

  // ─── Setter methods (Tier 3: formalize web-layer → mixer mutations) ─────

  seedCurrentTrack(track) {
    this.state.currentTrack = track;
    this.state.trackStartTime = Date.now();
  }

  /**
   * Reset mixer state for a fresh journey, then seed with the given track.
   * Replaces the direct property mutation pattern in /:md5 routes.
   */
  resetForJourney(track) {
    if (this.stopStreaming) {
      this.stopStreaming();
    }
    this.isActive = false;
    this.nextTrack = null;
    this.resetManualOverrideLock();
    if (track) {
      this.seedCurrentTrack(track);
    }
  }

  /**
   * Public entry point for user-selected next track.
   * Replaces direct property mutation pattern:
   *   mixer.pendingUserOverrideTrackId = trackMd5
   *   mixer.lockedNextTrackIdentifier = trackMd5
   *   mixer.driftPlayer.currentDirection = direction
   */
  async selectNextTrack(trackMd5, { direction = null, origin = null } = {}) {
    if (typeof this.handleUserSelectedNextTrack === 'function') {
      await this.handleUserSelectedNextTrack(trackMd5, { direction });
    } else if (typeof this.prepareNextTrackForCrossfade === 'function') {
      if (direction && this.driftPlayer) {
        this.driftPlayer.currentDirection = direction;
      }
      this.pendingUserOverrideTrackId = trackMd5;
      this.lockedNextTrackIdentifier = trackMd5;
      await this.prepareNextTrackForCrossfade({
        forceRefresh: true,
        reason: origin || 'user-selection',
        overrideTrackId: trackMd5,
        overrideDirection: direction
      });
    }
  }

  resetStack() {
    this.state.stack = [];
    this.state.stackIndex = 0;
    this.state.positionSeconds = 0;
  }

  getDisplayCurrentTrack() {
    return this.state.currentTrack || null;
  }

  getDisplayTrackStartTime() {
    return this.state.trackStartTime || null;
  }

  getDisplayTrackTiming() {
    const track = this.getDisplayCurrentTrack();
    const startTime = this.getDisplayTrackStartTime();
    if (!track || !Number.isFinite(startTime)) {
      return null;
    }

    const durationSeconds = this.getAdjustedTrackDuration(
      track.identifier && this.state.currentTrack?.identifier === track.identifier ? this.state.currentTrack : track,
      { logging: false }
    ) || track.length || track.duration || null;

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }

    const durationMs = Math.max(Math.round(durationSeconds * 1000), 0);
    const now = Date.now();
    const elapsedMs = Math.max(now - startTime, 0);
    const remainingMs = Math.max(durationMs - Math.min(elapsedMs, durationMs), 0);

    return {
      track,
      startTime,
      durationMs,
      elapsedMs,
      remainingMs
    };
  }

  hasManualOverrideConflict(candidateId) {
    if (this.pendingUserOverrideTrackId && this.pendingUserOverrideTrackId !== candidateId) {
      return true;
    }
    if (
      this.lockedNextTrackIdentifier &&
      this.lockedNextTrackIdentifier !== candidateId &&
      (!this.state.currentTrack || this.state.currentTrack.identifier !== this.lockedNextTrackIdentifier)
    ) {
      return true;
    }
    return false;
  }

  hasActiveManualOverride() {
    return Boolean(
      this.pendingUserOverrideTrackId ||
      (
        this.lockedNextTrackIdentifier &&
        (!this.state.currentTrack || this.state.currentTrack.identifier !== this.lockedNextTrackIdentifier)
      )
    );
  }


  resolvePendingTrackReady(success) {
    if (!this.pendingTrackReadyResolvers || this.pendingTrackReadyResolvers.size === 0) {
      return;
    }
    const resolvers = Array.from(this.pendingTrackReadyResolvers);
    this.pendingTrackReadyResolvers.clear();
    resolvers.forEach(({ resolve, timer }) => {
      if (timer) {
        clearTimeout(timer);
      }
      try {
        resolve(Boolean(success));
      } catch (err) {
        console.warn('⚠️ Track-ready resolver failed:', err?.message || err);
      }
    });
  }

  scheduleAutoCrossfadePrep(reason = 'auto-initial') {
    if (this.pendingCrossfadePrepTimer) {
      clearTimeout(this.pendingCrossfadePrepTimer);
      this.pendingCrossfadePrepTimer = null;
    }

    // Always use a non-zero delay. The 0ms crossfade_complete delay caused a cascade
    // where the just-promoted track was killed 21ms after starting: the synchronous
    // auto-prep selected a new track and loaded it into the current slot before the
    // promoted track could establish.
    const delayMs = reason === 'crossfade_complete' ? 2000 : 8000;
    const deferredReason = `${reason}-deferred`;

    const execute = () => {
      this.pendingCrossfadePrepTimer = null;
      if (!this.isActive) {
        return;
      }
      this.prepareNextTrackForCrossfade({ reason: deferredReason }).catch(err => {
        console.warn('⚠️ Auto crossfade prep failed:', err?.message || err);
      });
    };

    this.pendingCrossfadePrepTimer = setTimeout(execute, delayMs);
  }

  awaitCurrentTrackReady(timeoutMs = 15000) {
    if (this.state.currentTrack && this.state.trackStartTime) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const entry = {
        resolve: (value) => {
          if (!entry.settled) {
            entry.settled = true;
            resolve(Boolean(value));
          }
        },
        settled: false,
        timer: null
      };

      entry.timer = setTimeout(() => {
        if (this.pendingTrackReadyResolvers) {
          this.pendingTrackReadyResolvers.delete(entry);
        }
        entry.resolve(false);
      }, Math.max(1000, timeoutMs));

      if (!this.pendingTrackReadyResolvers) {
        this.pendingTrackReadyResolvers = new Set();
      }

      this.pendingTrackReadyResolvers.add(entry);
    });
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
      this.resolvePendingTrackReady(false);
    }
  }

  // Play the current track using advanced mixer
  buildTrackMetadata(track) {
    return tu.buildTrackMetadata(track);
  }

  async playCurrentTrack() {
    const trackToPlay = this.pendingCurrentTrack || this.state.currentTrack;

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
    this.state.trackStartTime = null;

    // DON'T broadcast yet - wait until track actually starts streaming

    try {
      // Stop any existing streaming before loading new track
      console.log(`🔧 DEBUG: Stopping previous stream before loading new track`);
      this.audioMixer.stopStreaming();

      // Load track into advanced mixer
      console.log(`🔧 DEBUG: About to load track into advanced mixer: ${trackPath}`);
      console.log(`🔧 DEBUG: Current mixer state - isActive: ${this.isActive}, clients: ${this.clients.size}`);

      const trackInfo = await this.audioMixer.loadTrack(trackPath, 'current', this.buildTrackMetadata(trackToPlay));

      const metadataSeconds = Number.isFinite(trackToPlay.length)
        ? trackToPlay.length
        : Number.isFinite(trackToPlay.duration)
          ? trackToPlay.duration
          : null;
      const trimmedSeconds = Number.isFinite(trackInfo?.duration) ? trackInfo.duration : null;
      console.log(`📊 Track analysis: BPM=${trackInfo.bpm}, Key=${trackInfo.key}, Duration=${trackInfo.duration?.toFixed(1)}s`);
      console.log('🕒 [timing] Track load summary', {
        trackId: trackToPlay.identifier,
        title: trackToPlay.title,
        metadataSeconds,
        trimmedSeconds,
        pendingLengthSeconds: this.audioMixer?.engine?.currentTrack?.estimatedDuration || null
      });
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
            if (this.state.currentTrack && this.isActive) {
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

    // If this track is already locked and prepared, no-op — don't clear and re-debounce.
    if (this.lockedNextTrackIdentifier === trackMd5 && this.nextTrack?.identifier === trackMd5) {
      console.log(`🎯 [override] ${trackMd5.substring(0, 8)} already locked and prepared — skipping`);
      this.broadcastSelectionEvent('selection_ack', {
        status: 'prepared',
        trackId: trackMd5,
        direction: this.pendingUserOverrideDirection || direction || null,
        generation: this.manualSelectionGeneration
      });
      return;
    }

    this.recordSessionEvent('manual_override_requested', {
      trackId: trackMd5,
      direction
    });

    this.manualSelectionGeneration += 1;
    const selectionGeneration = this.manualSelectionGeneration;

    // Mark user-selected track as "seen"
    this.state.seenTracks.add(trackMd5);
    const selectedTrack = this.findTrackInCurrentExplorer(trackMd5);
    if (selectedTrack?.artist) this.state.seenTrackArtists.add(selectedTrack.artist);
    if (selectedTrack?.album) this.state.seenTrackAlbums.add(selectedTrack.album);

    this.pendingUserOverrideDirection = direction || null;
    this.pendingUserOverrideTrackId = trackMd5;
    this.isUserSelectionPending = true;
    this.lockedNextTrackIdentifier = trackMd5;
    this.pendingUserOverrideGeneration = selectionGeneration;

    const mixerStatus = (this.audioMixer && typeof this.audioMixer.getStatus === 'function')
      ? this.audioMixer.getStatus()
      : null;
    const crossfadeActive = mixerStatus?.isCrossfading === true;

    // Only clear the preloaded slot immediately if we are not mid-crossfade; otherwise the mixer
    // still needs that buffer to finish the fade before we can swap in the manual pick.
    if (!crossfadeActive) {
      if (typeof this.audioMixer?.clearNextTrackSlot === 'function') {
        this.audioMixer.clearNextTrackSlot();
      }
      if (this.nextTrack) {
        console.log('🧹 [override] Clearing previously prepared next track to honor manual selection');
      }
      this.nextTrack = null;
      this.explorerRecommendedNext = null;
    } else {
      console.log('🧹 [override] Preserving crossfade buffer until fade completes; will refresh once idle');
    }

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
        direction: this.pendingUserOverrideDirection || this.nextTrack?.direction,
        transitionReason: 'user'
      });
      // Don't clear pendingUserOverrideGeneration here - an in-flight preparation might need it
      // Just clear the pending track ID and direction since we've confirmed the track is ready
      this.pendingUserOverrideTrackId = null;
      this.pendingUserOverrideDirection = null;
      this.isUserSelectionPending = false;
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
            direction: this.nextTrack.direction || this.driftPlayer.currentDirection || null
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

    // Guard against concurrent preparations using both a sync flag and promise
    // The sync flag catches races before the promise is assigned
    if (this._preparationInProgress && !forceRefresh) {
      console.log('⏳ Next track preparation already in progress (sync guard); skipping duplicate call');
      return this.pendingPreparationPromise || Promise.resolve();
    }

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

    // Wait for sync guard to clear if another preparation is in flight but promise not yet set
    // This closes the race window between _preparationInProgress=true and pendingPreparationPromise assignment
    if (forceRefresh && this._preparationInProgress) {
      console.log('⏳ Force refresh: waiting for in-flight preparation to complete');
      const maxWait = 2000;
      const startWait = Date.now();
      while (this._preparationInProgress && (Date.now() - startWait) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (this._preparationInProgress) {
        console.warn('⚠️ Force refresh: timed out waiting for in-flight preparation');
      }
    }

    // Set sync guard immediately - before any async operations
    this._preparationInProgress = true;

    if (forceRefresh && reason === 'user-selection' && !overrideTrackId && !this.pendingUserOverrideTrackId) {
      console.log('🔁 Skipping forced preparation: user selection already resolved');
      this._preparationInProgress = false;
      return;
    }

    if (this.isUserSelectionPending && !forceRefresh) {
      console.log('⏳ Skipping auto next-track preparation while user selection is pending');
      this._preparationInProgress = false;
      return;
    }

    if (!forceRefresh && this.lockedNextTrackIdentifier && this.nextTrack &&
        this.nextTrack.identifier === this.lockedNextTrackIdentifier) {
      console.log('🔒 User-selected next track locked; skipping auto preparation');
      this._preparationInProgress = false;
      return;
    }

    const manualGenerationAtStart = overrideTrackId ? (overrideGeneration ?? this.pendingUserOverrideGeneration) : null;

    // Preparation generation: each call gets a unique ID so stale preparations
    // don't null out this.nextTrack that was set by a newer preparation.
    if (!this._nextPrepGeneration) this._nextPrepGeneration = 0;
    const prepGeneration = ++this._nextPrepGeneration;

    const preparation = (async () => {
      let hydratedNextTrack = null;
      let preparationReason = reason;
      try {

        if (overrideTrackId) {
          const annotations = {
            transitionReason: 'user'
          };
          if (overrideDirection || this.pendingUserOverrideDirection) {
            annotations.direction = overrideDirection || this.pendingUserOverrideDirection;
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

        const manualConflict = !overrideTrackId && this.hasManualOverrideConflict(hydratedNextTrack.identifier);
        if (manualConflict) {
          console.warn('🛑 [override] Auto preparation skipped while manual override locked', {
            sessionId: this.state.sessionId,
            candidateId: hydratedNextTrack.identifier,
            lockedId: this.lockedNextTrackIdentifier || null,
            pendingOverrideId: this.pendingUserOverrideTrackId || null,
            preparationReason
          });
          return;
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
            return await this.audioMixer.loadTrack(hydratedNextTrack.path, 'next', this.buildTrackMetadata(hydratedNextTrack));
          } catch (loadErr) {
            // Only null out nextTrack if we're still the latest preparation.
            // A newer concurrent preparation may have already set a different nextTrack.
            if (this._nextPrepGeneration === prepGeneration) {
              this.nextTrack = previousNext || null;
            } else {
              console.log(`↩️ [prepare] Skipping nextTrack rollback — superseded by newer preparation (gen ${prepGeneration} < ${this._nextPrepGeneration})`);
            }
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
          // Also commit if this track matches what we locked - even if generation was cleared by "already prepared" path
          const matchesLockedTrack = this.lockedNextTrackIdentifier && this.lockedNextTrackIdentifier === hydratedNextTrack.identifier;

          if (!isLatestSelection && !matchesLockedTrack) {
            console.log('↩️ [override] Prepared override superseded by newer selection; skipping commit');
            // Only null nextTrack if we're still the latest preparation
            if (this._nextPrepGeneration === prepGeneration) {
              this.nextTrack = null;
            }
            return;
          }

          this.lockedNextTrackIdentifier = hydratedNextTrack.identifier;
          console.log('🛰️ [override] Locked next track after user selection', {
            sessionId: this.state.sessionId,
            lockedId: this.lockedNextTrackIdentifier,
            preparedNextId: this.nextTrack?.identifier || null,
            pendingOverrideId: this.pendingUserOverrideTrackId || null,
            manualGenerationAtStart,
            currentTrackId: this.state.currentTrack?.identifier || null
          });
          await this.broadcastHeartbeat('user-next-prepared', { force: true });
          this.recordSessionEvent('manual_override_prepared', {
            trackId: hydratedNextTrack.identifier,
            direction: this.pendingUserOverrideDirection || hydratedNextTrack.direction || null,
            generation: manualGenerationAtStart
          });
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
              direction: this.pendingUserOverrideDirection || hydratedNextTrack.direction || this.driftPlayer.currentDirection || null,
              generation: manualGenerationAtStart
            });
            this.clearPendingUserSelection(manualGenerationAtStart);
          }
        } else if (this.pendingUserOverrideTrackId === hydratedNextTrack.identifier || this.lockedNextTrackIdentifier === hydratedNextTrack.identifier) {
          this.broadcastSelectionEvent('selection_ready', {
            status: 'prepared',
            trackId: hydratedNextTrack.identifier,
            direction: this.pendingUserOverrideDirection || hydratedNextTrack.direction || this.driftPlayer.currentDirection || null
          });
          this.clearPendingUserSelection();
        }
        console.log(`✅ Next track prepared successfully: ${hydratedNextTrack.title}`);
      } catch (error) {
        console.error('❌ Failed to prepare next track:', error);
        console.error('❌ Error details:', error.stack);

        // Track failures to skip persistently broken tracks
        const failedId = hydratedNextTrack?.identifier || overrideTrackId;
        if (failedId) {
          const attempts = (this.state.failedTrackAttempts.get(failedId) || 0) + 1;
          this.state.failedTrackAttempts.set(failedId, attempts);
          console.warn(`⚠️ Track ${failedId.substring(0,8)} failed (attempt ${attempts}/3)`);
        }

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
      this._preparationInProgress = false;
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
      this.state.trackStartTime = null;

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
    if (!this.state.currentTrack) return null;

    try {
      return await this.radialSearch.exploreFromTrack(this.state.currentTrack.identifier);
    } catch (error) {
      console.warn(`Failed to get explorer data: ${error.message}`);
      return null;
    }
  }

  // Next track selection - explorer-based selection with drift fallback
  async selectNextFromCandidates() {
    try {
      console.log('🎯 Using explorer-based selection for next track');

      // Prefer sticky explorer recommendation if still valid
      if (this.explorerRecommendedNext) {
        const rec = this.explorerRecommendedNext;
        const recId = rec.trackId;
        const alreadyPlayed = this.state.sessionHistory.some(h => h.identifier === recId);
        const isCurrent = this.state.currentTrack?.identifier === recId;
        const isPendingNext = this.nextTrack?.identifier === recId;
        if (!alreadyPlayed && !isCurrent && !isPendingNext) {
          const hydrated = this.hydrateTrackRecord(recId, {
            transitionReason: 'explorer',
            direction: rec.direction,
            directionKey: rec.directionKey
          });
          if (hydrated?.path) {
            console.log(`📌 Using stored explorer recommendation: ${hydrated.title} (${recId.substring(0,8)})`);
            this.explorerRecommendedNext = null;
            return hydrated;
          }
        }
        console.log(`📌 Stored explorer recommendation ${recId?.substring(0,8)} no longer valid (played=${alreadyPlayed}, current=${isCurrent}, pendingNext=${isPendingNext}); falling through to fresh selection`);
        this.explorerRecommendedNext = null;
      }

      const explorerData = await this.getComprehensiveExplorerData();
      const nextTrackFromExplorer = await ep.selectNextTrackFromExplorer(explorerData, this._explorerSessionContext());

      if (nextTrackFromExplorer) {
        const explorerAnnotations = {
          transitionReason: nextTrackFromExplorer.transitionReason || 'explorer'
        };
        if (nextTrackFromExplorer.direction) {
          explorerAnnotations.direction = nextTrackFromExplorer.direction;
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
          console.log(`✅ Using explorer-selected track: ${track.title} by ${track.artist} via ${nextTrackFromExplorer.direction}`);
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
          this.state.explorerResolution || 'adaptive'
        );
        
        // Advance stack index to new track
        this.state.stackIndex = this.state.stack.length - 1;
        this.state.positionSeconds = 0;
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
    this.resolvePendingTrackReady(false);

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

    this.state.currentTrack = null;
    this.state.trackStartTime = null;

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

    // Kill any existing noise process before spawning a new one
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGKILL');
      } catch (_) {}
      this.currentProcess = null;
    }

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

      if (!this.radialSearch?.kdTree?.tracks?.length) {
        console.log('🔄 KD-tree not ready yet; will retry in 3s');
        setTimeout(() => this.attemptDriftResumption(), 3000);
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

  // Build a WAV header for indefinite PCM streaming (44100Hz, 16-bit, stereo)
  buildWavHeader() {
    const sampleRate = this.audioMixer?.sampleRate || 44100;
    const channels = this.audioMixer?.channels || 2;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);                          // ChunkID
    header.writeUInt32LE(0xFFFFFFFF, 4);               // ChunkSize (max = streaming/unknown)
    header.write('WAVE', 8);                           // Format
    header.write('fmt ', 12);                          // Subchunk1ID
    header.writeUInt32LE(16, 16);                      // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);                       // AudioFormat (1 = PCM)
    header.writeUInt16LE(channels, 22);                // NumChannels
    header.writeUInt32LE(sampleRate, 24);               // SampleRate
    header.writeUInt32LE(byteRate, 28);                 // ByteRate
    header.writeUInt16LE(blockAlign, 32);               // BlockAlign
    header.writeUInt16LE(bitsPerSample, 34);            // BitsPerSample
    header.write('data', 36);                          // Subchunk2ID
    header.writeUInt32LE(0xFFFFFFFF, 40);               // Subchunk2Size (max = streaming/unknown)

    return header;
  }

  // Add a client to receive the stream
  addClient(response) {
    console.log(`Adding client to drift session: ${this.state.sessionId}`);

    // Set proper headers for WAV/PCM streaming
    // Note: no Content-Length or Transfer-Encoding — Node handles chunked encoding
    // implicitly, and not advertising it helps Firefox's WAV demuxer treat this
    // as a progressive download rather than a fixed-size file.
    response.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges': 'none'
    });

    // Send WAV header for the stream (size=0xFFFFFFFF for indefinite streaming)
    const wavHeader = this.buildWavHeader();
    response.write(wavHeader);

    this.clients.add(response);
    this.pendingClientBootstrap = false;
    this.cancelScheduledStreamingStop('audio-client-connected');

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Start drift if this is the first client
    if (this.clients.size === 1 && !this.isActive) {
      this.startStreaming().catch((err) => {
        console.error('❌ Failed to start streaming for new client:', err);
      });
    } else {
      this.restorePersistedOverrideState('client-connect');
    }

    // Handle client disconnect
    response.on('close', () => {
      console.log(`Client disconnected from drift session: ${this.state.sessionId}`);
      this.clients.delete(response);

      // Stop streaming if no clients
      if (this.clients.size === 0) {
        this.scheduleStreamingStop('no-audio-clients');
      }
    });

    response.on('error', (err) => {
      console.error('Client response error:', err);
      this.clients.delete(response);
      if (this.clients.size === 0) {
        this.scheduleStreamingStop('no-audio-clients');
      }
    });
  }

  // Start the streaming
  async startStreaming() {
    if (this.isActive) return;

    console.log(`🎵 Starting drift streaming for session: ${this.state.sessionId}`);
    this.isActive = true;
    this.ensureHeartbeatLoop();
    const tryRestore = () => this.restorePersistedOverrideState('stream-start');

    // If the mixer is already streaming (preload) just start serving clients
    if (this.audioMixer?.engine?.isStreaming) {
      console.log('🎵 Mixer already streaming from preload; keeping current track');
      tryRestore();
      return;
    }

    // If track is seeding, wait for it to become seeded
    if (this.currentTrackLoadingPromise) {
      console.log(`🌱 Track is seeding, waiting for it to become seeded...`);
      await this.currentTrackLoadingPromise;
      console.log(`🌳 Track seeded and ready`);
      tryRestore();
      return;
    }

    // Respect any pre-seeded track (e.g., contrived MD5 journey)
    if (this.state.currentTrack && this.state.currentTrack.path) {
      console.log(`🎵 Using pre-seeded track for session start: ${this.state.currentTrack.title || this.state.currentTrack.identifier}`);
      await this.playCurrentTrack();
    } else {
      await this.startDriftPlayback();
    }

    tryRestore();
  }

  // Set up stream piping for current process
  shouldExtendIdleGrace() {
    return Boolean(
      this.audioMixer?.engine?.isCrossfading ||
      this.pendingUserSelectionTimer ||
      this.hasPersistableOverrideState()
    );
  }

  hasPersistableOverrideState() {
    return Boolean(
      this.lockedNextTrackIdentifier ||
      this.pendingUserOverrideTrackId ||
      (this.nextTrack && this.nextTrack.identifier)
    );
  }

  scheduleStreamingStop(reason = 'idle') {
    const delay = this.shouldExtendIdleGrace() ? STREAM_OVERRIDE_GRACE_MS : STREAM_IDLE_GRACE_MS;

    if (this.streamingStopTimer) {
      clearTimeout(this.streamingStopTimer);
      this.streamingStopTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    console.log(`🕓 Scheduling drift shutdown for session ${this.state.sessionId} in ${delay}ms (${reason})`);

    this.streamingStopTimer = setTimeout(() => {
      this.streamingStopTimer = null;
      const preserveOverride = this.hasPersistableOverrideState();
      this.stopStreaming({
        reason,
        preserveLockedOverride: preserveOverride
      });
    }, delay);
  }

  cancelScheduledStreamingStop(reason = 'client-returned') {
    if (!this.streamingStopTimer) {
      return;
    }
    clearTimeout(this.streamingStopTimer);
    this.streamingStopTimer = null;
    console.log(`🕓 Cancelled scheduled drift shutdown for session ${this.state.sessionId} (${reason})`);
  }

  captureOverridePersistence(reason = 'idle-stop') {
    if (!this.hasPersistableOverrideState()) {
      this.persistedOverrideState = null;
      return null;
    }

    const snapshot = {
      trackId: this.pendingUserOverrideTrackId
        || this.lockedNextTrackIdentifier
        || this.nextTrack?.identifier
        || null,
      direction: this.pendingUserOverrideDirection
        || this.nextTrack?.direction
        || this.driftPlayer?.currentDirection
        || null,
      pendingGeneration: this.pendingUserOverrideGeneration,
      manualGeneration: this.manualSelectionGeneration,
      timestamp: Date.now(),
      reason
    };

    if (!snapshot.trackId) {
      this.persistedOverrideState = null;
      return null;
    }

    this.persistedOverrideState = snapshot;
    console.log(`📦 [override] Persisting selection ${snapshot.trackId} during ${reason}`);
    return snapshot;
  }

  restorePersistedOverrideState(trigger = 'resume') {
    const snapshot = this.persistedOverrideState;
    if (!snapshot || !snapshot.trackId) {
      return;
    }

    if (this.pendingUserOverrideTrackId || this.lockedNextTrackIdentifier) {
      this.persistedOverrideState = null;
      return;
    }

    this.manualSelectionGeneration = Math.max(
      this.manualSelectionGeneration || 0,
      snapshot.manualGeneration || 0
    );

    this.lockedNextTrackIdentifier = snapshot.trackId;
    this.pendingUserOverrideTrackId = snapshot.trackId;
    this.pendingUserOverrideDirection = snapshot.direction || null;
    this.pendingUserOverrideGeneration = snapshot.pendingGeneration || null;

    console.log(`📦 [override] Restoring persisted selection ${snapshot.trackId} (${trigger})`);

    setTimeout(() => {
      this.applyUserSelectedTrackOverride(snapshot.trackId).catch((err) => {
        console.warn('⚠️ Failed to restore persisted override:', err?.message || err);
      });
    }, 0);

    this.persistedOverrideState = null;
  }

  // Stop streaming
  stopStreaming(options = {}) {
    if (!this.isActive) return;

    const { reason = 'manual', preserveLockedOverride = false } = options || {};
    console.log(`🛑 Stopping drift streaming for session: ${this.state.sessionId} (${reason})`);

    if (this.streamingStopTimer) {
      clearTimeout(this.streamingStopTimer);
      this.streamingStopTimer = null;
    }

    if (preserveLockedOverride) {
      this.captureOverridePersistence(reason);
    } else {
      this.persistedOverrideState = null;
    }

    this.isActive = false;

    // Stop advanced mixer
    this.audioMixer.stopStreaming();

    // Kill fallback noise process if active
    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    // Clear playback state so monitoring endpoints stop reporting this session as active
    this.state.trackStartTime = null;
    this.state.currentTrack = null;
    this.nextTrack = null;
    this.explorerRecommendedNext = null;
    this.pendingCurrentTrack = null;
    this.lastExplorerSnapshotPayload = null;
    this.lastExplorerSnapshotSummary = null;
    if (this.pendingCrossfadePrepTimer) {
      clearTimeout(this.pendingCrossfadePrepTimer);
      this.pendingCrossfadePrepTimer = null;
    }
    this._lastBroadcastTrackId = null;
    this.lastTrackEventPayload = null;
    this.lastTrackEventTimestamp = 0;
    this.resolvePendingTrackReady(false);

    if (preserveLockedOverride) {
      this.clearPendingUserSelection();
      this.lockedNextTrackIdentifier = null;
    } else {
      this.resetManualOverrideLock();
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

  recordLivePlaybackChunk(chunk) {
    mb.recordLivePlaybackChunk(chunk, this, { validate, MixerMetadata });
  }

  getLiveStreamState() {
    if (!this.liveStreamState || !this.liveStreamState.trackId) {
      return null;
    }
    return { ...this.liveStreamState };
  }

  async restartStream(reason = 'manual-restart') {
    console.log(`🔄 Restarting stream for session ${this.state.sessionId} (${reason})`);

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
      console.log(`✅ Stream restarted for session ${this.state.sessionId}`);
    } catch (error) {
      console.error('❌ restartStream failed:', error);
      throw error;
    }
  }

  // Add event client for SSE
  addEventClient(eventClient) {
    console.log(`📡 Event client connected to session: ${this.state.sessionId}`);
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
    console.log(`📡 Event client disconnected from session: ${this.state.sessionId}`);
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
      if (this.state.currentTrack && this.state.trackStartTime) {
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

        if (!nominalDurationMs && this.state.currentTrack.length) {
          nominalDurationMs = this.state.currentTrack.length * 1000;
        }

        if (!nominalDurationMs) {
          return true; // Cannot determine duration; assume alive while clients exist
        }

        const elapsedMs = now - this.state.trackStartTime;
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
        direction: track.direction || track.direction || null,
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
      sessionId: this.state.sessionId,
      isStreaming: Boolean(this.audioMixer?.engine?.isStreaming),
      audioClientCount: this.clients.size,
      eventClientCount: this.eventClients.size,
      trackStartTime: this.state.trackStartTime,
      currentTrack: cloneTrack(this.state.currentTrack),
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
    console.log(`📡 Session ${this.state.sessionId} broadcasting to ${this.eventClients.size} clients`);
    const eventJson = JSON.stringify(eventData);
    for (const client of this.eventClients) {
      try {
        if (!client.destroyed) {
          console.log(`📡 → Sending to client for session ${this.state.sessionId}`);
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
      sessionId: this.state.sessionId,
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
      sessionId: this.state.sessionId,
      timestamp: Date.now(),
      ...payload
    };
    console.log(`📡 Session ${this.state.sessionId} selection event`, event);
    this.broadcastEvent(event);
  }

  // Add track to session history
  addToHistory(track, startTimestamp, direction = null, transitionReason = 'natural') {
    const historyState = {
      sessionHistory: this.state.sessionHistory,
      maxHistorySize: this.state.maxHistorySize,
      sessionId: this.state.sessionId,
      noArtist: this.state.noArtist,
      noAlbum: this.state.noAlbum,
      currentAdaptiveRadius: this.currentAdaptiveRadius,
      adaptiveRadiusCache: this.adaptiveRadiusCache
    };
    const result = mb.buildHistoryEntry(track, startTimestamp, direction, transitionReason, historyState);
    if (result.seenArtist) this.state.seenArtists.add(result.seenArtist);
    if (result.seenAlbum) this.state.seenAlbums.add(result.seenAlbum);
  }

  // Delegated to explorer-pipeline

  summarizeExplorerSnapshot(explorerData, currentTrackId = null) {
    return mb.summarizeExplorerSnapshot(explorerData, currentTrackId);
  }

  recordExplorerEvent({ reason, explorerData, nextTrack }) {
    mb.recordExplorerEvent({ reason, explorerData, nextTrack }, this);
  }

  recordSessionEvent(type, data = {}) {
    mb.recordSessionEvent(type, data, this);
  }

  ensureHeartbeatLoop() {
    if (this.heartbeatInterval) {
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      if (!this.isActive) {
        return;
      }
      this.broadcastHeartbeat('steady-state').catch(() => {});
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatInterval.unref === 'function') {
      this.heartbeatInterval.unref();
    }
  }

  summarizeTrackMinimal(track) {
    return mb.summarizeTrackMinimal(track);
  }

  buildNextTrackSummary() {
    return mb.buildNextTrackSummary(this);
  }

  buildHeartbeatPayload(reason = 'status') {
    return mb.buildHeartbeatPayload(this, reason, {
      fingerprintRegistry,
      cloneAndSanitizeBeetsMeta,
      HEARTBEAT_DIVERGENCE_THRESHOLD_MS,
      HEARTBEAT_ELAPSED_OVERSHOOT_WARN_MS
    });
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

    // Check for halfway point — fire playcount callback once per track
    const hbTrackId = payload.currentTrack?.identifier;
    if (hbTrackId && hbTrackId !== this.halfwayFiredForTrack && payload.timing) {
      const { elapsedMs } = payload.timing;
      const durationMs = payload.currentTrack.durationMs;
      if (durationMs > 0 && elapsedMs >= durationMs * 0.5) {
        this.halfwayFiredForTrack = hbTrackId;
        if (typeof this.onHalfwayReached === 'function') {
          this.onHalfwayReached(hbTrackId);
        }
      }
    }

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

    const activeTrack = this.state.currentTrack && this.state.currentTrack.identifier === currentTrackId
      ? this.state.currentTrack
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
    let snapshotSummary = null;

    try {
      console.log(`📡 Building explorer snapshot for: ${displayTrack.title} by ${displayTrack.artist}`);

      if (this.state.sessionHistory.length === 0 ||
          this.state.sessionHistory[this.state.sessionHistory.length - 1].identifier !== currentTrackId) {
        this.addToHistory(displayTrack, displayStartTime, this.driftPlayer.currentDirection);
        console.log(`📡 Added track to history, total: ${this.state.sessionHistory.length}`);
      }

      let explorerData;
      try {
        explorerData = await this.getComprehensiveExplorerData();
        console.log(`📊 Explorer data loaded: ${Object.keys(explorerData.directions || {}).length} directions`);
      } catch (explorerError) {
        console.error('🚨 Explorer data load failed:', explorerError);
        explorerData = {
          directions: {},
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
          explorerData = await this.getComprehensiveExplorerData({
            forceFresh: true,
            retryDepth: explorerRetryAttempts
          });
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
        explorerData.nextTrack?.direction ||
        explorerData.nextTrack?.direction;
      if (nominatedDirectionKey && !(explorerData.directions || {}).hasOwnProperty(nominatedDirectionKey)) {
        const availableKeys = Object.keys(explorerData.directions || {});
        console.error('📉 Explorer snapshot missing direction payload for nominated nextTrack', {
          sessionId: this.state.sessionId,
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

      snapshotSummary = this.summarizeExplorerSnapshot(explorerData, currentTrackId);
      if (!force && snapshotSummary && this.lastExplorerSnapshotSummary === snapshotSummary) {
        console.log(`📡 Skipping explorer snapshot for ${currentTrackId} (unchanged summary)`);
        return;
      }

      if (explorerData?.diagnostics) {
        explorerData.diagnostics.retryCount = explorerRetryAttempts;
      }

      const featuresFallback = tu.lookupTrackFeatures(this.radialSearch, this.explorerDataCache, currentTrackId);
      const pcaFallback = tu.lookupTrackPca(this.radialSearch, this.explorerDataCache, currentTrackId);
      const artFallback = tu.lookupTrackAlbumCover(this.radialSearch, this.explorerDataCache, currentTrackId);
      const beetsFallback = tu.lookupTrackBeetsMeta(this.radialSearch, this.explorerDataCache, currentTrackId);

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
      const sanitizedMeta = cloneAndSanitizeBeetsMeta(beetsMeta);
      if (sanitizedMeta) {
        hydratedCurrent.beetsMeta = sanitizedMeta;
      }

      const currentTrackPayload = mb.sanitizeTrackForClient(hydratedCurrent, {
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

      const sanitizedExplorer = mb.serializeExplorerSnapshotForClient(explorerData);
      const sanitizedNextTrack = mb.serializeNextTrackForClient(nextTrackSummary || explorerData.nextTrack || null, {
        includeFeatures: true,
        includePca: true
      });

      this.recordExplorerEvent({
        reason,
        explorerData,
        nextTrack: sanitizedNextTrack
      });

      snapshotEvent = {
        type: 'explorer_snapshot',
        timestamp: Date.now(),
        reason,
        fingerprint: this.currentFingerprint || fingerprintRegistry.getFingerprintForSession(this.state.sessionId) || null,
        currentTrack: currentTrackPayload,
        nextTrack: sanitizedNextTrack || null,
        sessionHistory: this.state.sessionHistory.slice(-10).map(entry => ({
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
          sessionDuration: Date.now() - (this.state.sessionHistory[0]?.startTime || Date.now())
        },
        explorer: sanitizedExplorer,
        session: {
          id: this.state.sessionId,
          clients: this.clients.size,
          totalTracksPlayed: this.state.sessionHistory.length,
          diversityScore: this.calculateSessionDiversity(),
          filtering: {
            noArtist: this.state.noArtist,
            noAlbum: this.state.noAlbum,
            seenArtistsCount: this.state.seenArtists.size,
            seenAlbumsCount: this.state.seenAlbums.size
          }
        },
        explorerDiagnostics: explorerData.diagnostics || null,
        explorerEvents: this.explorerEventHistory.slice(-10)
      };

      console.log(`📡 Broadcasting explorer snapshot: ${displayTrack.title} by ${displayTrack.artist}`);
      if (snapshotEvent.nextTrack?.track?.identifier) {
        console.log(`📊 Next track candidate: ${snapshotEvent.nextTrack.track.identifier.substring(0, 8)} (${snapshotEvent.nextTrack.transitionReason || 'unknown'})`);
      }
    } catch (error) {
      console.error('📡 Explorer snapshot error:', error);

      try {
        const fallbackCurrent = mb.sanitizeTrackForClient({
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
          fingerprint: this.currentFingerprint || fingerprintRegistry.getFingerprintForSession(this.state.sessionId) || null,
          currentTrack: fallbackCurrent,
          explorer: { error: true, message: error.message },
          session: {
            id: this.state.sessionId,
            clients: this.clients.size,
            totalTracksPlayed: this.state.sessionHistory.length
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
    this.lastExplorerSnapshotSummary = snapshotSummary;

    if (this.eventClients.size === 0) {
      console.log('📡 No event clients, caching explorer snapshot for future subscribers');
      return;
    }

    this.broadcastEvent(snapshotEvent);
  }

  async broadcastTrackEvent(force = false, options = {}) {
    const reason = options.reason || 'track-update';
    await this.broadcastHeartbeat(reason, { force: true });
    // Explorer snapshots now fetched via POST /explorer - no longer broadcast via SSE
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
  async runComprehensiveExplorerData(options = {}) {
    const targetTrackId = options.trackId || this.state.currentTrack?.identifier;
    if (!targetTrackId) {
      throw new Error('No target track for explorer data');
    }
    const retryDepth = Number.isFinite(options.retryDepth) ? options.retryDepth : 0;

    // Check session-level cache first
    const resolution = this.state.explorerResolution || 'adaptive';

    if (this.explorerDataCache.has(targetTrackId, resolution)) {
      console.log(`🚀 Explorer cache HIT: ${targetTrackId.substring(0,8)} @ ${resolution} (${this.explorerDataCache.size} cached)`);
      const cachedData = this.explorerDataCache.get(targetTrackId, resolution);
      // Recompute nextTrack based on CURRENT session history - cached nextTrack may be stale
      cachedData.nextTrack = await ep.selectNextTrackFromExplorer(cachedData, this._explorerSessionContext());
      return cachedData;
    }

    console.log(`📊 Computing explorer data for ${targetTrackId.substring(0,8)} @ ${resolution} (cache miss)`);

    const currentTrackData = this.radialSearch.kdTree.getTrack(targetTrackId);
    if (!currentTrackData || !currentTrackData.pca) {
      this.currentNeighborhoodSnapshot = null;
      // Fallback to legacy exploration if no PCA data
      const sessionFilterFn = (tracks) => ep.filterSessionRepeats(tracks, this);
      const strategicSamplesFn = (candidates, target) => ep.selectStrategicSamples(candidates, target);
      return await ep.getLegacyExplorerData(this.radialSearch, this.state.currentTrack, sessionFilterFn, strategicSamplesFn);
    }

    const explorerData = {
      directions: {},
      nextTrack: null,
      diversityMetrics: {}
    };

    // Get total neighborhood size for diversity calculations
    console.log(`📊 Getting neighborhood for track: ${currentTrackData.identifier}`);
    console.log(`📊 Track has PCA data:`, !!currentTrackData.pca);

    const targetTrack = currentTrackData;  // resolved track object for sub-methods
    const cachedAdaptive = this.adaptiveRadiusCache.get(targetTrackId) || null;
    const dynamicRadius = Number.isFinite(this.dynamicRadiusState.currentRadius)
      ? this.dynamicRadiusState.currentRadius
      : null;
    let totalNeighborhood = [];
    let totalNeighborhoodSize = 0;
    this.currentNeighborhoodSnapshot = null;

    try {
      const adaptiveResult = await this.radialSearch.getAdaptiveNeighborhood(targetTrackId, {
        targetMin: 350,
        targetMax: 450,
        initialRadius: dynamicRadius
          ?? (cachedAdaptive && Number.isFinite(cachedAdaptive.radius) ? cachedAdaptive.radius : null),
        limit: 1500
      });

      if (adaptiveResult && Array.isArray(adaptiveResult.neighbors) && adaptiveResult.neighbors.length > 0) {
        totalNeighborhood = adaptiveResult.neighbors;
        totalNeighborhoodSize = totalNeighborhood.length;
        this.currentAdaptiveRadius = {
          radius: adaptiveResult.radius,
          count: adaptiveResult.count,
          iterations: adaptiveResult.iterations,
          withinTarget: adaptiveResult.withinTarget,
          scale: adaptiveResult.scale,
          targetMin: 350,
          targetMax: 450,
          cachedRadiusReused: Boolean(cachedAdaptive)
        };
        this.adaptiveRadiusCache.set(targetTrackId, {
          radius: adaptiveResult.radius,
          count: adaptiveResult.count,
          scale: adaptiveResult.scale,
          updatedAt: Date.now()
        });
        const tunedRadius = Number.isFinite(adaptiveResult.radius) ? adaptiveResult.radius.toFixed(4) : 'n/a';
        console.log(`📊 Adaptive PCA radius tuned to ${tunedRadius}, neighbors=${totalNeighborhoodSize} (iterations=${adaptiveResult.iterations}${adaptiveResult.withinTarget ? ', within target' : ', outside target'})`);
        this.currentNeighborhoodSnapshot = Array.isArray(totalNeighborhood) ? totalNeighborhood.slice() : null;
        if (Number.isFinite(adaptiveResult.radius)) {
          this.dynamicRadiusState.currentRadius = adaptiveResult.radius;
        }
      } else {
        throw new Error('Adaptive PCA neighborhood empty');
      }
    } catch (adaptiveError) {
      console.warn('⚠️ Adaptive PCA search failed, falling back to calibrated settings:', adaptiveError.message || adaptiveError);
      this.currentAdaptiveRadius = null;
      try {
        totalNeighborhood = this.radialSearch.kdTree.pcaRadiusSearch(
          currentTrackData,
          'magnifying_glass',
          'primary_d',
          1000
        );
        totalNeighborhoodSize = totalNeighborhood.length;
        console.log(`📊 Calibrated PCA fallback returned: ${totalNeighborhoodSize} tracks`);
        this.currentNeighborhoodSnapshot = Array.isArray(totalNeighborhood) ? totalNeighborhood.slice() : null;
        if (totalNeighborhoodSize > 0) {
          const fallbackRadius = cachedAdaptive && Number.isFinite(cachedAdaptive.radius)
            ? cachedAdaptive.radius
            : this.dynamicRadiusState.currentRadius;
          if (Number.isFinite(fallbackRadius)) {
            this.dynamicRadiusState.currentRadius = fallbackRadius;
          }
        }
      } catch (pcaError) {
        console.error('📊 PCA radius search failed:', pcaError);
        console.log('📊 Falling back to legacy radius search');
        const fallbackRadius = (cachedAdaptive && Number.isFinite(cachedAdaptive.radius) && cachedAdaptive.radius > 0)
          ? cachedAdaptive.radius
          : 0.25;
        totalNeighborhood = this.radialSearch.kdTree.radiusSearch(currentTrackData, fallbackRadius, null, 1000);
        totalNeighborhoodSize = totalNeighborhood.length;
        console.log(`📊 Legacy radius search returned: ${totalNeighborhoodSize} tracks`);
        this.currentNeighborhoodSnapshot = Array.isArray(totalNeighborhood) ? totalNeighborhood.slice() : null;
        if (totalNeighborhoodSize > 0) {
          this.dynamicRadiusState.currentRadius = fallbackRadius;
        }
      }
    }

    const neighborhoodStats = ep.computeNeighborhoodStats(totalNeighborhood);

    if (totalNeighborhoodSize === 0) {
      console.warn('⚠️ Explorer neighborhood empty after all attempts; downstream stacks may be sparse');
      this.currentNeighborhoodSnapshot = [];
    } else {
      console.log(`📊 Final neighborhood size: ${totalNeighborhoodSize} tracks`);
    }

    explorerData.neighborhood = {
      size: totalNeighborhoodSize,
      radius: this.currentAdaptiveRadius ? this.currentAdaptiveRadius.radius : null,
      iterations: this.currentAdaptiveRadius ? this.currentAdaptiveRadius.iterations : 0,
      targetMin: 350,
      targetMax: 450,
      cachedRadiusReused: Boolean(cachedAdaptive),
      distanceStats: neighborhoodStats
    };

    const directionDiagnostics = {
      initialCount: 0,
      sanitizedCount: 0,
      finalCount: 0,
      duplicatesRemoved: 0,
      missingIdentifiers: 0,
      uniqueTracks: 0,
      removedDirections: 0,
      promotedOpposites: 0,
      droppedOpposites: 0,
      trimmedSamples: 0,
      randomInjections: 0,
      totalSamples: 0,
      finalSamples: 0
    };

    // Get PCA directions with enhanced data
    const pcaDirections = this.radialSearch.getPCADirections();

    // Explore PCA directions first (skip primary_d - internal only)
    let pcaPairCount = 0;
    for (const [domain, domainInfo] of Object.entries(pcaDirections)) {
      if (domain === 'primary_d') {
        // Skip primary discriminator - used internally, not exposed to UI
        console.log('📊 Skipping primary_d directions (internal use only)');
        continue;
      } else {
        // Multi-component domains (tonal, spectral, rhythmic)
        for (const [component, componentInfo] of Object.entries(domainInfo)) {
          const directionKey = `${domain}_${component}`;
          const searchContext = {
            resolution: this.state.explorerResolution || 'adaptive',
            adaptiveRadius: this.currentAdaptiveRadius,
            neighborhoodSnapshot: this.currentNeighborhoodSnapshot
          };
          await ep.exploreDirection(this.radialSearch, explorerData, domain, component, componentInfo.positive, componentInfo.description, 'positive', totalNeighborhoodSize, targetTrack, searchContext);
          await ep.exploreDirection(this.radialSearch, explorerData, domain, component, componentInfo.negative, componentInfo.description, 'negative', totalNeighborhoodSize, targetTrack, searchContext);
          pcaPairCount++;
          // Yield to event loop every 2 direction pairs so audio streaming keeps flowing
          if (pcaPairCount % 2 === 0) {
            await setImmediatePromise();
          }
        }
      }
    }

    // Add original 18 core feature directions for local neighborhood search
    console.log(`📊 Adding original 18 core feature directions...`);
    const originalFeatures = [
      // Rhythmic
      { name: 'bpm', positive: 'faster', negative: 'slower', description: 'Tempo' },
      { name: 'danceability', positive: 'more_danceable', negative: 'less_danceable', description: 'Jiggy' },
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
    if (VERBOSE_EXPLORER) {
      console.log(`📊 Starting exploration of ${originalFeatures.length} original features...`);
      console.log(`🔍 CORE SEARCH SETUP: RadialSearch object available methods:`, Object.getOwnPropertyNames(Object.getPrototypeOf(this.radialSearch)));
      console.log(`🔍 CORE SEARCH SETUP: getDirectionalCandidates method exists:`, typeof this.radialSearch.getDirectionalCandidates);
    }

    for (let featureIdx = 0; featureIdx < originalFeatures.length; featureIdx++) {
      const feature = originalFeatures[featureIdx];
      if (VERBOSE_EXPLORER) console.log(`📊 Exploring original feature: ${feature.name} (${feature.description})`);
      await ep.exploreOriginalFeatureDirection(this.radialSearch, explorerData, feature, 'positive', totalNeighborhoodSize, targetTrack, this);
      await ep.exploreOriginalFeatureDirection(this.radialSearch, explorerData, feature, 'negative', totalNeighborhoodSize, targetTrack, this);
      // Yield to event loop every 3 features (6 KD-tree searches) so audio streaming keeps flowing
      if ((featureIdx + 1) % 3 === 0) {
        await setImmediatePromise();
      }
    }

    if (currentTrackData.vae?.latent && Array.isArray(currentTrackData.vae.latent)) {
      console.log(`🧠 Exploring VAE latent directions (${currentTrackData.vae.latent.length} axes)`);
      await ep.exploreVaeDirections(this.radialSearch, explorerData, targetTrack);
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
    explorerData.directions = await ep.limitToTopDimensions(explorerData.directions, 12);

    summarizeDirectionsByDomain('post-limit', explorerData.directions);

    // Strategic deduplication: PCA/VAE directions get first pass, then core features
    explorerData.directions = ep.deduplicateTracksStrategically(explorerData.directions, {
      maxCardsPerStack: 12,
      totalNeighborhoodSize
    });

    // 🃏 DEBUG: Verify no duplicate cards across stacks when verbose logging enabled
    if (VERBOSE_EXPLORER) {
      ep.debugDuplicateCards(explorerData.directions);
    }

    // 🃏 FINAL DEDUPLICATION: Each card appears in exactly one stack (highest position wins)
    explorerData.directions = ep.finalDeduplication(explorerData.directions);

    // Recalculate diversity metrics based on post-deduplication reality
    Object.entries(explorerData.directions).forEach(([directionKey, direction]) => {
      const actualCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;

      direction.actualTrackCount = actualCount;
      direction.isOutlier = actualCount < 3;
      direction.totalNeighborhoodSize = totalNeighborhoodSize;

      const optionsBonus = Math.min(actualCount / 10, 2.0);
      const baseScore = totalNeighborhoodSize > 0
        ? ep.calculateDirectionDiversity(actualCount, totalNeighborhoodSize)
        : ep.calculateDirectionDiversity(actualCount, actualCount || 1);
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
          this.state.currentTrack
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
    explorerData.directions = ep.prioritizeBidirectionalDirections(explorerData.directions);

    // 🧼 SAFETY NET: Remove any residual duplicates introduced by prioritization embedding
    const initialDirectionCount = Object.keys(explorerData.directions || {}).length;
    directionDiagnostics.initialCount = initialDirectionCount;

    const sanitizeResult = ep.sanitizeDirectionalStacks(explorerData.directions);
    explorerData.directions = sanitizeResult.directions;
    directionDiagnostics.sanitizedCount = Object.keys(explorerData.directions || {}).length;
    directionDiagnostics.duplicatesRemoved = sanitizeResult.stats.duplicatesRemoved;
    directionDiagnostics.missingIdentifiers = sanitizeResult.stats.missingIdentifiers;
    directionDiagnostics.uniqueTracks = sanitizeResult.stats.uniqueTracks;
    directionDiagnostics.totalSamples = sanitizeResult.stats.totalSamples;

    const removalResult = ep.removeEmptyDirections(explorerData.directions);
    explorerData.directions = removalResult.directions;
    directionDiagnostics.removedDirections = removalResult.stats.removedDirections;
    directionDiagnostics.promotedOpposites = removalResult.stats.promotedOpposites;
    directionDiagnostics.droppedOpposites = removalResult.stats.droppedOpposites;

    const stackBudgetResult = ep.applyStackBudget(explorerData.directions, {
      stackTotalCount: this.state.stackTotalCount || 12,
      stackRandomCount: this.state.stackRandomCount
    });
    explorerData.directions = stackBudgetResult.directions;
    directionDiagnostics.trimmedSamples = stackBudgetResult.stats.trimmedSamples;
    directionDiagnostics.randomInjections = stackBudgetResult.stats.randomInjections;
    directionDiagnostics.finalSamples = stackBudgetResult.stats.finalSamples;
    explorerData.directions = ep.selectTopTrack(explorerData.directions);
    directionDiagnostics.finalCount = Object.keys(explorerData.directions || {}).length;

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

    const radiusDiagnostics = this.currentAdaptiveRadius
      ? {
          mode: 'adaptive',
          radius: this.currentAdaptiveRadius.radius,
          count: this.currentAdaptiveRadius.count,
          iterations: this.currentAdaptiveRadius.iterations,
          withinTarget: this.currentAdaptiveRadius.withinTarget,
          cachedRadiusReused: this.currentAdaptiveRadius.cachedRadiusReused
        }
      : {
          mode: 'fallback',
          radius: cachedAdaptive?.radius ?? null,
          cachedRadiusReused: Boolean(cachedAdaptive)
        };

    const radiusFeedback = ep.evaluateRadiusAdjustment(
      directionDiagnostics,
      retryDepth,
      this.dynamicRadiusState,
      this.state.stackTotalCount,
      (type, data) => this.recordSessionEvent(type, data)
    );
    if (radiusFeedback.action) {
      radiusDiagnostics.adjustment = radiusFeedback.action;
    }
    if (radiusFeedback.retry) {
      this.recordSessionEvent('radius_retry', {
        reason: radiusFeedback.action?.reason || 'unknown',
        action: radiusFeedback.action?.action || null,
        retryDepth,
        nextRadius: this.dynamicRadiusState.currentRadius || null
      });
    }

    explorerData.diagnostics = {
      timestamp: Date.now(),
      currentTrackId: targetTrackId,
      radius: radiusDiagnostics,
      neighborhood: {
        total: totalNeighborhoodSize,
        distanceStats: neighborhoodStats
      },
      directionStats: directionDiagnostics,
      radiusRetryDepth: retryDepth
    };

    if (radiusFeedback.retry) {
      console.warn(`🔁 Explorer starvation detected (depth ${retryDepth}); expanding radius to ${this.dynamicRadiusState.currentRadius?.toFixed(4) || 'n/a'} and retrying`);
      return await this.getComprehensiveExplorerData({
        ...options,
        forceFresh: true,
        retryDepth: retryDepth + 1
      });
    }

    // Calculate diversity scores and select next track
    explorerData.diversityMetrics = ep.calculateExplorerDiversityMetrics(explorerData.directions);
    explorerData.nextTrack = await ep.selectNextTrackFromExplorer(explorerData, this._explorerSessionContext());
    explorerData.resolution = this.state.explorerResolution;

    this.recordExplorerSummary(explorerData, radiusDiagnostics, totalNeighborhoodSize);

    // Cache the computed explorer data for this session
    this.explorerDataCache.set(targetTrackId, resolution, explorerData);
    console.log(`💾 Cached explorer data for ${targetTrackId.substring(0,8)} @ ${resolution} (cache size: ${this.explorerDataCache.size})`);

    return explorerData;
  }

  recordExplorerSummary(explorerData, radiusDiagnostics, totalNeighborhoodSize) {
    const mixerContext = {
      currentTrackId: this.state.currentTrack?.identifier || null,
      explorerResolution: this.state.explorerResolution,
      explorerHistory: this.explorerHistory,
      maxExplorerHistory: this.maxExplorerHistory,
      currentExplorerSummary: this.currentExplorerSummary,
      recordSessionEvent: (type, data) => this.recordSessionEvent(type, data)
    };
    const result = ep.recordExplorerSummary(explorerData, radiusDiagnostics, totalNeighborhoodSize, mixerContext);
    this.currentExplorerSummary = result.currentExplorerSummary;
    this.explorerHistory = result.explorerHistory;
  }

  async getComprehensiveExplorerData(options = {}) {
    const isCurrentTrack = !options.trackId || options.trackId === this.state.currentTrack?.identifier;
    if (!options.forceFresh && isCurrentTrack && this.pendingExplorerPromise) {
      return this.pendingExplorerPromise;
    }

    // If an external explorer provider is available (e.g. worker thread),
    // try it first to avoid blocking the main thread.
    if (this.onExplorerNeeded) {
      try {
        const trackId = options.trackId || this.state.currentTrack?.identifier;
        const delegated = await this.onExplorerNeeded(trackId, options);
        if (delegated) {
          return delegated;
        }
      } catch (delegateErr) {
        console.warn('⚠️ onExplorerNeeded delegate failed, falling through to main thread:', delegateErr?.message || delegateErr);
      }
    }

    const basePromise = this.runComprehensiveExplorerData(options);

    if (options.forceFresh || !isCurrentTrack) {
      return basePromise;
    }

    const wrappedPromise = basePromise.finally(() => {
      if (this.pendingExplorerPromise === wrappedPromise) {
        this.pendingExplorerPromise = null;
      }
    });

    this.pendingExplorerPromise = wrappedPromise;
    return wrappedPromise;
  }

  setExplorerResolution(resolution) {
    const previous = this.state.explorerResolution || 'adaptive';
    const normalized = (resolution || 'adaptive').toString().toLowerCase();

    if (normalized !== 'adaptive') {
      console.log(`🔍 Ignoring legacy explorer resolution request (${resolution}); adaptive tuning is always enabled.`);
    }

    this.state.explorerResolution = 'adaptive';
    return previous !== this.state.explorerResolution;
  }

  _explorerSessionContext() {
    return {
      sessionHistory: this.state.sessionHistory,
      currentTrackId: this.state.currentTrack?.identifier,
      failedTrackAttempts: this.state.failedTrackAttempts,
      recordSessionEvent: (type, data) => this.recordSessionEvent(type, data)
    };
  }

  // Calculate session diversity based on history
  calculateSessionDiversity() {
    if (this.state.sessionHistory.length < 2) return 0;

    // Measure diversity as variance in PCA space across session history
    const recentTracks = this.state.sessionHistory.slice(-10); // Last 10 tracks
    let diversityScore = 0;

    // Calculate variance in primary discriminator
    const primaryDValues = recentTracks
      .filter(t => t.pca && t.pca.primary_d)
      .map(t => t.pca.primary_d);

    if (primaryDValues.length > 1) {
      diversityScore = ep.calculateVariance(primaryDValues) * 10;
    }

    return Math.min(diversityScore, 100); // Normalized to 0-100
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
      sessionId: this.state.sessionId,
      clients: this.clients.size,
      isActive: this.isActive,
      isDriftMode: true,
      currentTrack: this.state.currentTrack ? {
        title: this.state.currentTrack.title,
        artist: this.state.currentTrack.artist,
        identifier: this.state.currentTrack.identifier
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
      sessionType: this.state.sessionType,
      sessionName: this.state.sessionName,
      stackLength: this.state.stack.length,
      stackIndex: this.state.stackIndex,
      positionSeconds: this.state.positionSeconds,
      ephemeral: this.state.ephemeral,
      canAdvance: !this.isAtStackEnd()
    };
  }

  // ==================== STACK MANAGEMENT METHODS ====================

  // Initialize session as named or playlist session
  initializeSession(sessionType, sessionName, initialStack = null) {
    this.state.sessionType = sessionType; // 'named', 'playlist', 'anonymous'
    this.state.sessionName = sessionName;
    
    if (initialStack) {
      this.state.stack = [...initialStack];
      this.state.stackIndex = 0;
      this.state.positionSeconds = 0;
    } else if (sessionType === 'anonymous') {
      // For anonymous sessions, build retroactive stack when tracks are available
      // This will be called again from ensureTrackInStack when first track loads
      this.buildRetroactiveStack();
    }
    
    this.state.ephemeral = false;
    console.log(`📚 Initialized session: ${sessionType} (${sessionName || 'anonymous'})`);
  }

  // Build stack from current session state (for anonymous sessions)
  buildRetroactiveStack() {
    this.state.stack = [];
    
    if (this.state.currentTrack) {
      this.state.stack.push({
        identifier: this.state.currentTrack.identifier,
        direction: null, // First track has no incoming direction
        scope: this.state.explorerResolution || 'adaptive'
      });
    }
    
    if (this.nextTrack) {
      this.state.stack.push({
        identifier: this.nextTrack.identifier,
        direction: this.driftPlayer.getDriftState().currentDirection || null,
        scope: this.state.explorerResolution || 'adaptive'
      });
      this.state.stackIndex = 0; // Currently on first track
    } else {
      this.state.stackIndex = 0;
    }
  }

  // Add track to stack (organic exploration)
  pushToStack(identifier, direction = null, scope = 'adaptive') {
    if (this.state.ephemeral) {
      console.log('📚 Session is ephemeral, not adding to stack');
      return;
    }

    if (this.state.sessionType === 'playlist') {
      console.log('📚 Playlist session is read-only, not adding to stack');
      return;
    }

    const stackItem = {
      identifier,
      direction,
      scope
    };

    this.state.stack.push(stackItem);
    console.log(`📚 Added to stack: ${identifier} (${this.state.stack.length} total)`);
    
    // Notify of stack change
    this.broadcastStackUpdate();
  }

  // Navigate to specific position in stack
  jumpToStackPosition(index, positionSeconds = 0) {
    if (index < 0 || index >= this.state.stack.length) {
      throw new Error(`Invalid stack index: ${index} (stack length: ${this.state.stack.length})`);
    }

    this.state.stackIndex = index;
    this.state.positionSeconds = positionSeconds;
    
    const stackItem = this.state.stack[index];
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
    this.state.currentTrack = this.hydrateTrackRecord(track);
    this.pendingCurrentTrack = null;
    
    // Start playback at specified position
    await this.playCurrentTrack();
    
    if (this.state.positionSeconds > 0) {
      // TODO: Implement seeking to positionSeconds
      console.log(`🎵 Would seek to ${this.state.positionSeconds}s in track`);
    }
  }

  // Check if we're at the end of the stack
  isAtStackEnd() {
    return this.state.stackIndex >= this.state.stack.length - 1;
  }

  // Move to next track in stack
  advanceInStack() {
    if (this.isAtStackEnd()) {
      console.log('📚 Reached end of stack, entering ephemeral mode');
      this.state.ephemeral = true;
      return false;
    }

    this.state.stackIndex++;
    this.state.positionSeconds = 0;
    
    const stackItem = this.state.stack[this.state.stackIndex];
    console.log(`📚 Advancing to stack position ${this.state.stackIndex}: ${stackItem.identifier}`);
    
    this.loadTrackFromStack(stackItem);
    this.broadcastStackUpdate();
    return true;
  }

  // Get current stack state for export/serialization
  getStackState() {
    return this.state.serialize();
  }

  // Load state from serialized stack
  loadStackState(data) {
    this.state = SessionState.fromSerialized(data);
    console.log(`📚 Loaded stack state: ${this.state.stack.length} tracks, position ${this.state.stackIndex}, ` +
      `${this.state.seenArtists.size} seen artists, ${this.state.sessionHistory.length} history entries`);
    if (this.state.stack.length > 0 && this.state.stackIndex < this.state.stack.length) {
      const currentStackItem = this.state.stack[this.state.stackIndex];
      this.loadTrackFromStack(currentStackItem);
    }
  }

  // Broadcast stack update to SSE clients
  broadcastStackUpdate() {
    const stackInfo = {
      stackLength: this.state.stack.length,
      stackIndex: this.state.stackIndex,
      positionSeconds: this.state.positionSeconds,
      ephemeral: this.state.ephemeral,
      canAdvance: !this.isAtStackEnd(),
      currentStackItem: this.state.stack[this.state.stackIndex] || null
    };

    this.broadcastToEventClients('stack_update', stackInfo);
    
    // Trigger persistence for named sessions
    this.persistSessionState();
  }

  // Persist session state (event-driven)
  persistSessionState() {
    if (this.state.sessionType === 'named' && !this.state.ephemeral) {
      // Store in memory for now (in-memory session registry)
      const stackState = this.getStackState();
      console.log(`💾 Persisting named session state: ${this.state.sessionName} (${this.state.stack.length} tracks)`);
      
      // Store in global memory registry
      if (typeof global !== 'undefined') {
        global.namedSessionRegistry = global.namedSessionRegistry || new Map();
        global.namedSessionRegistry.set(this.state.sessionName, stackState);
      }
    }
  }

  // Ensure track is in stack (for initial track or stack gaps)
  ensureTrackInStack(identifier) {
    // Check if stack is empty or track is not at current position
    if (this.state.stack.length === 0) {
      // First track - add as seed with no direction
      this.pushToStack(identifier, null, this.state.explorerResolution || 'adaptive');
      this.state.stackIndex = 0;
      this.state.positionSeconds = 0;
      console.log(`📚 Added seed track to stack: ${identifier}`);
    } else if (this.state.stackIndex < this.state.stack.length && 
               this.state.stack[this.state.stackIndex].identifier !== identifier) {
      // Track mismatch - this shouldn't happen in normal flow but handle gracefully
      console.warn(`📚 Track mismatch in stack at position ${this.state.stackIndex}: expected ${this.state.stack[this.state.stackIndex].identifier}, got ${identifier}`);
      // Could either fix the stack or log for debugging
    }
    
    // Update position tracking
    this.state.positionSeconds = 0;
  }

  // ==================== END STACK MANAGEMENT ====================

  // ─── Thin wrappers delegating to extracted modules ─────────────────────────

  hydrateTrackRecord(trackCandidate, annotations = {}) {
    return tu.hydrateTrackRecord(this.radialSearch, trackCandidate, annotations);
  }

  findTrackInCurrentExplorer(identifier) {
    return tu.findTrackInCurrentExplorer(this.explorerDataCache, identifier);
  }

  lookupTrackFeatures(identifier) {
    return tu.lookupTrackFeatures(this.radialSearch, this.explorerDataCache, identifier);
  }

  lookupTrackPca(identifier) {
    return tu.lookupTrackPca(this.radialSearch, this.explorerDataCache, identifier);
  }

  lookupTrackAlbumCover(identifier) {
    return tu.lookupTrackAlbumCover(this.radialSearch, this.explorerDataCache, identifier);
  }

  lookupTrackBeetsMeta(identifier) {
    return tu.lookupTrackBeetsMeta(this.radialSearch, this.explorerDataCache, identifier);
  }

  sanitizeTrackForClient(track, options = {}) {
    return mb.sanitizeTrackForClient(track, options);
  }

  serializeNextTrackForClient(nextTrack, options = {}) {
    return mb.serializeNextTrackForClient(nextTrack, options);
  }

  serializeExplorerSnapshotForClient(explorerData) {
    return mb.serializeExplorerSnapshotForClient(explorerData);
  }

  // Get the adjusted track duration from advanced audio mixer
  getAdjustedTrackDuration(track = this.state.currentTrack, { logging = true } = {}) {
    return tu.getAdjustedTrackDuration(this.state.currentTrack, this.audioMixer, track, { logging });
  }

  // Clean up
  destroy() {
    console.log(`🧹 Destroying drift mixer for session: ${this.state.sessionId}`);
    this.stopStreaming();

    fingerprintRegistry.removeBySession(this.state.sessionId);

    if (this.pendingUserSelectionTimer) {
      clearTimeout(this.pendingUserSelectionTimer);
      this.pendingUserSelectionTimer = null;
    }

    if (this.autoRecoveryTimer) {
      clearTimeout(this.autoRecoveryTimer);
      this.autoRecoveryTimer = null;
    }

    this.pendingPreparationPromise = null;
    this._preparationInProgress = false;
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
