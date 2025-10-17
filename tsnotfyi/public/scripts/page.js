  // Global state like it's 1989!
const STREAM_ENDPOINT_BASE = '/stream';
const EVENTS_ENDPOINT_BASE = '/events';

const state = {
    lastSSEMessageTime: null,
    latestExplorerData: null,
    latestCurrentTrack: null,
    previousNextTrack: null,
    serverNextTrack: null,
    serverNextDirection: null,
    lastDirectionSignature: null,
    lastRefreshSummary: null,
    usingOppositeDirection: false,
    reversePreference: null,
    lastSelectionGeneration: null,
    journeyMode: true,
    selectedIdentifier: null,
    stackIndex: 0,
    forceLayout: null,
    isStarted: false,
    progressAnimation: null,
    heartbeatTimeout: null,
    renderer: null,
    camera: null,
    scene: null,
    baseDirectionKey: null,
    currentOppositeDirectionKey: null,
    sessionId: null,
    streamFingerprint: null,
    useMediaSource: false,
    streamController: null,
  streamUrl: STREAM_ENDPOINT_BASE,
  eventsEndpoint: EVENTS_ENDPOINT_BASE,
  currentResolution: 'magnifying',
    manualNextTrackOverride: false,
    nextTrackAnimationTimer: null,
    manualNextDirectionKey: null,
    playbackStartTimestamp: null,
    playbackDurationSeconds: 0,
    lastTrackUpdateTs: 0,
    pendingInitialTrackTimer: null,
    pendingResyncCheckTimer: null,
    pendingAudioConfirmTimer: null,
    creatingNewSession: false,
    remainingCounts: {},
    pendingManualTrackId: null,
    pendingSnapshotTrackId: null,
    awaitingSSE: false,
    cardsDormant: false,
    nextTrackPreviewTrackId: null,
    nextTrackHistory: [],
    trackMetadataCache: {},
    trackColorAssignments: {},
    nowPlayingSequence: 0,
    lastNowPlayingIdentity: null,
    nowPlayingInitialized: false,
    selectionRetryCount: 0,
    selectionRetryTimer: null,
    skipNextExitAnimation: false,
    hasRenderedDeck: false
  };

const DEBUG_FLAGS = {
  deck: false,
  duplicates: false,
  colors: false,
  consistency: false
};


const MEDIA_STREAM_SUPPORTED = Boolean(
  window.MediaStreamController &&
  typeof window.MediaStreamController.isSupported === 'function' &&
  window.MediaStreamController.isSupported()
);
state.useMediaSource = MEDIA_STREAM_SUPPORTED;


const PANEL_VARIANTS = ['red-variant', 'green-variant', 'yellow-variant', 'blue-variant'];
const VARIANT_TO_DIRECTION_TYPE = {
  'red-variant': 'rhythmic_core',
  'green-variant': 'tonal_core',
  'blue-variant': 'spectral_core',
  'yellow-variant': 'outlier'
};

const CARD_BACKGROUND_BY_DIRECTION_TYPE = {
  rhythmic_core: '#2a1818',
  rhythmic_pca: '#2a1818',
  tonal_core: '#182a1a',
  tonal_pca: '#182a1a',
  spectral_core: '#18222a',
  spectral_pca: '#18222a',
  outlier: '#2a1810'
};

function getReconnectDelay(attempt) {
  const base = 1000, max = 30000;
  const exponential = Math.min(base * Math.pow(2, attempt), max);
  const jitter = Math.random * 1000;
  return Math.min(base * Math.pow(2, attempt), max) + Math.random() * 1000;
}

function getCardBackgroundColor(directionType) {
  return CARD_BACKGROUND_BY_DIRECTION_TYPE[directionType] || '#1b1b1b';
}

function setCardVariant(card, variant) {
  if (!card) return;
  if (variant) {
    card.dataset.colorVariant = variant;
  } else {
    delete card.dataset.colorVariant;
  }
}

function pickPanelVariant() {
  return PANEL_VARIANTS[Math.floor(Math.random() * PANEL_VARIANTS.length)];
}

function colorsForVariant(variant) {
  const directionType = VARIANT_TO_DIRECTION_TYPE[variant] || 'outlier';
  const colors = getDirectionColor(directionType, `${directionType}_positive`);
  return {
    border: colors.border,
    glow: colors.glow
  };
}

function extractNextTrackIdentifier(candidate) {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return candidate;
  }

  if (candidate.track) {
    const nested = extractNextTrackIdentifier(candidate.track);
    if (nested) {
      return nested;
    }
  }

  const keyOrder = ['trackMd5', 'track_md5', 'md5', 'identifier', 'id'];
  for (const key of keyOrder) {
    if (candidate[key]) {
      return candidate[key];
    }
  }

  return null;
}

function extractNextTrackDirection(candidate) {
  if (!candidate) {
    return null;
  }

  if (candidate.track) {
    const nested = extractNextTrackDirection(candidate.track);
    if (nested) {
      return nested;
    }
  }

  const keyOrder = ['directionKey', 'direction', 'key', 'baseDirection'];
  for (const key of keyOrder) {
    if (candidate[key]) {
      return candidate[key];
    }
  }

  return null;
}

function cacheTrackColorAssignment(trackId, info) {
  if (!trackId || !info) {
    return info || null;
  }
  state.trackColorAssignments = state.trackColorAssignments || {};
  const key = info.directionKey || '__default__';
  const store = state.trackColorAssignments[trackId] || {};
  store[key] = {
    variant: info.variant,
    border: info.border,
    glow: info.glow,
    directionKey: info.directionKey || null
  };
  store.__last = store[key];
  state.trackColorAssignments[trackId] = store;
  return store[key];
}

function resolveTrackColorAssignment(trackData, { directionKey } = {}) {
  if (!trackData || !trackData.identifier) {
    return null;
  }

  const trackId = trackData.identifier;
  const store = state.trackColorAssignments?.[trackId] || null;
  const keyForLookup = directionKey || null;
  const existing = keyForLookup && store ? store[keyForLookup] : null;
  const fallbackExisting = !existing && store
    ? (store.__last || Object.values(store).find(entry => entry && entry.directionKey))
    : existing;

  let resolvedDirectionKey = directionKey || existing?.directionKey || fallbackExisting?.directionKey || null;

  if (!resolvedDirectionKey) {
    const explorerMatch = findTrackInExplorer(state.latestExplorerData, trackId);
    if (explorerMatch?.directionKey) {
      resolvedDirectionKey = explorerMatch.directionKey;
    }
  }

  if (!resolvedDirectionKey && state.serverNextTrack === trackId && state.serverNextDirection) {
    resolvedDirectionKey = state.serverNextDirection;
  }

  if (!resolvedDirectionKey && state.previousNextTrack?.identifier === trackId) {
    resolvedDirectionKey = state.previousNextTrack.directionKey || null;
  }

  if (existing && (!resolvedDirectionKey || existing.directionKey === resolvedDirectionKey)) {
    return existing;
  }

  if (fallbackExisting && !resolvedDirectionKey) {
    return fallbackExisting;
  }

  let assignment;

  if (resolvedDirectionKey) {
    const directionType = getDirectionType(resolvedDirectionKey);
    const colors = getDirectionColor(directionType, resolvedDirectionKey);
    assignment = {
      variant: variantFromDirectionType(directionType),
      border: colors.border,
      glow: colors.glow,
      directionKey: resolvedDirectionKey
    };
  } else {
    const variant = pickPanelVariant();
    const colors = colorsForVariant(variant);
    assignment = {
      variant,
      border: colors.border,
      glow: colors.glow,
      directionKey: null
    };
  }

  return cacheTrackColorAssignment(trackId, assignment);
}

function computeDirectionSignature(explorerData) {
  if (!explorerData) return null;

  const directions = explorerData.directions || {};
  const entries = Object.keys(directions).sort().map((key) => {
    const direction = directions[key] || {};
    const primaryIds = (direction.sampleTracks || [])
      .map(sample => (sample.track || sample)?.identifier || '?')
      .join(',');
    const oppositeIds = direction.oppositeDirection
      ? (direction.oppositeDirection.sampleTracks || [])
          .map(sample => (sample.track || sample)?.identifier || '?')
          .join(',')
      : '';
    const trackCount = direction.trackCount || (direction.sampleTracks || []).length;
    const descriptor = direction.direction || '';
    return `${key}|${trackCount}|${descriptor}|${primaryIds}|${oppositeIds}`;
  });

  const nextTrack = explorerData.nextTrack || {};
  const nextIdentifier = nextTrack.track?.identifier || nextTrack.identifier || '';
  const nextDirection = nextTrack.directionKey || nextTrack.direction || '';

  return `${nextDirection}::${nextIdentifier}::${entries.join('||')}`;
}

function deckLog(...args) {
  if (DEBUG_FLAGS.deck) {
    console.log(...args);
  }
}

function duplicateLog(...args) {
  if (DEBUG_FLAGS.duplicates) {
    console.log(...args);
  }
}

function colorLog(...args) {
  if (DEBUG_FLAGS.colors) {
    console.log(...args);
  }
}

const RADIUS_MODES = ['microscope', 'magnifying', 'binoculars'];

function explorerContainsTrack(explorerData, identifier) {
  if (!explorerData || !identifier) return false;

  const nextTrack = explorerData.nextTrack;
  if (nextTrack) {
    const candidate = nextTrack.track || nextTrack;
    if (candidate && candidate.identifier === identifier) {
      return true;
    }
  }

  const directions = explorerData.directions || {};
  for (const direction of Object.values(directions)) {
    const samples = direction?.sampleTracks || [];
    for (const sample of samples) {
      const track = sample.track || sample;
      if (track?.identifier === identifier) {
        return true;
      }
    }

    const opposite = direction?.oppositeDirection;
    if (opposite && Array.isArray(opposite.sampleTracks)) {
      for (const sample of opposite.sampleTracks) {
        const track = sample.track || sample;
        if (track?.identifier === identifier) {
          return true;
        }
      }
    }
  }

  return false;
}

function findTrackInExplorer(explorerData, identifier) {
  if (!explorerData || !identifier) return null;

  const directions = explorerData.directions || {};

  const considerSamples = (directionKey, direction) => {
    if (!direction) return null;
    const samples = direction.sampleTracks || [];
    for (const sample of samples) {
      const track = sample?.track || sample;
      if (track?.identifier === identifier) {
        return { directionKey, track };
      }
    }
    return null;
  };

  for (const [key, direction] of Object.entries(directions)) {
    const match = considerSamples(key, direction);
    if (match) return match;

    if (direction?.oppositeDirection) {
      const oppositeKey = direction.oppositeDirection.key || getOppositeDirection(key);
      const oppositeMatch = considerSamples(oppositeKey || key, direction.oppositeDirection);
      if (oppositeMatch) return oppositeMatch;
    }
  }

  const nextTrack = explorerData.nextTrack?.track || explorerData.nextTrack;
  if (nextTrack?.identifier === identifier) {
    const directionKey = explorerData.nextTrack?.directionKey || null;
    return { directionKey, track: nextTrack };
  }

  return null;
}

function normalizeResolution(resolution) {
  if (!resolution) return null;
  const value = resolution.toLowerCase();
  if (value === 'magnifying_glass' || value === 'magnifying') {
    return 'magnifying';
  }
  if (value === 'microscope' || value === 'binoculars') {
    return value;
  }
  return value;
}

function composeStreamEndpoint(fingerprint, cacheBust = false) {
  const base = STREAM_ENDPOINT_BASE;
  const params = [];
  if (fingerprint) {
    params.push(`fingerprint=${encodeURIComponent(fingerprint)}`);
  }
  if (cacheBust !== false) {
    const value = cacheBust === true ? Date.now() : cacheBust;
    params.push(`t=${value}`);
  }
  if (!params.length) {
    return base;
  }
  return `${base}?${params.join('&')}`;
}

function composeEventsEndpoint(fingerprint) {
  const base = EVENTS_ENDPOINT_BASE;
  if (!fingerprint) {
    return base;
  }
  return `${base}?fingerprint=${encodeURIComponent(fingerprint)}`;
}

function syncStreamEndpoint(fingerprint, { cacheBust = false } = {}) {
  const url = composeStreamEndpoint(fingerprint, cacheBust);
  state.streamUrl = url;
  return url;
}

function syncEventsEndpoint(fingerprint) {
  const url = composeEventsEndpoint(fingerprint);
  state.eventsEndpoint = url;
  return url;
}

const fingerprintWaiters = [];
let nextTrackPreviewFadeTimer = null;

function notifyFingerprintWaiters() {
  if (!fingerprintWaiters.length) {
    return;
  }

  const waiters = fingerprintWaiters.splice(0, fingerprintWaiters.length);
  for (const entry of waiters) {
    clearTimeout(entry.timer);
    entry.resolve(true);
  }
}

function applyFingerprint(fingerprint) {
  if (!fingerprint) {
    return;
  }

  state.streamFingerprint = fingerprint;
  syncEventsEndpoint(fingerprint);
  notifyFingerprintWaiters();
}

function clearFingerprint({ reason = 'unknown' } = {}) {
  if (state.streamFingerprint) {
    console.log(`🧹 Clearing fingerprint (${reason})`);
  }

  state.streamFingerprint = null;
  syncEventsEndpoint(null);
  syncStreamEndpoint(null, { cacheBust: false });
}

function waitForFingerprint(timeoutMs = 8000) {
  if (state.streamFingerprint) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: null
    };

    entry.timer = setTimeout(() => {
      const index = fingerprintWaiters.indexOf(entry);
      if (index !== -1) {
        fingerprintWaiters.splice(index, 1);
      }
      resolve(false);
    }, timeoutMs);

    fingerprintWaiters.push(entry);
  });
}

  function updateNowPlayingCard(trackData, driftState) {
      state.latestCurrentTrack = trackData;
      window.state = window.state || {};
      window.state.latestCurrentTrack = trackData;
      state.lastTrackUpdateTs = Date.now();

      if (state.pendingResyncCheckTimer) {
        clearTimeout(state.pendingResyncCheckTimer);
        state.pendingResyncCheckTimer = null;
      }

      if (state.pendingInitialTrackTimer) {
        clearTimeout(state.pendingInitialTrackTimer);
        state.pendingInitialTrackTimer = null;
      }

      // Update direction based on current drift direction
      const currentDirectionKey = driftState && driftState.currentDirection ? driftState.currentDirection : null;
      const directionText = currentDirectionKey ?
          formatDirectionName(currentDirectionKey) :
          'Journey';
      document.getElementById('cardDirection').textContent = directionText;

      document.getElementById('cardTitle').textContent = getDisplayTitle(trackData);
      document.getElementById('cardArtist').textContent = trackData.artist || 'Unknown Artist';
      document.getElementById('cardAlbum').textContent = ''; // No album data currently

      // Format duration and metadata
      const duration = (trackData.duration || trackData.length) ?
          `${Math.floor((trackData.duration || trackData.length) / 60)}:${String(Math.floor((trackData.duration || trackData.length) % 60)).padStart(2, '0')}` :
          '??:??';
      document.getElementById('cardMeta').textContent = `${duration} · FLAC`;

      // Update visualization tubes based on track data
      updateSelectedTubes(trackData);

      const photo = document.getElementById('cardPhoto');
      const cover =
	  state.previousNextTrack?.identifier === trackData.identifier
	  ? state.previousNextTrack?.albumCover
	  : trackData.albumCover;
      photo.style.background = `url('${cover}')`

      // Resolve panel color variant based on track + direction (deterministic per track)
      const panel = document.querySelector('#nowPlayingCard .panel');
      const cardFrame = document.querySelector('#nowPlayingCard .card');
      const rim = document.querySelector('#nowPlayingCard .rim');
      const trackId = trackData.identifier || trackData.trackMd5 || trackData.md5 || null;
      const trackIdentity = trackData.identifier
          || trackData.trackMd5
          || trackData.md5
          || [trackData.title, trackData.artist, trackData.album, trackData.duration]
              .filter(Boolean)
              .join('|')
          || null;

      const wasInitialized = state.nowPlayingInitialized === true;
      const identityChanged = trackIdentity ? state.lastNowPlayingIdentity !== trackIdentity : false;
      const isFirstTrack = !wasInitialized || (!identityChanged && state.nowPlayingSequence === 1);

      if (!wasInitialized) {
          state.nowPlayingSequence = 1;
      } else if (identityChanged) {
          state.nowPlayingSequence = (state.nowPlayingSequence || 1) + 1;
      }

      state.lastNowPlayingIdentity = trackIdentity;
      state.nowPlayingInitialized = true;

      if (identityChanged) {
          const currentTrackId = trackData.identifier || trackData.trackMd5 || trackData.md5 || null;
          animateRemoveLeftmostTrayItem(currentTrackId);
      }

      let assignment = null;

      if (isFirstTrack) {
          if (panel) {
              PANEL_VARIANTS.forEach(v => panel.classList.remove(v));
              panel.style.setProperty('--border-color', '#ffffff');
              panel.style.setProperty('--glow-color', '#ffffff');
          }
          if (rim) {
              rim.style.background = '#ffffff';
              rim.style.boxShadow = '0 0 18px rgba(255, 255, 255, 0.35)';
          }
          if (cardFrame) {
              cardFrame.style.setProperty('--card-background', '#ffffff');
              cardFrame.style.setProperty('--card-border-color', '#ffffff');
          }
      } else {
          if (state.previousNextTrack?.identifier === trackId) {
              const prior = state.previousNextTrack;
              const directionMatches = prior.directionKey && currentDirectionKey
                  ? prior.directionKey === currentDirectionKey
                  : true;
              if (directionMatches && prior.variant && prior.borderColor && prior.glowColor) {
                  assignment = {
                      variant: prior.variant,
                      border: prior.borderColor,
                      glow: prior.glowColor,
                      directionKey: prior.directionKey || currentDirectionKey || null
                  };
              }
          }

          if (!assignment) {
              assignment = resolveTrackColorAssignment(trackData, { directionKey: currentDirectionKey || assignment?.directionKey || null });
          } else if (trackId) {
              cacheTrackColorAssignment(trackId, assignment);
          }

          if (panel && assignment) {
              PANEL_VARIANTS.forEach(v => panel.classList.remove(v));
              panel.classList.add(assignment.variant);
              panel.style.setProperty('--border-color', assignment.border);
              panel.style.setProperty('--glow-color', assignment.glow);
          }

          if (cardFrame && assignment) {
              cardFrame.style.setProperty('--card-background', assignment.border);
              cardFrame.style.setProperty('--card-border-color', assignment.border);
          }

          if (rim && assignment) {
              rim.style.background = assignment.border;
              rim.style.boxShadow = `0 0 15px rgba(255, 255, 255, 0.18), 0 0 30px ${assignment.glow}, 0 0 45px ${assignment.glow}`;
          }

          if (assignment) {
              state.previousNextTrack = state.previousNextTrack || {};
              if (state.previousNextTrack.identifier === trackId) {
                  state.previousNextTrack.borderColor = assignment.border;
                  state.previousNextTrack.glowColor = assignment.glow;
                  state.previousNextTrack.variant = assignment.variant;
                  state.previousNextTrack.directionKey = assignment.directionKey || currentDirectionKey || state.previousNextTrack.directionKey || null;
              }
          }
      }

      const directionKeyForStyling = !isFirstTrack
          ? (currentDirectionKey || assignment?.directionKey || state.previousNextTrack?.directionKey || null)
          : null;
      const isNegativeDirection = Boolean(directionKeyForStyling && directionKeyForStyling.includes('_negative'));
      const nowPlayingRoot = document.getElementById('nowPlayingCard');
      if (nowPlayingRoot) {
          nowPlayingRoot.classList.toggle('negative-direction', isNegativeDirection);
      }
      if (panel) {
          panel.classList.toggle('negative-direction', isNegativeDirection);
      }
      if (cardFrame && assignment) {
          cardFrame.style.setProperty('--card-border-color', assignment.border);
      }

      // Show card with zoom-in animation
      const card = document.getElementById('nowPlayingCard');
      card.classList.add('visible');
  }


function updateRadiusControlsUI() {
  const controls = document.querySelectorAll('#radiusControls .radius-button');
  if (!controls.length) return;

  const active = normalizeResolution(state.currentResolution) || 'magnifying';
  controls.forEach(btn => {
    const btnMode = normalizeResolution(btn.dataset.radiusMode);
    if (btnMode === active) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function triggerZoomMode(mode) {
  const normalizedMode = normalizeResolution(mode) || 'magnifying';

  state.currentResolution = normalizedMode;
  updateRadiusControlsUI();

  const endpointMode = normalizedMode === 'magnifying' ? 'magnifying' : normalizedMode;

  fetch(`/session/zoom/${endpointMode}`, {
    method: 'POST'
  }).then(response => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json().catch(() => ({}));
  }).then(result => {
    const returnedResolution = normalizeResolution(result.resolution) || normalizedMode;
    state.currentResolution = returnedResolution;
    state.manualNextTrackOverride = false;
    state.manualNextDirectionKey = null;
    state.pendingManualTrackId = null;
    updateRadiusControlsUI();
    if (typeof rejig === 'function') {
      rejig();
    }
  }).catch(error => {
    console.error('Zoom request failed:', error);
  });
}

function setupRadiusControls() {
  const container = document.getElementById('radiusControls');
  if (!container) return;

  container.querySelectorAll('.radius-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.radiusMode;
      triggerZoomMode(mode);
    });
  });

  updateRadiusControlsUI();
}

updateRadiusControlsUI();

initializeApp().catch((error) => {
  console.error('❌ App initialization failed:', error);
});

async function initializeApp() {

  // ====== Audio Streaming Setup ======

  console.log('🆔 Audio-first session management');

  // Connection health management
  const connectionHealth = {
    sse: {
      status: 'connecting',
      lastMessage: Date.now(),
      reconnectAttempts: 0,
      reconnectDelay: 2000,
      maxReconnectDelay: 30000,
      stuckTimeout: null,
    },
    audio: {
      status: 'connecting',
      reconnectAttempts: 0,
      reconnectDelay: 2000,
      maxReconnectDelay: 30000,
      maxAttempts: 10,
    },
    currentEventSource: null,
  };

  // Update connection health UI
  function updateConnectionHealthUI() {
    const healthIndicator = document.getElementById('connectionHealth');
    const sseStatus = document.getElementById('sseStatus');
    const audioStatus = document.getElementById('audioStatus');

    if (!healthIndicator) return;

    // Update status text
    if (sseStatus) sseStatus.textContent = connectionHealth.sse.status;
    if (audioStatus) audioStatus.textContent = connectionHealth.audio.status;

    // Determine overall health
    const sseOk = connectionHealth.sse.status === 'connected';
    const audioOk = connectionHealth.audio.status === 'connected';

    healthIndicator.classList.remove('healthy', 'degraded', 'error');

    if (sseOk && audioOk) {
      healthIndicator.classList.add('healthy');
    } else if (sseOk || audioOk) {
      healthIndicator.classList.add('degraded');
    } else {
      healthIndicator.classList.add('error');
    }
  }

  const audioHealth = {
    lastTimeUpdate: null,
    bufferingStarted: null,
    isHealthy: false,
    checkInterval: null,
    handlingRestart: false,
    lastObservedTime: 0,
    stallTimer: null
  };

  const LOCKOUT_THRESHOLD_SECONDS = 30;
  const METADATA_FADE_WINDOW_SECONDS = 30;

  const elements = {
	  clickCatcher:        document.getElementById('clickCatcher'),
          volumeControl:       document.getElementById('volumeControl'),
          volumeBar:           document.getElementById('volumeBar'),
          fullscreenProgress:  document.getElementById('fullscreenProgress'),
	  progressWipe:        document.getElementById('progressWipe'),
          audio:               document.getElementById('audio'),
          playbackClock:       document.getElementById('playbackClock'),
          nowPlayingCard:      document.getElementById('nowPlayingCard'),
          dimensionCards:      document.getElementById('dimensionCards'),
          nextTrackTray:       document.getElementById('nextTrackTray'),
          nextTrackTrayPreview: document.querySelector('#nextTrackTray .next-track-tray-preview'),
          nextTrackTrayItems:  document.querySelector('#nextTrackTray .next-track-tray-items'),
          beetsSegments:       document.getElementById('beetsSegments')
  }
  elements.audio.volume = 0.85;

  function ensureBaseOpacity(node) {
      if (!node) {
          return 1;
      }
      const dataset = node.dataset || {};
      if (!dataset.baseOpacity) {
          const computedOpacity = parseFloat(window.getComputedStyle(node).opacity || '1');
          const base = Number.isFinite(computedOpacity) ? computedOpacity : 1;
          if (node.dataset) {
              node.dataset.baseOpacity = base.toString();
          }
          return base;
      }
      const parsed = parseFloat(node.dataset.baseOpacity);
      return Number.isFinite(parsed) ? parsed : 1;
  }

  function applyMetadataOpacity(fadeRatio) {
      const ratio = Math.max(0, Math.min(fadeRatio, 1));
      const directionTextNodes = document.querySelectorAll('.directionKeyText');
      directionTextNodes.forEach(node => {
          const baseOpacity = ensureBaseOpacity(node);
          node.style.opacity = (baseOpacity * ratio).toFixed(3);
      });

      if (elements.beetsSegments) {
          const baseOpacity = ensureBaseOpacity(elements.beetsSegments);
          const targetOpacity = baseOpacity * ratio;
          elements.beetsSegments.style.opacity = targetOpacity.toFixed(3);
      }
  }

  function setReversePreference(trackId, updates = {}) {
      if (!trackId) {
          state.reversePreference = null;
          return;
      }

      if (!state.reversePreference || state.reversePreference.trackId !== trackId) {
          state.reversePreference = {
              trackId,
              generation: updates.generation ?? null,
              usingOpposite: updates.usingOpposite ?? state.usingOppositeDirection
          };
          return;
      }

      if (updates.generation !== undefined) {
          state.reversePreference.generation = updates.generation;
      }
      if (updates.usingOpposite !== undefined) {
          state.reversePreference.usingOpposite = updates.usingOpposite;
      }
  }

  function clearReversePreference() {
      state.reversePreference = null;
      state.lastSelectionGeneration = null;
  }

  function getPreferredOppositeState(trackId, generation) {
      const pref = state.reversePreference;
      if (!pref || pref.trackId !== trackId) {
          return null;
      }
      if (pref.generation != null && generation != null && pref.generation !== generation) {
          return null;
      }
      return pref.usingOpposite;
  }

  function updateMetadataFadeFromProgress(progressFraction) {
      const duration = state.playbackDurationSeconds || 0;

      if (!Number.isFinite(duration) || duration <= 0) {
          applyMetadataOpacity(0);
          return;
      }

      const clampedProgress = Math.max(0, Math.min(progressFraction, 1));
      const elapsedSeconds = clampedProgress * duration;
      const fadeWindow = Math.max(Math.min(METADATA_FADE_WINDOW_SECONDS, duration / 2), 0.001);

      const fadeInFactor = Math.min(elapsedSeconds / fadeWindow, 1);
      const remainingSeconds = Math.max(duration - elapsedSeconds, 0);
      const fadeOutFactor = Math.min(remainingSeconds / fadeWindow, 1);
      const fadeRatio = Math.max(0, Math.min(fadeInFactor, fadeOutFactor));

      applyMetadataOpacity(fadeRatio);
  }

  applyMetadataOpacity(0);

  function playAudioElement(reason = 'unknown') {
      try {
          return elements.audio.play()
              .then(() => {
                  connectionHealth.audio.status = 'connected';
                  connectionHealth.audio.reconnectAttempts = 0;
                  connectionHealth.audio.reconnectDelay = 2000;
                  updateConnectionHealthUI();
                  return true;
              })
              .catch(err => {
                  console.error(`🎵 Play failed (${reason}):`, err);
                  console.error('🎵 Audio state when play failed:', {
                      error: elements.audio.error,
                      networkState: elements.audio.networkState,
                      readyState: elements.audio.readyState,
                      src: elements.audio.src
                  });
                  connectionHealth.audio.status = 'error';
                  updateConnectionHealthUI();
                  if (!connectionHealth.currentEventSource) {
                      connectSSE();
                  }
                  return false;
              });
      } catch (err) {
          console.error(`🎵 Play threw (${reason}):`, err);
          connectionHealth.audio.status = 'error';
          updateConnectionHealthUI();
          if (!connectionHealth.currentEventSource) {
              connectSSE();
          }
          return Promise.resolve(false);
      }
  }

  function connectAudioStream(streamUrl, { forceFallback = false, reason = 'initial' } = {}) {
      if (!streamUrl) {
          console.warn('connectAudioStream called without streamUrl');
          return false;
      }

      state.streamUrl = streamUrl;

      if (!forceFallback && state.useMediaSource && state.streamController) {
          try {
              state.streamController.start(streamUrl);
              return true;
          } catch (err) {
              console.warn(`🎧 MediaSource start failed (${reason}); falling back`, err);
              return connectAudioStream(streamUrl, { forceFallback: true, reason: `${reason}_fallback` });
          }
      }

      if (state.streamController) {
          try {
              state.streamController.stop();
          } catch (err) {
              console.warn('🎧 MediaSource stop failed during fallback:', err);
          }
      }

      state.streamController = null;
      state.useMediaSource = false;

      elements.audio.src = streamUrl;
      elements.audio.load();
      return false;
  }

  function initializeMediaStreamController() {
      if (!state.useMediaSource) {
          return;
      }
      const ControllerCtor = window.MediaStreamController;
      if (typeof ControllerCtor !== 'function') {
          state.useMediaSource = false;
          return;
      }

      const streamLogger = (event) => {
          if (!event) return;
          const level = event.level || 'info';
          if (level === 'error') {
              console.error('🎧 MSE error:', event.message, event.error || event);
          } else if (level === 'warn') {
              console.warn('🎧 MSE warn:', event.message, event.error || event);
          }
      };

      try {
          state.streamController = new ControllerCtor(elements.audio, {
              log: streamLogger,
              onError: (err) => {
                  console.warn('🎧 MediaSource streaming error; falling back to direct audio', err);
                  connectionHealth.audio.status = 'connecting';
                  updateConnectionHealthUI();
                  audioHealth.isHealthy = false;
                  audioHealth.lastTimeUpdate = null;
                  audioHealth.bufferingStarted = Date.now();
                  startAudioHealthMonitoring();
                  state.awaitingSSE = true;
                  connectAudioStream(state.streamUrl, { forceFallback: true, reason: 'mse-error' });
                  playAudioElement('mse-fallback');
              }
          });
      } catch (err) {
          console.warn('🎧 Failed to initialize MediaSource controller; using direct audio element', err);
          state.streamController = null;
          state.useMediaSource = false;
      }
  }

  initializeMediaStreamController();

  if (elements.nowPlayingCard && elements.beetsSegments) {
      const showBeets = () => {
          if (elements.beetsSegments.dataset.hasData === 'true') {
              elements.beetsSegments.classList.remove('hidden');
          }
      };

      const hideBeets = () => {
          elements.beetsSegments.classList.add('hidden');
      };

      elements.nowPlayingCard.addEventListener('mouseenter', showBeets);
      elements.nowPlayingCard.addEventListener('mouseleave', hideBeets);
      elements.nowPlayingCard.addEventListener('focus', showBeets, true);
      elements.nowPlayingCard.addEventListener('blur', hideBeets, true);

      elements.beetsSegments.addEventListener('mouseenter', showBeets);
      elements.beetsSegments.addEventListener('mouseleave', hideBeets);
  }

  if (elements.beetsSegments) {
      elements.beetsSegments.dataset.hasData = elements.beetsSegments.dataset.hasData || 'false';
  }

  function handleDeadAudioSession() {
    if (audioHealth.handlingRestart) {
      return;
    }

    console.error('💀 Audio session is dead - restarting application');
    audioHealth.handlingRestart = true;
    audioHealth.isHealthy = false;
    if (audioHealth.checkInterval) {
      clearInterval(audioHealth.checkInterval);
      audioHealth.checkInterval = null;
    }
    audioHealth.lastTimeUpdate = null;
    audioHealth.bufferingStarted = null;

    connectionHealth.audio.status = 'error';
    updateConnectionHealthUI();

    if (state.streamController) {
      try {
        state.streamController.stop();
      } catch (err) {
        console.warn('⚠️ Failed to stop media stream controller during restart:', err);
      }
    }

    try {
      elements.audio.pause();
    } catch (err) {
      console.warn('⚠️ Failed to pause audio during restart:', err);
    }

    state.sessionId = null;
    clearFingerprint({ reason: 'audio_restart' });
    state.awaitingSSE = false;

    if (connectionHealth.currentEventSource) {
      try {
        connectionHealth.currentEventSource.close();
      } catch (err) {
        console.warn('⚠️ Failed to close SSE during restart:', err);
      }
      connectionHealth.currentEventSource = null;
    }

    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }

  function startAudioHealthMonitoring() {
    if (audioHealth.checkInterval) {
      clearInterval(audioHealth.checkInterval);
    }

    audioHealth.lastTimeUpdate = null;
    audioHealth.bufferingStarted = null;
    audioHealth.isHealthy = false;
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || 0;

    audioHealth.checkInterval = setInterval(() => {
      if (audioHealth.handlingRestart) {
        return;
      }

      const currentTime = Number(elements.audio.currentTime);
      if (Number.isFinite(currentTime)) {
        if (Math.abs(currentTime - audioHealth.lastObservedTime) > 0.05) {
          audioHealth.lastObservedTime = currentTime;
          audioHealth.lastTimeUpdate = Date.now();
          audioHealth.bufferingStarted = null;
          audioHealth.isHealthy = true;
          connectionHealth.audio.status = 'connected';
          updateConnectionHealthUI();
        }
      }

      if (!audioHealth.lastTimeUpdate) {
        return;
      }

      const now = Date.now();
      const timeSinceUpdate = now - audioHealth.lastTimeUpdate;
      const isBuffering = audioHealth.bufferingStarted !== null;
      const bufferingDuration = isBuffering ? (now - audioHealth.bufferingStarted) : 0;

      if (timeSinceUpdate > 12000) {
        console.error(`❌ Audio session dead: no timeupdate for ${(timeSinceUpdate / 1000).toFixed(1)}s`);
        handleDeadAudioSession();
        return;
      }

      if (bufferingDuration > 8000) {
        console.warn(`⚠️ Audio struggling: buffering for ${(bufferingDuration / 1000).toFixed(1)}s`);
        connectionHealth.audio.status = 'degraded';
        updateConnectionHealthUI();
        return;
      }

      if (audioHealth.isHealthy && connectionHealth.audio.status !== 'connected') {
        connectionHealth.audio.status = 'connected';
        updateConnectionHealthUI();
      }
    }, 2000);
  }

  elements.audio.addEventListener('timeupdate', () => {
    audioHealth.lastTimeUpdate = Date.now();
    audioHealth.bufferingStarted = null;
    audioHealth.isHealthy = true;
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
      audioHealth.stallTimer = null;
    }
    connectionHealth.audio.status = 'connected';
    updateConnectionHealthUI();
  });

  elements.audio.addEventListener('waiting', () => {
    console.log('⏳ Audio buffering...');
    audioHealth.bufferingStarted = Date.now();
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
  });

  elements.audio.addEventListener('playing', () => {
    console.log('▶️ Audio playing');
    audioHealth.bufferingStarted = null;
    audioHealth.lastTimeUpdate = Date.now();
    audioHealth.isHealthy = true;
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
      audioHealth.stallTimer = null;
    }
    connectionHealth.audio.status = 'connected';
    updateConnectionHealthUI();
    if (state.awaitingSSE && !connectionHealth.currentEventSource) {
      state.awaitingSSE = false;
      connectSSE();
    }
  });

  elements.audio.addEventListener('error', (e) => {
    console.error('❌ Audio error - session is dead', e);

    const mediaError = elements.audio.error;
    if (mediaError) {
      console.error('🎵 Audio error details:', {
        code: mediaError.code,
        message: mediaError.message,
        networkState: elements.audio.networkState,
        readyState: elements.audio.readyState,
        src: elements.audio.currentSrc,
        currentTime: elements.audio.currentTime,
        duration: elements.audio.duration
      });
    }

    audioHealth.isHealthy = false;
    connectionHealth.audio.status = 'error';
    updateConnectionHealthUI();

    if (typeof checkStreamEndpoint === 'function') {
      try {
        checkStreamEndpoint();
      } catch (err) {
        console.warn('⚠️ Stream endpoint check failed:', err);
      }
    }

    handleDeadAudioSession();
  });

  elements.audio.addEventListener('stalled', () => {
    console.warn('⏳ Audio reported stalled; verifying...');

    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
    }

    const stallSnapshot = {
      time: Number(elements.audio.currentTime) || 0,
      readyState: elements.audio.readyState
    };

    audioHealth.stallTimer = setTimeout(() => {
      audioHealth.stallTimer = null;

      const now = Date.now();
      const timeSinceUpdate = audioHealth.lastTimeUpdate ? now - audioHealth.lastTimeUpdate : Infinity;
      const currentTime = Number(elements.audio.currentTime) || 0;
      const advanced = Math.abs(currentTime - stallSnapshot.time) > 0.1;
      const readyOk = elements.audio.readyState >= 3;

      if (advanced || readyOk || timeSinceUpdate <= 1500) {
        console.log('✅ Audio stall cleared without intervention');
        return;
      }

      console.error('❌ Audio stalled - network failed (confirmed)');
      audioHealth.isHealthy = false;
      connectionHealth.audio.status = 'error';
      updateConnectionHealthUI();
    }, 1500);
  });

  elements.audio.addEventListener('loadstart', () => console.log('🎵 Load started'));
  elements.audio.addEventListener('canplay', () => console.log('🎵 Can play'));
  elements.audio.addEventListener('canplaythrough', () => console.log('🎵 Can play through'));



var cache = document.createElement("CACHE");
cache.style = "position:absolute;z-index:-1000;opacity:0;";
document.body.appendChild(cache);
function preloadImage(url) {
    var img = new Image();
    img.src = `url(${url})`;
    img.style = "position:absolute";
    cache.appendChild(img);
}

function createDimensionCards(explorerData, options = {}) {
      let skipExitAnimation = options.skipExitAnimation === true || state.skipNextExitAnimation === true;
      if (state.skipNextExitAnimation) {
          state.skipNextExitAnimation = false;
      }
      if (!state.hasRenderedDeck) {
          skipExitAnimation = true;
      }
  const normalizeTracks = (direction) => {
      if (!direction || !Array.isArray(direction.sampleTracks)) {
          return;
      }

          direction.sampleTracks = direction.sampleTracks
              .map(entry => {
                  if (!entry) return null;
                  if (entry.track && typeof entry.track === 'object') {
                      return entry;
                  }
                  if (typeof entry === 'object') {
                      return { track: entry };
                  }
                  return null;
              })
              .filter(Boolean);

          if (direction.oppositeDirection) {
              normalizeTracks(direction.oppositeDirection);
      }
  };

      const ensureSyntheticOpposites = (data) => {
          if (!data || !data.directions) {
              return;
          }

          const directionsMap = data.directions;
          const pendingAdds = [];

          Object.entries(directionsMap).forEach(([key, direction]) => {
              const oppositeKey = getOppositeDirection(key);
              if (!oppositeKey) {
                  return;
              }

              const hasExistingOpposite = directionsMap[oppositeKey]?.sampleTracks?.length;
              const baseSamples = Array.isArray(direction.sampleTracks)
                  ? direction.sampleTracks.map(entry => (
                      entry && typeof entry === 'object' && entry.track
                          ? { track: { ...entry.track } }
                          : entry && typeof entry === 'object'
                              ? { track: { ...entry } }
                              : null
                  )).filter(Boolean)
                  : [];

              if (!baseSamples.length) {
                  return;
              }

              if (!hasExistingOpposite) {
                  const polarity = direction.polarity === 'positive'
                      ? 'negative'
                      : direction.polarity === 'negative'
                          ? 'positive'
                          : 'negative';

                  const synthetic = {
                      ...direction,
                      key: oppositeKey,
                      direction: direction.direction || oppositeKey,
                      sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } })),
                      trackCount: direction.trackCount || baseSamples.length,
                      hasOpposite: true,
                      generatedOpposite: true,
                      polarity
                  };

                  synthetic.oppositeDirection = {
                      key,
                      sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } }))
                  };

                  pendingAdds.push({ key: oppositeKey, value: synthetic });
              }

              if (!direction.oppositeDirection) {
                  direction.oppositeDirection = {
                      key: oppositeKey,
                      sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } }))
                  };
              }

              direction.hasOpposite = true;
          });

          pendingAdds.forEach(({ key, value }) => {
              if (!directionsMap[key]) {
                  directionsMap[key] = value;
              }
          });
      };

      const previousExplorerData = state.latestExplorerData;
      // Store for later redraw
      const previousNext = previousExplorerData?.nextTrack;
      const previousNextId = previousNext?.track?.identifier || previousNext?.identifier || null;
      const incomingNextId = explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null;

      if (previousNext && previousNextId && incomingNextId && incomingNextId !== previousNextId) {
          const directionKey = previousNext.directionKey || previousNext.direction || null;
          let assignment;

          if (directionKey) {
              const directionType = getDirectionType(directionKey);
              const colors = getDirectionColor(directionType, directionKey);
              assignment = {
                  variant: variantFromDirectionType(directionType),
                  border: colors.border,
                  glow: colors.glow,
                  directionKey
              };
          } else {
              const variant = pickPanelVariant();
              const colors = colorsForVariant(variant);
              assignment = {
                  variant,
                  border: colors.border,
                  glow: colors.glow,
                  directionKey: null
              };
          }

          state.previousNextTrack = {
	      identifier: previousNextId,
	      albumCover: previousNext.albumCover,
              variant: assignment.variant,
              borderColor: assignment.border,
              glowColor: assignment.glow,
              directionKey: assignment.directionKey
          };

          cacheTrackColorAssignment(previousNextId, assignment);
      }
      state.remainingCounts = {};

      Object.values(explorerData.directions || {}).forEach(normalizeTracks);
      ensureSyntheticOpposites(explorerData);

      if (DEBUG_FLAGS.duplicates) {
          performDuplicateAnalysis(explorerData, "createDimensionCards");
      }

      const container = document.getElementById('dimensionCards');
      deckLog('🎯 Container element:', container);

      if (!container) {
          console.error('❌ NO CONTAINER ELEMENT FOUND!');
          return;
      }

      exitCardsDormantState({ immediate: true });

      const existingCards = container.querySelectorAll('.dimension-card');
      if (existingCards.length === 0) {
          skipExitAnimation = true;
      }

      const nextTrackId = explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null;
      const currentTrackId = state.latestCurrentTrack?.identifier;
      const newCurrentTrackId = explorerData.currentTrack?.identifier || null;
      const currentTrackUnchanged = Boolean(currentTrackId && newCurrentTrackId && currentTrackId === newCurrentTrackId);
      const manualOverrideActive = Boolean(state.manualNextTrackOverride && currentTrackUnchanged);

      if (state.manualNextTrackOverride) {
          deckLog('🛰️ Manual selection state', {
              manualNextTrackOverride: state.manualNextTrackOverride,
              selectedIdentifier: state.selectedIdentifier,
              currentTrackId,
              newCurrentTrackId,
              currentTrackUnchanged,
              manualOverrideActive
          });
      }

      if (manualOverrideActive && previousNext && previousNextId) {
          deckLog('🎯 Manual override active; preserving prior next-track payload for heartbeat sync');
          const manualSelection = state.selectedIdentifier
            ? findTrackInExplorer(explorerData, state.selectedIdentifier)
              || findTrackInExplorer(previousExplorerData, state.selectedIdentifier)
            : null;

          const manualDirectionKey = state.manualNextDirectionKey
            || manualSelection?.directionKey
            || previousNext?.directionKey
            || explorerData.nextTrack?.directionKey
            || state.baseDirectionKey
            || null;

          const manualTrack = manualSelection?.track
            || previousNext?.track
            || explorerData.nextTrack?.track
            || null;

          const mergedNext = manualTrack
            ? { directionKey: manualDirectionKey, track: manualTrack }
            : (previousNext || explorerData.nextTrack || null);

          state.latestExplorerData = {
              ...(previousExplorerData || {}),
              ...explorerData,
              nextTrack: mergedNext
          };
      }

      if (manualOverrideActive) {
      deckLog('🎯 Manual next track override active; preserving existing cards (selection still present)');
      if (state.nextTrackAnimationTimer) {
          clearTimeout(state.nextTrackAnimationTimer);
          state.nextTrackAnimationTimer = null;
      }
      state.usingOppositeDirection = false;
      return;
  }

      const incomingSignature = computeDirectionSignature(explorerData);
      const previousSignature = state.lastDirectionSignature;
      const forceRedraw = options.forceRedraw === true;

      state.lastDirectionSignature = incomingSignature;

      if (!forceRedraw && previousSignature && incomingSignature && previousSignature === incomingSignature) {
          deckLog('🛑 No direction changes detected; skipping redraw');
          state.latestExplorerData = explorerData;

          const container = elements.dimensionCards || document.getElementById('dimensionCards');
          const hasCards = container && container.querySelector('.dimension-card');

          if (!hasCards) {
              console.warn('🛠️ Deck empty despite unchanged signature; forcing redraw');
              createDimensionCards(explorerData, { skipExitAnimation: true, forceRedraw: true });
              return;
          }

          refreshCardsWithNewSelection();
          state.hasRenderedDeck = true;
          return;
      }

      state.latestExplorerData = explorerData;

      const preserveOppositeView = Boolean(
          state.usingOppositeDirection && previousNextId && incomingNextId && previousNextId === incomingNextId
      );

      const currentNextTrackObj = (state.latestExplorerData?.nextTrack?.track)
          || state.latestExplorerData?.nextTrack
          || explorerData.nextTrack?.track
          || explorerData.nextTrack
          || null;
      const currentNextId = currentNextTrackObj?.identifier || null;
      const preferredOpposite = getPreferredOppositeState(currentNextId, state.lastSelectionGeneration);

      if (preferredOpposite != null) {
          state.usingOppositeDirection = preferredOpposite;
          deckLog('🔁 Restoring opposite view from preference', state.reversePreference);
      } else if (!preserveOppositeView) {
          state.usingOppositeDirection = false;
      } else {
          deckLog('🔁 Preserving opposite-direction view during deck redraw');
      }

      const existingNextTrackCard = container.querySelector('.dimension-card.next-track');

      if (!skipExitAnimation) {
          const exitTargets = Array.from(container.querySelectorAll('.dimension-card')).filter(card => card !== existingNextTrackCard);
          if (exitTargets.length > 0) {
              let remaining = exitTargets.length;
              let renderScheduled = false;

              const finalizeRender = () => {
                  container.innerHTML = '';
                  createDimensionCards(explorerData, { skipExitAnimation: true });
              };

              const scheduleRender = () => {
                  if (renderScheduled) return;
                  renderScheduled = true;
                  if (existingNextTrackCard && document.body.contains(existingNextTrackCard)) {
                      demoteNextTrackCardToTray(existingNextTrackCard, finalizeRender);
                  } else {
                      finalizeRender();
                  }
              };

              const fallbackTimer = setTimeout(scheduleRender, 900);

              const tryComplete = () => {
                  remaining -= 1;
                  if (remaining <= 0 && !renderScheduled) {
                      clearTimeout(fallbackTimer);
                      scheduleRender();
                  }
              };

              exitTargets.forEach(card => {
                  let finished = false;
                  const handleDone = () => {
                      if (finished) return;
                      finished = true;
                      card.removeEventListener('transitionend', onTransitionEnd);
                      card.removeEventListener('animationend', onTransitionEnd);
                      tryComplete();
                  };
                  const onTransitionEnd = (event) => {
                      if (event.target !== card) return;
                      handleDone();
                  };
                  card.addEventListener('transitionend', onTransitionEnd);
                  card.addEventListener('animationend', onTransitionEnd);

                  card.classList.add('card-exit');
                  card.style.pointerEvents = 'none';
                  card.style.willChange = 'transform, opacity';
                  card.style.animation = 'dimensionCardExitCurve 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards';
              });
              return;
          } else if (existingNextTrackCard && document.body.contains(existingNextTrackCard)) {
              demoteNextTrackCardToTray(existingNextTrackCard, () => {
                  container.innerHTML = '';
                  createDimensionCards(explorerData, { skipExitAnimation: true });
              });
              return;
          }
      }

      // Clear existing cards
      container.innerHTML = '';

      if (!explorerData) {
          console.error('❌ NO EXPLORER DATA AT ALL!', explorerData);
          return;
      }

      if (!explorerData.directions) {
          console.error('❌ EXPLORER DATA EXISTS BUT NO DIRECTIONS!', {
              hasExplorerData: !!explorerData,
              explorerDataKeys: Object.keys(explorerData),
              directions: explorerData.directions
          });
          return;
      }

      const directionCount = Object.keys(explorerData.directions).length;
      if (directionCount === 0) {
          console.error('❌ EXPLORER DATA HAS EMPTY DIRECTIONS OBJECT!', {
              directions: explorerData.directions,
              explorerData: explorerData
          });
          return;
      }

      deckLog(`🎯 RECEIVED ${directionCount} directions from server:`, Object.keys(explorerData.directions));

      deckLog('🎯 CREATING CARDS from explorer data:', explorerData);

      // Don't auto-select globally - let each direction use its own first track by default
      deckLog(`🎯 Not setting global selectedIdentifier - each direction will use its own first track`);

      deckLog(`🔍 Raw explorerData.directions:`, explorerData.directions);

      let allDirections = Object.entries(explorerData.directions).map(([key, directionInfo]) => {
      deckLog(`🔍 Processing direction: ${key}`, directionInfo);
          return {
              key: key,
              name: directionInfo.direction || key,
              trackCount: directionInfo.trackCount,
              description: directionInfo.description,
              diversityScore: directionInfo.diversityScore,
              sampleTracks: directionInfo.sampleTracks || [],
              isOutlier: false,
              // Preserve bidirectional information from server
              hasOpposite: directionInfo.hasOpposite || false,
              oppositeDirection: directionInfo.oppositeDirection || null
          };
      });

      deckLog(`🔍 All directions mapped:`, allDirections);

      // ✅ Server now prioritizes larger stacks as primary, smaller as oppositeDirection

      // Separate outliers from regular directions
      const outlierDirections = allDirections.filter(d =>
          d.key.includes('outlier') ||
          d.key.includes('unknown') ||
          getDirectionType(d.key) === 'outlier'
      );
      const regularDirections = allDirections.filter(d => !outlierDirections.includes(d));

      deckLog(`🎯 Found ${regularDirections.length} regular directions, ${outlierDirections.length} outliers`);

      // Apply smart limits
      let directions;
      if (outlierDirections.length > 0) {
          // 11 regular + outliers (up to 12 total)
          const maxRegular = Math.min(11, 12 - outlierDirections.length);
          directions = regularDirections.slice(0, maxRegular).concat(outlierDirections.slice(0, 12 - maxRegular));
      } else {
          // 12 regular directions if no outliers
          directions = regularDirections.slice(0, 12);
      }

      deckLog(`🎯 Using ${directions.length} total directions: ${directions.length - outlierDirections.length} regular + ${outlierDirections.length} outliers`);

      if (directions.length === 0) {
          console.error(`❌ NO DIRECTIONS TO DISPLAY!`);
          console.error(`❌ All directions:`, allDirections);
          console.error(`❌ Explorer data:`, explorerData);
          return;
      }

      // Handle separate outliers data if provided (legacy support)
      if (explorerData.outliers && outlierDirections.length === 0) {
          const legacyOutliers = Object.entries(explorerData.outliers).map(([key, directionInfo]) => ({
              key: key,
              name: directionInfo.direction || key,
              trackCount: directionInfo.trackCount,
              description: directionInfo.description,
              diversityScore: directionInfo.diversityScore,
              sampleTracks: directionInfo.sampleTracks || [],
              isOutlier: true
          }));

          // Apply same smart filtering
          const totalSpaceUsed = directions.length;
          const outlierSpaceAvailable = 12 - totalSpaceUsed;
          if (outlierSpaceAvailable > 0) {
              const outliersToAdd = legacyOutliers.slice(0, outlierSpaceAvailable);
              directions.push(...outliersToAdd);
              deckLog(`🌟 Added ${outliersToAdd.length} legacy outlier directions (${outlierSpaceAvailable} slots available)`);
          }
      }

      // Server now handles bidirectional prioritization - just trust the hasOpposite flag
      const bidirectionalDirections = directions.filter(direction => direction.hasOpposite);
      deckLog(`🔄 Server provided ${bidirectionalDirections.length} directions with reverse capability`);
      deckLog(`🔄 Directions with opposites:`, bidirectionalDirections.map(d => `${d.key} (${d.sampleTracks?.length || 0} tracks)`));

      // Find the next track direction from explorer data
      const nextTrackDirection = explorerData.nextTrack ? explorerData.nextTrack.directionKey : null;

      deckLog(`🎯 About to create ${directions.length} cards - drawing order: bottom first, next track last`);
      let cardsCreated = 0;

      // Separate next track cards from regular cards for proper drawing order
      const nextTrackDirections = [];
      const clockPositionDirections = [];

      directions.forEach((direction, index) => {
          const isNextTrack = direction.key === nextTrackDirection;
          if (isNextTrack) {
              nextTrackDirections.push({ direction, originalIndex: index });
          } else {
              clockPositionDirections.push({ direction, originalIndex: index });
          }
      });

      // NEW STRATEGY: Create ALL directions as clock-positioned direction cards first
      console.log(`🎯 Creating all ${directions.length} directions as clock-positioned cards`);

      directions.forEach((direction, index) => {
          // Server provides only primary directions - trust the hasOpposite flag for reverse capability
          const hasReverse = direction.hasOpposite === true;
          const tracks = direction.sampleTracks || [];
          const trackCount = tracks.length;
          for (t in tracks) preloadImage(t.albumCover);

          deckLog(`🎯 Creating direction card ${index}: ${direction.key} (${trackCount} tracks)${hasReverse ? ' with reverse' : ''}`);
          if (hasReverse) {
              const oppositeTracks = direction.oppositeDirection?.sampleTracks || [];
              const oppositeCount = oppositeTracks.length;
              for (t in oppositeTracks) preloadImage(t.albumCover);
              deckLog(`🔄 Reverse available: ${oppositeCount} tracks in opposite direction`);
          }

          // All start as direction cards in clock positions (no special next-track handling yet)
          deckLog(`Create direction card ${index}`);
          let card;
          try {
              card = createDirectionCard(direction, index, directions.length, false, null, hasReverse, null, directions);
              deckLog(`✅ Created card for ${direction.key}, appending to container`);
              container.appendChild(card);
              if (typeof applyDirectionStackIndicator === 'function') {
                  applyDirectionStackIndicator(direction, card);
              }
              cardsCreated++;
              deckLog(`✅ Successfully added card ${index} (${direction.key}) to DOM, total cards: ${cardsCreated}`);

              // Stagger the animation
              // TODO setTimeout(() => {
                  card.classList.add('visible');
                  card.classList.add('active');
              // TODO }, index * 150 + 1000);
          } catch (error) {
              console.error(`❌ ERROR creating card ${index} (${direction.key}):`, error);
              console.error(`❌ Error details:`, error.stack);
          }
      });

      // Promote the recommended direction to center
      if (state.nextTrackAnimationTimer) {
          clearTimeout(state.nextTrackAnimationTimer);
          state.nextTrackAnimationTimer = null;
      }

      const promoteDirectionKey = explorerData.nextTrack?.directionKey || explorerData.nextTrack?.direction || null;
      if (promoteDirectionKey) {
          state.nextTrackAnimationTimer = setTimeout(() => {
              const candidateCard = document.querySelector(`[data-direction-key="${promoteDirectionKey}"]`);
              if (candidateCard) {
                  deckLog(`🎯 Animating ${promoteDirectionKey} to center as next track`);
                  animateDirectionToCenter(promoteDirectionKey);
              } else {
                  console.warn(`⚠️ Could not find card to promote for ${promoteDirectionKey}`);
              }
              state.nextTrackAnimationTimer = null;
          }, 120);
      }

      deckLog(`🎯 FINISHED creating ${cardsCreated} cards in container`);

      if (DEBUG_FLAGS.deck) {
        // Diagnostic counts
        const allCards = container.querySelectorAll('.dimension-card');
        const nextTrackCards = container.querySelectorAll('.dimension-card.next-track');
        const regularCards = container.querySelectorAll('.dimension-card:not(.next-track)');
        const trackDetailCards = container.querySelectorAll('.track-detail-card');

        deckLog(`🐞 DOM CARDS SUMMARY:`);
        deckLog(`🐞   Total cards in DOM: ${allCards.length}`);
        deckLog(`🐞   Next track cards: ${nextTrackCards.length}`);
        deckLog(`🐞   Regular direction cards: ${regularCards.length}`);
        deckLog(`🐞   Track detail cards: ${trackDetailCards.length}`);

        allCards.forEach((card, index) => {
            const labelDiv = card.querySelector('.label');
            const text = labelDiv ? labelDiv.textContent.trim() : 'NO LABEL';
            const isNextTrack = card.classList.contains('next-track');
            const isTrackDetail = card.classList.contains('track-detail-card');
            deckLog(`🐞   Card ${index}: ${isNextTrack ? '[NEXT]' : '[REG]'} ${isTrackDetail ? '[TRACK]' : '[DIR]'} "${text.substring(0, 50)}..."`);
        });
      }

      // Apply initial selection state to show stacked cards immediately
      setTimeout(() => {
          refreshCardsWithNewSelection();
      }, 100);

      if (state.cardsDormant) {
          const info = resolveNextTrackData();
          if (info?.track) {
              showNextTrackPreview(info.track, { directionKey: info.directionKey || info.track?.directionKey || null });
          }
      }

      state.hasRenderedDeck = true;
  }


  // Swap the roles: make a direction the new next track stack, demote current next track to regular direction
  function swapNextTrackDirection(newNextDirectionKey) {
      if (!state.latestExplorerData || !state.latestExplorerData.directions[newNextDirectionKey]) {
          console.error('Cannot swap to direction:', newNextDirectionKey);
          return;
      }

      deckLog(`🔄 Swapping next track direction from ${state.latestExplorerData.nextTrack?.directionKey} to ${newNextDirectionKey}`);

      if (typeof clearStackedPreviewLayer === 'function') {
          clearStackedPreviewLayer();
      }

      // Get the first track from the new direction
      const newDirection = state.latestExplorerData.directions[newNextDirectionKey];
      const sampleTracks = newDirection.sampleTracks || [];
      const firstTrack = sampleTracks[0] ? (sampleTracks[0].track || sampleTracks[0]) : null;

      if (!firstTrack) {
          console.error('No tracks available in direction:', newNextDirectionKey);
          return;
      }

      // Update the global state
      state.selectedIdentifier = firstTrack.identifier;
      state.stackIndex = 0;
      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }
      state.remainingCounts[newNextDirectionKey] = Math.max(0, sampleTracks.length - 1);

      // Update latestExplorerData to reflect the new next track
      state.latestExplorerData.nextTrack = {
          directionKey: newNextDirectionKey,
          direction: newDirection.direction,
          track: firstTrack
      };

      // Send the new next track selection to the server
      sendNextTrack(firstTrack.identifier, newNextDirectionKey, 'user');

      // Redraw all cards with the new next track assignment
      // This will maintain positions but swap the content and styling
      redrawDimensionCardsWithNewNext(newNextDirectionKey);
  }

  function navigateDirectionToCenter(newDirectionKey) {
      if (!state.latestExplorerData || !state.latestExplorerData.directions) {
          console.warn('Cannot navigate directions: explorer data missing');
          return;
      }

      const direction = state.latestExplorerData.directions[newDirectionKey];
      if (!direction) {
          console.warn('Cannot navigate: direction not found', newDirectionKey);
          return;
      }

      const sampleTracks = direction.sampleTracks || [];
      const primaryEntry = sampleTracks[0];
      const primaryTrack = primaryEntry ? (primaryEntry.track || primaryEntry) : null;
      if (!primaryTrack || !primaryTrack.identifier) {
          console.warn('Cannot navigate: direction has no primary track', newDirectionKey);
          return;
      }

      const currentCenterKey = state.latestExplorerData?.nextTrack?.directionKey || null;
      if (currentCenterKey && currentCenterKey === newDirectionKey) {
          cycleStackContents(newDirectionKey, state.stackIndex);
          return;
      }
      let promotionDelay = 0;

      if (currentCenterKey && currentCenterKey !== newDirectionKey && typeof rotateCenterCardToNextPosition === 'function') {
          const demoted = rotateCenterCardToNextPosition(currentCenterKey);
          if (demoted) {
              promotionDelay = 820;
          }
      }

      const performPromotion = () => {
          state.selectedIdentifier = primaryTrack.identifier;
          state.stackIndex = 0;
          state.pendingManualTrackId = primaryTrack.identifier;
          state.manualNextTrackOverride = true;
          state.manualNextDirectionKey = newDirectionKey;
          state.pendingSnapshotTrackId = primaryTrack.identifier;

          if (!state.remainingCounts) {
              state.remainingCounts = {};
          }
          state.remainingCounts[newDirectionKey] = Math.max(0, sampleTracks.length - 1);

          state.latestExplorerData.nextTrack = {
              directionKey: newDirectionKey,
              direction: direction.direction,
              track: primaryTrack
          };

          state.usingOppositeDirection = false;

          if (typeof animateDirectionToCenter === 'function') {
              animateDirectionToCenter(newDirectionKey);
          } else {
              convertToNextTrackStack(newDirectionKey);
          }

          sendNextTrack(primaryTrack.identifier, newDirectionKey, 'user');
      };

      if (promotionDelay > 0) {
          setTimeout(performPromotion, promotionDelay);
      } else {
          performPromotion();
      }
  }

  window.navigateDirectionToCenter = navigateDirectionToCenter;

  // Update the colors of stacked cards to preview other tracks in the direction
  function updateStackedCardColors(selectedCard, directionKey) {
      if (!state.latestExplorerData.directions[directionKey]) return;

      const sampleTracks = state.latestExplorerData.directions[directionKey].sampleTracks || [];

      // Find colors from other tracks in this direction
      const colorVariations = sampleTracks.slice(1, 3).map((trackObj, index) => {
          const track = trackObj.track || trackObj;
          // Generate different hues for variety
          const hue = 220 + (index * 30); // Start at blue, vary by 30 degrees
          return `hsl(${hue}, 70%, 50%)`;
      });

      // Update CSS custom properties for stacked card colors
      if (colorVariations.length > 0) {
          selectedCard.style.setProperty('--stack-color-1', colorVariations[0] || '#3a39ff');
          selectedCard.style.setProperty('--stack-color-2', colorVariations[1] || '#2d1bb8');
      }
  }

  // Helper function to format track duration
  function formatTrackTime(duration) {
      if (!duration) return '';
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Refresh cards with new selection state (seamlessly, no blinking)
  function refreshCardsWithNewSelection() {
      const ICON = '🛰️';
      if (!state.latestExplorerData || !state.selectedIdentifier) return;
      console.log('🔄 Seamlessly updating selection:', state.selectedIdentifier);

      const extractStoredTrackFromCard = (cardEl) => {
          if (!cardEl) return null;
          const { trackMd5, trackTitle, trackArtist, trackAlbum, trackDurationSeconds } = cardEl.dataset || {};
          if (!trackMd5) return null;

          const stored = {
              identifier: trackMd5,
              title: trackTitle || undefined,
              artist: trackArtist || undefined,
              album: trackAlbum || undefined
          };

          const numericDuration = Number(trackDurationSeconds);
          if (Number.isFinite(numericDuration)) {
              stored.duration = numericDuration;
          }

          return stored;
      };

      // Find the selected card first
      const allTrackCards = document.querySelectorAll('.dimension-card.next-track');
      if (allTrackCards.length === 0) {
          if (state.manualNextTrackOverride) {
              console.warn(`${ICON} ACTION selection-cards-unavailable`, {
                  selection: state.selectedIdentifier,
                  reason: 'no next-track cards rendered'
              });
          }
          updateNextTrackMetadata(null);
          return;
      }
      let selectedCard = null;
      let selectedDimensionKey = null;
      let selectedTrackData = null;

      // First pass: identify the selected card
      allTrackCards.forEach(card => {
          if (card.dataset.trackMd5 === state.selectedIdentifier) {
              selectedCard = card;
              selectedDimensionKey = card.dataset.directionKey;
          }
      });

      if (!selectedCard) {
          const fallbackCard = allTrackCards[0];
          const fallbackId = fallbackCard?.dataset?.trackMd5 || null;
          if (fallbackCard && fallbackId) {
              console.warn(`${ICON} ACTION selection-card-fallback`, {
                  selection: state.selectedIdentifier,
                  fallback: fallbackId,
                  direction: fallbackCard.dataset.directionKey
              });
              state.selectedIdentifier = fallbackId;
              selectedCard = fallbackCard;
              selectedDimensionKey = fallbackCard.dataset.directionKey;
          }
      }

      if (!selectedCard) {
          state.selectionRetryCount = (state.selectionRetryCount || 0) + 1;

          const animatingCenterCard = Array.from(allTrackCards).some(card => card.classList.contains('animating-to-center'));
          const retryCap = animatingCenterCard ? 12 : 5;

          if (state.selectionRetryCount <= retryCap) {
              const retryDelay = animatingCenterCard ? 180 : 120;
              if (!state.selectionRetryTimer) {
                  state.selectionRetryTimer = setTimeout(() => {
                      state.selectionRetryTimer = null;
                      refreshCardsWithNewSelection();
                  }, retryDelay);
              }
              if (state.selectionRetryCount === 1) {
                  console.debug(`${ICON} ACTION selection-card-pending`, {
                      selection: state.selectedIdentifier,
                      reason: animatingCenterCard ? 'center animation in progress' : 'awaiting dataset sync'
                  });
              }
              return;
          }

          console.error(`${ICON} ACTION selection-card-missing`, {
              selection: state.selectedIdentifier,
              availableCards: Array.from(allTrackCards).map(card => ({
                  direction: card.dataset.directionKey,
                  track: card.dataset.trackMd5
              }))
          });
          state.selectionRetryCount = 0;
          if (state.selectionRetryTimer) {
              clearTimeout(state.selectionRetryTimer);
              state.selectionRetryTimer = null;
          }
          return;
      }

      state.selectionRetryCount = 0;
      if (state.selectionRetryTimer) {
          clearTimeout(state.selectionRetryTimer);
          state.selectionRetryTimer = null;
      }

      // Second pass: update all cards based on selection
      allTrackCards.forEach(card => {
          const cardTrackMd5 = card.dataset.trackMd5;
          const directionKey = card.dataset.directionKey;
          const isSelectedCard = (cardTrackMd5 === state.selectedIdentifier);
          const isSameDimension = (directionKey === selectedDimensionKey);

          const labelDiv = card.querySelector('.label');
          if (!labelDiv) return;

          if (isSelectedCard) {
              // Update the top card content to show selected track
              card.classList.add('selected');

              const directionData = state.latestExplorerData?.directions?.[directionKey];
              let selectedIdx = -1;
              if (directionData && Array.isArray(directionData.sampleTracks)) {
                  selectedIdx = directionData.sampleTracks.findIndex(sample => {
                      const sampleTrack = sample.track || sample;
                      return sampleTrack?.identifier === state.selectedIdentifier;
                  });
                  if (selectedIdx >= 0) {
                      card.dataset.trackIndex = String(selectedIdx);
                  }
              }
              if (!state.remainingCounts) {
                  state.remainingCounts = {};
              }
              const totalTracks = directionData?.sampleTracks?.length || 0;
              const effectiveIndex = selectedIdx >= 0 ? selectedIdx : 0;
              card.dataset.totalTracks = String(totalTracks);
              state.remainingCounts[directionKey] = Math.max(0, totalTracks - effectiveIndex - 1);
              if (directionData && typeof updateStackSizeIndicator === 'function') {
                  updateStackSizeIndicator(directionData, card, selectedIdx >= 0 ? selectedIdx : undefined);
              }

              // Find the track data using the corrected index
              const direction = state.latestExplorerData?.directions?.[directionKey];
              let track = direction && direction.sampleTracks && effectiveIndex >= 0 ?
                  (direction.sampleTracks[effectiveIndex]?.track || direction.sampleTracks[effectiveIndex]) : null;

              const nextTrackPayload = state.latestExplorerData?.nextTrack?.track || state.latestExplorerData?.nextTrack;
              if ((!track || track.identifier !== cardTrackMd5) && nextTrackPayload?.identifier === cardTrackMd5) {
                  track = nextTrackPayload;
              }

              if (!track || track.identifier !== cardTrackMd5) {
                  const storedTrack = extractStoredTrackFromCard(card);
                  if (storedTrack) {
                      track = storedTrack;
                  }
              }

              if (!track) {
                  console.warn(`${ICON} ACTION selection-track-missing`, {
                      selection: state.selectedIdentifier,
                      cardDirection: directionKey,
                      cardTrack: cardTrackMd5
                  });
                  return;
              }

              const resolvedTitle = track.title || card.dataset.trackTitle || getDisplayTitle({ identifier: cardTrackMd5 });
              const resolvedArtist = track.artist || card.dataset.trackArtist || 'Unknown Artist';
              const resolvedAlbum = track.album || card.dataset.trackAlbum || '';

              const numericDuration = Number(track.duration ?? track.length ?? card.dataset.trackDurationSeconds);
              const durationDisplay = Number.isFinite(numericDuration)
                  ? formatTrackTime(numericDuration)
                  : (card.dataset.trackDurationDisplay || '??:??');

              card.dataset.trackTitle = resolvedTitle || '';
              card.dataset.trackArtist = resolvedArtist || '';
              card.dataset.trackAlbum = resolvedAlbum || '';
              if (Number.isFinite(numericDuration)) {
                  card.dataset.trackDurationSeconds = String(numericDuration);
              } else {
                  delete card.dataset.trackDurationSeconds;
              }
              card.dataset.trackDurationDisplay = durationDisplay;

              // Show full track details
              const directionName = direction?.isOutlier ? "Outlier" : formatDirectionName(directionKey);
              labelDiv.innerHTML = `
                  <h2>${directionName}</h2>
                  <h3>${resolvedTitle}</h3>
                  <h4>${resolvedArtist || 'Unknown Artist'}</h4>
                  <h5>${resolvedAlbum || ''}</h5>
                  <p>${durationDisplay} · FLAC</p>
              `;

              // Update stacked card colors based on other tracks in this direction
              updateStackedCardColors(card, directionKey);
              selectedTrackData = {
                  ...track,
                  identifier: cardTrackMd5,
                  title: resolvedTitle,
                  artist: resolvedArtist,
                  album: resolvedAlbum,
                  duration: Number.isFinite(numericDuration) ? numericDuration : track.duration
              };
          } else if (isSameDimension) {
              // Hide other cards from same dimension (they're behind the selected one)
              card.style.opacity = '0';
          } else {
              // Cards from other dimensions remain unchanged
              card.classList.remove('selected');
              const baseDirection = state.latestExplorerData?.directions?.[directionKey];
              const baseName = baseDirection?.isOutlier ? "Outlier" : formatDirectionName(directionKey);
              labelDiv.innerHTML = `<div class="dimension-label">${baseName}</div>`;
          }
      });

      if (selectedCard && selectedTrackData) {
          updateNextTrackMetadata(selectedTrackData);
      } else {
          updateNextTrackMetadata(null);
      }
  }

  window.refreshCardsWithNewSelection = refreshCardsWithNewSelection;

  // ====== Audio Controls ======
  async function startAudio() {
      if (state.isStarted) return;

      // Immediately hide clickwall and show interface
      elements.clickCatcher.classList.add('fadeOut');
      elements.volumeControl.style.display = 'flex';
      elements.volumeBar.style.height = (elements.audio.volume * 100) + '%';
      document.body.style.cursor = 'default';
      state.isStarted = true;

      // Remove clickwall completely after fade
      setTimeout(() => {
          elements.clickCatcher.style.display = 'none';
      }, 800);

      const streamUrl = composeStreamEndpoint(state.streamFingerprint, Date.now());
      console.log(`🎵 Audio connecting to ${streamUrl}`);

      startAudioHealthMonitoring();
      audioHealth.isHealthy = false;
      audioHealth.lastTimeUpdate = null;
      audioHealth.bufferingStarted = Date.now();

      connectionHealth.audio.status = 'connecting';
      updateConnectionHealthUI();

      connectAudioStream(streamUrl, { reason: 'initial-start' });
      state.awaitingSSE = true;

      playAudioElement('initial-start');
  }

  // Click to start
  elements.clickCatcher.addEventListener('click', startAudio);

  // Handle window resize for force layout
  window.addEventListener('resize', () => {
      if (state.forceLayout) {
          state.forceLayout.resizeContainer();
      }
  });

  // Keep manual start - do not auto-start
  elements.audio.addEventListener('canplay', () => {
      if (state.isStarted) return;
      // User prefers manual click-to-start
  });

  // Volume control
  elements.volumeControl.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = elements.volumeControl.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const percent = 1 - (y / rect.height);
      const volume = Math.max(0, Math.min(1, percent));

      elements.audio.volume = volume;
      elements.volumeBar.style.height = (volume * 100) + '%';
  });

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
      if (!state.isStarted) return;
      if (!state.journeyMode) return;

      const directionKey = state.latestExplorerData?.nextTrack?.directionKey;
      if (!directionKey) return;

      const clockCards = Array.from(document.querySelectorAll('[data-direction-key]:not(.next-track)'))
          .map(c => ({
              element: c,
              key: c.dataset.directionKey,
              position: parseInt(c.dataset.clockPosition) || 12
          }))
          .sort((a, b) => a.position - b.position);

      const occupiedPositions = new Set(clockCards.map(c => c.position));

      const nextTrackCard = document.querySelector(`.dimension-card.next-track[data-direction-key="${directionKey}"]`);
      if (!nextTrackCard) return;

      let nextPosition = nextTrackCard.dataset.originalClockPosition
          ? parseInt(nextTrackCard.dataset.originalClockPosition)
          : 1;

      switch (e.key) {
          case '+':
              elements.audio.volume = Math.min(1, elements.audio.volume + 0.1);
              elements.volumeBar.style.height = (elements.audio.volume * 100) + '%';
              e.preventDefault();
              break;

          case '-':
              elements.audio.volume = Math.max(0, elements.audio.volume - 0.1);
              elements.volumeBar.style.height = (elements.audio.volume * 100) + '%';
              e.preventDefault();
              break;

          case 'ArrowRight': { // rotate the wheel clockwise
              let targetCard = null;
              for (let i = nextPosition + 1; i <= nextPosition + 12; i++) {
                  const candidatePos = ((i + 11) % 12) + 1;
                  targetCard = clockCards.find(c => c.position === candidatePos);
                  if (targetCard) {
                      nextPosition = candidatePos;
                      break;
                  }
              }

              if (targetCard) {
                  navigateDirectionToCenter(targetCard.key);
              } else {
                  console.warn('⚠️ ArrowRight: no available direction card to rotate to');
              }
              e.preventDefault();
              break;
          }

          case 'ArrowLeft': { // rotate the wheel counter-clockwise
              let targetCard = null;
              for (let i = nextPosition - 1; i >= nextPosition - 12; i--) {
                  const candidatePos = ((i - 1) % 12 + 12) % 12 + 1;
                  targetCard = clockCards.find(c => c.position === candidatePos);
                  if (targetCard) {
                      nextPosition = candidatePos;
                      break;
                  }
              }

              if (targetCard) {
                  navigateDirectionToCenter(targetCard.key);
              } else {
                  console.warn('⚠️ ArrowLeft: no available direction card to rotate to');
              }
              e.preventDefault();
              break;
          }

          case 'ArrowDown':
              // deal another card from the pack
              const directionKey =  state.latestExplorerData.nextTrack.directionKey;
              cycleStackContents(directionKey, state.stackIndex);
              e.preventDefault();
              break;

          case 'ArrowUp': {
              // flip a reversable next track stack
              const key = state.latestExplorerData.nextTrack.directionKey;
              const directions = state.latestExplorerData?.directions || {};
              const currentDirection = directions[key];
              const normalizeSamples = (samples) => {
                  if (!Array.isArray(samples)) return [];
                  return samples
                      .map(entry => {
                          const track = entry?.track || entry;
                          if (!track || !track.identifier) return null;
                          return { track };
                      })
                      .filter(Boolean);
              };

              let oppositeKey = getOppositeDirection(key);
              let oppositeDirection = currentDirection?.oppositeDirection || null;

              const tryResolveFromMap = () => {
                  if (!oppositeDirection && oppositeKey && directions[oppositeKey]) {
                      oppositeDirection = directions[oppositeKey];
                  }
              };

              tryResolveFromMap();

              if (!oppositeDirection) {
                  const embedded = Object.values(directions).find(dir => dir?.oppositeDirection && (dir.oppositeDirection.key === key || dir.oppositeDirection.direction === key));
                  if (embedded?.oppositeDirection) {
                      oppositeDirection = embedded.oppositeDirection;
                      if (!oppositeKey) {
                          oppositeKey = embedded.oppositeDirection.key || embedded.oppositeDirection.direction || null;
                      }
                  }
              }

              tryResolveFromMap();

              if (!oppositeDirection && !oppositeKey && currentDirection?.hasOpposite) {
                  oppositeKey = getOppositeDirection(currentDirection.key || key);
                  tryResolveFromMap();
              }

              if (currentDirection && oppositeDirection) {
                  const normalizedCurrentSamples = normalizeSamples(currentDirection.sampleTracks);
                  const normalizedOppositeSamples = normalizeSamples(oppositeDirection.sampleTracks);
                  const resolvedOppositeKey = oppositeKey
                      || oppositeDirection.key
                      || oppositeDirection.direction
                      || null;

                  if (!resolvedOppositeKey) {
                      console.warn(`Opposite direction key unresolved for ${key}`);
                      e.preventDefault();
                      break;
                  }

                  const oppositeDirectionEntry = {
                      ...oppositeDirection,
                      key: resolvedOppositeKey,
                      sampleTracks: normalizedOppositeSamples
                  };

                  if (!oppositeDirectionEntry.oppositeDirection) {
                      oppositeDirectionEntry.oppositeDirection = {
                          key,
                          sampleTracks: normalizedCurrentSamples
                      };
                  }

                  if (!currentDirection.oppositeDirection) {
                      currentDirection.oppositeDirection = {
                          key: resolvedOppositeKey,
                          sampleTracks: normalizedOppositeSamples
                      };
                  }

                  state.latestExplorerData.directions[resolvedOppositeKey] = {
                      ...(directions[resolvedOppositeKey] || {}),
                      ...oppositeDirectionEntry
                  };

                  // Swap stack contents immediately without animation
                  swapStackContents(key, resolvedOppositeKey);
              } else {
                  console.warn(`Opposite direction not available for ${key}`);
              }
              e.preventDefault();
              break;
          }

          case 'Escape':
              e.preventDefault();
              break;

          case '\t':
              // Seek behavior: halfway in first wipe, 5 secs before crossfade in second wipe
              // Since audio is streamed, requires server-side cooperation
              if (!elements.audio || !elements.audio.duration) {
                  console.log('🎮 ESC pressed but no audio duration available');
                  e.preventDefault();
                  break;
              }

              const currentTime = elements.audio.currentTime;
              const totalDuration = elements.audio.duration;
              const progress = currentTime / totalDuration;

              let seekTarget;
              if (progress <= 0.5) {
                  // First wipe (browsing phase): seek to halfway through track
                  seekTarget = 'halfway';
                  console.log('🎮 ESC pressed in first wipe - requesting seek to halfway');
              } else {
                  // Second wipe (locked in phase): seek to 5 seconds before end (crossfade point)
                  seekTarget = 'crossfade';
                  console.log('🎮 ESC pressed in second wipe - requesting seek to crossfade point');
              }

                      fetch('/session/seek', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              target: seekTarget,
                              requestSync: true,  // Ask server to re-confirm timing
                              fadeTransition: true
                          })
                      }).then(response => {
                          if (response.ok) {
                              console.log('✅ Server seek request sent - awaiting SSE sync response');

                              // Server will send timing sync via SSE, so we just need to prepare for fade in
                              // Set up temporary handler for seek sync SSE event
                              const handleSeekSync = (event) => {
                                  const data = JSON.parse(event.data);
                                  if (data.type === 'seek_sync') {
                                      console.log(`🔄 SSE seek sync: duration=${data.newDuration}s, position=${data.currentPosition}s`);

                                      // Restart progress animation with server's updated timing
                                      if (state.progressAnimation) {
                                          clearInterval(state.progressAnimation);
                                      }

                                      const currentProgress = data.currentPosition / data.newDuration;

                                      // Update progress bar to match server position immediately
                                      const progressBar = document.getElementById('fullscreenProgress');
                                      if (progressBar) {
                                          if (currentProgress <= 0.5) {
                                              // Phase 1: growing from left
                                              progressBar.style.left = '0%';
                                              progressBar.style.width = (currentProgress * 200) + '%';
                                          } else {
                                              // Phase 2: shrinking from right
                                              const phase2Progress = (currentProgress - 0.5) * 2;
                                              progressBar.style.left = (phase2Progress * 100) + '%';
                                              progressBar.style.width = (100 - phase2Progress * 100) + '%';
                                          }
                                      }

                                      // Restart animation for remaining time
                                      startProgressAnimationFromPosition(data.newDuration, data.currentPosition, { resync: true });

                                      // Remove temporary event listener
                                      if (connectionHealth.currentEventSource) {
                                          connectionHealth.currentEventSource.removeEventListener('message', handleSeekSync);
                                      }
                                  }
                              };

                              // Add temporary listener for seek sync response
                              if (connectionHealth.currentEventSource) {
                                  connectionHealth.currentEventSource.addEventListener('message', handleSeekSync);
                              }

                              // Timeout fallback in case SSE doesn't respond
                              setTimeout(() => {
                                  if (connectionHealth.currentEventSource) {
                                      connectionHealth.currentEventSource.removeEventListener('message', handleSeekSync);
                                  }
                              }, 2000);

                          } else {
                              console.error('❌ Server seek request failed');
                              elements.audio.volume = originalVolume; // Restore volume on error
                          }
                      }).catch(err => {
                          console.error('❌ Seek request error:', err);
                          elements.audio.volume = originalVolume; // Restore volume on error
                      });

              e.preventDefault();
              break;

          case '1':
              // Microscope - ultra close examination
              console.log('🔬 Key 1: Microscope mode');

              fetch('/session/zoom/microscope', {
                  method: 'POST'
              }).catch(err => console.error('Microscope request failed:', err));
              e.preventDefault();
              rejig();
              break;

          case '2':
              // Magnifying glass - detailed examination
              console.log('🔍 Key 2: Magnifying glass mode');
              fetch('/session/zoom/magnifying', {
                  method: 'POST'
              }).catch(err => console.error('Magnifying request failed:', err));
              e.preventDefault();
              rejig();
              break;

          case '3':
              // Binoculars - wide exploration
              console.log('🔭 Key 3: Binoculars mode');
              fetch('/session/zoom/binoculars', {
                  method: 'POST'
              }).catch(err => console.error('Binoculars request failed:', err));
              e.preventDefault();
              rejig();
              break;
      }
  });

  animateBeams(sceneInit());

  elements.audio.addEventListener('play', () => {
      if (state.pendingInitialTrackTimer) return;

      state.pendingInitialTrackTimer = setTimeout(() => {
          const hasTrack = state.latestCurrentTrack && state.latestCurrentTrack.identifier;
        if (!hasTrack) {
            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            state.pendingManualTrackId = null;
            state.selectedIdentifier = null;
            state.stackIndex = 0;
            console.warn('🛰️ ACTION initial-track-missing: no SSE track after 10s, requesting refresh');
            fullResync();
        }
      }, 10000);
  });


const MAX_TRAY_HISTORY_ITEMS = 5;

function ensureTrayElements() {
    return {
        tray: elements.nextTrackTray,
        preview: elements.nextTrackTrayPreview,
        items: elements.nextTrackTrayItems
    };
}

function showNextTrackPreview(track, { directionKey = null } = {}) {
    const { preview } = ensureTrayElements();
    if (!preview) {
        return;
    }

    const cover = track?.albumCover || track?.cover || null;
    if (!cover) {
        hideNextTrackPreview({ immediate: true });
        return;
    }

    const trackId = track?.identifier || null;
    if (
        state.nextTrackPreviewTrackId === trackId &&
        preview.classList.contains('visible') &&
        preview.style.backgroundImage === `url("${cover}")`
    ) {
        return;
    }

    if (nextTrackPreviewFadeTimer) {
        clearTimeout(nextTrackPreviewFadeTimer);
        nextTrackPreviewFadeTimer = null;
    }

    preview.style.backgroundImage = `url("${cover}")`;
    preview.dataset.trackId = trackId || '';
    preview.dataset.directionKey = directionKey || '';
    preview.dataset.trackTitle = getDisplayTitle(track) || '';
    preview.dataset.trackArtist = track?.artist || '';
    preview.classList.remove('fade-out');
    preview.classList.add('visible');
    state.nextTrackPreviewTrackId = trackId;
}

function hideNextTrackPreview({ immediate = false } = {}) {
    const { preview } = ensureTrayElements();
    if (!preview) {
        return;
    }

    if (nextTrackPreviewFadeTimer) {
        clearTimeout(nextTrackPreviewFadeTimer);
        nextTrackPreviewFadeTimer = null;
    }

    if (immediate) {
        preview.classList.remove('visible', 'fade-out');
        preview.style.backgroundImage = '';
        delete preview.dataset.trackId;
        delete preview.dataset.directionKey;
        delete preview.dataset.trackTitle;
        delete preview.dataset.trackArtist;
        state.nextTrackPreviewTrackId = null;
        return;
    }

    if (!preview.classList.contains('visible')) {
        state.nextTrackPreviewTrackId = null;
        return;
    }

    preview.classList.add('fade-out');
    nextTrackPreviewFadeTimer = setTimeout(() => {
        preview.classList.remove('visible', 'fade-out');
        preview.style.backgroundImage = '';
        delete preview.dataset.trackId;
        delete preview.dataset.directionKey;
        delete preview.dataset.trackTitle;
        delete preview.dataset.trackArtist;
        state.nextTrackPreviewTrackId = null;
        nextTrackPreviewFadeTimer = null;
    }, 600);
}

function normalizeTrayTrack(track) {
    if (!track) {
        return null;
    }
    return {
        identifier: track.identifier || track.trackMd5 || null,
        title: getDisplayTitle(track),
        artist: track.artist || '',
        album: track.album || '',
        albumCover: track.albumCover || track.cover || '',
        duration: typeof track.duration === 'number' ? track.duration : null,
        directionKey: track.directionKey || null
    };
}

function removeTrayItemByTrackId(trackId) {
    if (!trackId) return;
    const { items } = ensureTrayElements();
    if (!items) return;
    const existing = items.querySelector(`[data-track-id="${trackId}"]`);
    if (existing) {
        existing.remove();
    }
    state.nextTrackHistory = state.nextTrackHistory.filter(entry => entry.track.identifier !== trackId);
}

function animateRemoveLeftmostTrayItem(expectedTrackId = null) {
    const { items } = ensureTrayElements();
    if (!items) return;

    let target = null;
    if (expectedTrackId) {
        target = items.querySelector(`[data-track-id="${expectedTrackId}"]`);
    }

    if (!target) {
        target = items.querySelector('.next-track-tray-item');
    }

    if (!target || target.dataset.removing === 'true') {
        return;
    }

    target.dataset.removing = 'true';
    target.classList.remove('visible');
    target.classList.add('exit-left');
    target.style.pointerEvents = 'none';
    target.style.willChange = 'transform, opacity';

    const trackId = target.dataset.trackId || expectedTrackId || null;

    const finalizeRemoval = () => {
        target.removeEventListener('animationend', finalizeRemoval);
        if (target.parentElement) {
            target.parentElement.removeChild(target);
        }

        if (trackId) {
            state.nextTrackHistory = state.nextTrackHistory.filter(entry => entry.track.identifier !== trackId);
        } else if (state.nextTrackHistory.length) {
            state.nextTrackHistory.shift();
        }
    };

    target.addEventListener('animationend', finalizeRemoval);

    setTimeout(() => {
        if (target.parentElement) {
            finalizeRemoval();
        }
    }, 800);
}

function addNextTrackTrayItem({ track, directionKey }, { deferReveal = false } = {}) {
    const { items } = ensureTrayElements();
    if (!items || !track?.identifier) {
        return null;
    }

    removeTrayItemByTrackId(track.identifier);

    const item = document.createElement('div');
    item.className = 'next-track-tray-item';
    const resolvedDirectionKey = directionKey || track.directionKey || '';
    item.dataset.trackId = track.identifier;
    item.dataset.directionKey = resolvedDirectionKey;

    const cover = document.createElement('div');
    cover.className = 'next-track-tray-cover';
    if (track.albumCover) {
        cover.style.backgroundImage = `url("${track.albumCover}")`;
    }
    item.appendChild(cover);

    if (deferReveal) {
        item.classList.add('pending');
    }

    items.prepend(item);

    state.nextTrackHistory.unshift({ track, directionKey: resolvedDirectionKey || null });

    requestAnimationFrame(() => {
        if (deferReveal) return;
        item.classList.add('visible');
    });

    trimNextTrackHistory();

    return item;
}

function trimNextTrackHistory() {
    const { items } = ensureTrayElements();
    if (!items) return;

    while (state.nextTrackHistory.length > MAX_TRAY_HISTORY_ITEMS) {
        const removed = state.nextTrackHistory.pop();
        if (removed?.track?.identifier) {
            const extra = items.querySelector(`[data-track-id="${removed.track.identifier}"]`);
            if (extra) {
                extra.remove();
            }
        }
    }

    while (items.children.length > MAX_TRAY_HISTORY_ITEMS) {
        const removedNode = items.lastElementChild;
        const removedId = removedNode?.dataset?.trackId;
        items.removeChild(removedNode);
        if (removedId) {
            state.nextTrackHistory = state.nextTrackHistory.filter(entry => entry.track.identifier !== removedId);
        }
    }
}

function extractTrackDataFromCard(card) {
    if (!card) return null;
    const identifier = card.dataset.trackMd5 || card.dataset.trackIdentifier || null;
    if (!identifier) {
        return null;
    }

    return {
        track: {
            identifier,
            title: card.dataset.trackTitle || '',
            artist: card.dataset.trackArtist || '',
            album: card.dataset.trackAlbum || '',
            albumCover: card.dataset.trackAlbumCover || '',
            duration: card.dataset.trackDurationSeconds ? Number(card.dataset.trackDurationSeconds) : null,
            directionKey: card.dataset.directionKey || card.dataset.baseDirectionKey || null
        },
        directionKey: card.dataset.directionKey || card.dataset.baseDirectionKey || null
    };
}

function demoteNextTrackCardToTray(card, onComplete = () => {}) {
    if (!card) {
        onComplete();
        return;
    }

    if (typeof clearStackedPreviewLayer === 'function') {
        clearStackedPreviewLayer();
    }

    const { tray, items } = ensureTrayElements();
    if (!tray || !items) {
        card.remove();
        onComplete();
        return;
    }

    state.skipNextExitAnimation = true;

    const extracted = extractTrackDataFromCard(card);
    const normalizedTrack = extracted ? normalizeTrayTrack(extracted.track) : null;
    let trayItem = null;

    if (normalizedTrack) {
        trayItem = addNextTrackTrayItem({
            track: normalizedTrack,
            directionKey: extracted.directionKey || normalizedTrack.directionKey
        }, { deferReveal: true });
    }

    const containerRect = elements.dimensionCards?.getBoundingClientRect();
    if (!containerRect) {
        if (trayItem) {
            trayItem.classList.remove('pending');
            trayItem.classList.add('visible');
        }
        card.remove();
        onComplete();
        return;
    }

    const cardRect = card.getBoundingClientRect();
    const startLeft = cardRect.left + cardRect.width / 2 - containerRect.left;
    const startTop = cardRect.top + cardRect.height / 2 - containerRect.top;

    card.style.transition = 'none';
    card.style.left = `${startLeft}px`;
    card.style.top = `${startTop}px`;
    card.style.transform = 'translate(-50%, -50%) translateZ(-400px) scale(1)';
    card.style.opacity = '1';

    // Force reflow
    void card.offsetWidth;

    let animationFinished = false;

    const finalize = () => {
        if (animationFinished) return;
        animationFinished = true;
        card.removeEventListener('transitionend', handleTransitionEnd);
        card.remove();
        if (normalizedTrack && state.nextTrackPreviewTrackId === normalizedTrack.identifier) {
            hideNextTrackPreview({ immediate: true });
        }
        if (trayItem) {
            trayItem.classList.remove('pending');
            requestAnimationFrame(() => trayItem.classList.add('visible'));
        }
        onComplete();
    };

    const handleTransitionEnd = (event) => {
        if (event.target !== card) return;
        finalize();
    };

    card.addEventListener('transitionend', handleTransitionEnd);

    const cardAnimationDuration = 620;
    const trayAnimationDuration = cardAnimationDuration * 3;
    let deltaX = 160;
    let deltaY = 180;
    let targetScale = 0.4;

    if (trayItem) {
        const itemRect = trayItem.getBoundingClientRect();
        const trayCenterX = itemRect.left + itemRect.width / 2 - containerRect.left;
        const trayCenterY = itemRect.top + itemRect.height / 2 - containerRect.top;
        deltaX = trayCenterX - startLeft;
        deltaY = trayCenterY - startTop;
        const scaleX = itemRect.width / cardRect.width;
        const scaleY = itemRect.height / cardRect.height;
        targetScale = Math.max(0.32, Math.min(scaleX, scaleY));
    }

    card.style.willChange = 'transform, opacity';

    const stage1Duration = Math.max(180, Math.round(trayAnimationDuration * 0.45));
    const stage2Duration = Math.max(200, trayAnimationDuration - stage1Duration);
    const intermediateX = trayItem ? deltaX * 0.35 : deltaX;
    const intermediateY = deltaY;

    requestAnimationFrame(() => {
        card.style.transition = `transform ${stage1Duration}ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity ${trayAnimationDuration}ms ease`;
        card.style.transform = `translate(-50%, -50%) translate(${intermediateX}px, ${intermediateY}px) translateZ(-820px) scale(${targetScale})`;
        card.style.opacity = '0.35';

        setTimeout(() => {
            card.style.transition = `transform ${stage2Duration}ms cubic-bezier(0.18, 0.8, 0.3, 1), opacity ${stage2Duration}ms ease-out`;
            card.style.transform = `translate(-50%, -50%) translate(${deltaX}px, ${deltaY}px) translateZ(-900px) scale(${targetScale})`;
            card.style.opacity = '0';
        }, stage1Duration + 16);
    });

    setTimeout(finalize, stage1Duration + stage2Duration + 240);
}

function enterCardsDormantState() {
    if (state.cardsDormant) {
        return;
    }

    const container = elements.dimensionCards || document.getElementById('dimensionCards');
    if (container) {
        container.classList.add('cards-dormant');
        elements.dimensionCards = container;
    }
    state.cardsDormant = true;

    const directionCards = container
        ? Array.from(container.querySelectorAll('.dimension-card:not(.next-track)'))
        : [];

    directionCards.forEach(card => {
        card.classList.remove('inactive-tilt', 'active');
        if (!card.classList.contains('dormant-exit')) {
            card.classList.add('dormant-exit');
            const removeHandler = (event) => {
                if (event.target !== card) return;
                card.classList.remove('dormant-exit', 'midpoint-tilt');
                card.removeEventListener('animationend', removeHandler);
            };
            card.addEventListener('animationend', removeHandler);
        }
    });

    const centerCard = container?.querySelector('.dimension-card.next-track');
    if (centerCard && centerCard.isConnected && !centerCard.dataset.dormantDemoted) {
        centerCard.dataset.dormantDemoted = 'true';
        demoteNextTrackCardToTray(centerCard, () => {
            delete centerCard.dataset.dormantDemoted;
        });
    }

    const nextInfo = resolveNextTrackData();
    if (nextInfo && nextInfo.track) {
        showNextTrackPreview(nextInfo.track, { directionKey: nextInfo.directionKey || nextInfo.track?.directionKey || null });
    } else {
        hideNextTrackPreview({ immediate: true });
    }
}

function exitCardsDormantState({ immediate = false } = {}) {
    if (state.cardsDormant) {
        const container = elements.dimensionCards || document.getElementById('dimensionCards');
        if (container) {
            container.classList.remove('cards-dormant');
            elements.dimensionCards = container;
        }
    }
    state.cardsDormant = false;
    hideNextTrackPreview({ immediate });
    hideBeetsSegments();
}

function sanitizeChipValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        if (Math.abs(value) >= 10) {
            return Math.round(value).toString();
        }
        return value.toFixed(2).replace(/\.00$/, '');
    }
    return String(value).trim();
}

function collectBeetsChips(meta) {
    if (!meta || typeof meta !== 'object') {
        return [];
    }

    const chips = [];
    const seen = new Set();
    const seenVals = new Set();

    const pushChip = (segmentKey, slotKey, rawValue) => {
        const segmentText = sanitizeChipValue(segmentKey) || 'segment';
        const valueText = sanitizeChipValue(rawValue);

        if (!segmentText || !valueText || valueText === '' || valueText === '0') return;

        const normalizedValue = valueText.toLowerCase().split('/').join('\n');
        if (seenVals.has(valueText)) return;
        seenVals.add(valueText);

        const normalizedSlot = sanitizeChipValue(slotKey) || '';
        if (normalizedSlot.match(/path$/i)) return;

        const id = `${segmentText.toLowerCase()}|${normalizedSlot}|${normalizedValue}`;
        if (seen.has(id)) return;
        seen.add(id);

        const chipKey = normalizedSlot ? `${segmentText}:${normalizedSlot}` : segmentText;
        chips.push({ key: chipKey, value: valueText, priority: 0 });
    };

    Object.entries(meta).forEach(([segmentKey, segmentValue]) => {
        if (!segmentValue || typeof segmentValue !== 'object' || Array.isArray(segmentValue)) {
            return;
        }

        Object.entries(segmentValue).forEach(([slotKey, rawValue]) => {
            if (rawValue === null || rawValue === undefined) return;

            if (Array.isArray(rawValue)) {
                rawValue.forEach(entry => pushChip(segmentKey, slotKey, entry));
            } else if (typeof rawValue === 'object') {
                Object.entries(rawValue).forEach(([innerKey, innerValue]) => {
                    if (innerValue === null || innerValue === undefined) return;
                    const combinedKey = innerKey ? `${slotKey}.${innerKey}` : slotKey;
                    if (Array.isArray(innerValue)) {
                        innerValue.forEach(val => pushChip(segmentKey, combinedKey, val));
                    } else {
                        pushChip(segmentKey, combinedKey, innerValue);
                    }
                });
            } else {
                pushChip(segmentKey, slotKey, rawValue);
            }
        });
    });

    return chips;
}

function renderBeetsSegments(track) {
    const container = elements.beetsSegments;
    if (!container) return;

    container.innerHTML = '';
    container.classList.remove('visible');
    container.classList.remove('hidden');

    const meta = track?.beetsMeta || track?.beets || null;
    const chips = collectBeetsChips(meta).slice(0, 21);

    if (chips.length === 0) {
        container.classList.add('hidden');
        container.dataset.hasData = 'false';
        return;
    }

    const fragment = document.createDocumentFragment();
    chips.forEach(({ key, value }) => {
        const chip = document.createElement('div');
        chip.className = 'beets-chip';
        chip.innerHTML = `
            <span class="chip-bracket">[</span>
            <span class="chip-value">${value}</span>
            <span class="chip-separator">:</span>
            <span class="chip-key">${key}</span>
            <span class="chip-bracket">]</span>
        `;
        fragment.appendChild(chip);
    });

    container.appendChild(fragment);
    container.classList.remove('hidden');
    container.dataset.hasData = 'true';
}

function hideBeetsSegments() {
    if (!elements.beetsSegments) return;
    elements.beetsSegments.classList.remove('visible');
    elements.beetsSegments.classList.add('hidden');
}

window.renderBeetsSegments = renderBeetsSegments;
window.collectBeetsChips = collectBeetsChips;

function updateNextTrackMetadata(track) {
    if (!elements.beetsSegments) {
        return;
    }

    if (!track || !track.identifier) {
        hideBeetsSegments();
        return;
    }

    const existingMeta = track.beetsMeta || track.beets;
    if (existingMeta) {
        renderBeetsSegments(track);
        return;
    }

    const cache = state.trackMetadataCache || (state.trackMetadataCache = {});
    const cachedEntry = cache[track.identifier];

    if (cachedEntry?.meta) {
        track.beetsMeta = cachedEntry.meta;
        renderBeetsSegments(track);
        return;
    }

    hideBeetsSegments();

    if (cachedEntry?.promise) {
        cachedEntry.promise.then(meta => {
            if (meta && track.identifier === cachedEntry.id) {
                track.beetsMeta = meta;
                renderBeetsSegments(track);
            }
        }).catch(() => {});
        return;
    }

    const fetchPromise = fetch(`/track/${encodeURIComponent(track.identifier)}/meta`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        })
        .then(result => {
            const meta = result?.track?.beetsMeta || result?.track?.beets || null;
            if (meta) {
                cache[track.identifier] = { id: track.identifier, meta };
                track.beetsMeta = meta;

                if (state.selectedIdentifier === track.identifier) {
                    refreshCardsWithNewSelection();
                } else {
                    renderBeetsSegments(track);
                }
            }
        })
        .catch(error => {
            console.warn('⚠️ Failed to load beets metadata:', error);
            cache[track.identifier] = { id: track.identifier, meta: null };
            hideBeetsSegments();
        });

    cache[track.identifier] = { id: track.identifier, promise: fetchPromise, meta: null };
}

window.updateNextTrackMetadata = updateNextTrackMetadata;

// ====== Inactivity Management ======
  let inactivityTimer = null;
  let lastActivityTime = Date.now();
  let cardsInactiveTilted = false; // Track if cards are already tilted from inactivity
  let midpointReached = false; // Track if we've hit the lockout threshold
  let cardsLocked = false; // Track if card interactions are locked

  function markActivity() {
      lastActivityTime = Date.now();

      const canReactivate = !midpointReached && !cardsLocked;

      if (canReactivate) {
          exitCardsDormantState();
      }

      // Only respond to activity if we're in the first half and cards aren't locked
      if (!canReactivate) {
          console.log('📱 Activity detected but cards are locked in second half');
          return;
      }

      // Clear any existing timer
      if (inactivityTimer) {
          clearTimeout(inactivityTimer);
      }

      // Immediately bring cards back to attention if they were inactive
      const directionCards = document.querySelectorAll('.dimension-card:not(.track-detail-card)');
      directionCards.forEach(card => {
          card.classList.remove('inactive-tilt');
          card.classList.add('active');
      });
      cardsInactiveTilted = false;

      // Set new timer for 10 seconds (only in first half)
      inactivityTimer = setTimeout(() => {
          // Only apply inactivity if we're still in first half
          if (!midpointReached && !cardsLocked) {
              console.log('📱 10s inactivity in first half - tilting direction cards');
              performInactivityTilt();
          }
      }, 10000); // 10 seconds
  }

  function performInactivityTilt() {
      if (cardsInactiveTilted) return; // Already tilted

      console.log('📱 Performing inactivity tilt - rotating 45° on X axis')
      const directionCards = document.querySelectorAll('.dimension-card:not(.track-detail-card)');
      directionCards.forEach(card => {
          card.classList.remove('active');
          card.classList.add('inactive-tilt');
      });
      cardsInactiveTilted = true;
  }

  // Activity detection events
  ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'].forEach(event => {
      document.addEventListener(event, markActivity, { passive: true });
  });

  // Initialize activity tracking
  markActivity();

  // ====== Progress Bar Functions ======

  function startProgressAnimation(durationSeconds) {
      startProgressAnimationFromPosition(durationSeconds, 0);
  }

  function renderProgressBar(progressFraction) {
      const clamped = Math.min(Math.max(progressFraction, 0), 1);
      const background = document.getElementById('background');

      updateMetadataFadeFromProgress(clamped);

      if (clamped <= 0.5) {
          const widthPercent = clamped * 2 * 100; // 0 → 100
          elements.progressWipe.style.left = '0%';
          elements.progressWipe.style.right = 'auto';
          elements.progressWipe.style.width = `${widthPercent}%`;

          if (background) {
              let green = Math.floor(clamped * 10);
              background.style.background = `linear-gradient(135deg, #235, #4${green}3)`;
          }
      } else {
          const phase2Progress = (clamped - 0.5) * 2; // 0 → 1
          elements.progressWipe.style.left = `${phase2Progress * 100}%`;
          elements.progressWipe.style.right = 'auto';
          elements.progressWipe.style.width = `${(1 - phase2Progress) * 100}%`;

          if (background) {
              let green = 10 - Math.floor(clamped * 10);
              background.style.background = `linear-gradient(135deg, #235, #4${green}3)`;
          }
      }
  }

  function formatTimecode(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
          return '--:--';
      }
      const wholeSeconds = Math.floor(seconds);
      const minutes = Math.floor(wholeSeconds / 60);
      const secs = wholeSeconds % 60;
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  function updatePlaybackClockDisplay(forceSeconds = null) {
      if (!elements.playbackClock) return;

      if (!state.playbackStartTimestamp || state.playbackDurationSeconds <= 0) {
          elements.playbackClock.textContent = '';
          elements.playbackClock.classList.add('is-hidden');
          return;
      }

      const elapsedSeconds = forceSeconds !== null
          ? forceSeconds
          : Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
      const clampedElapsed = Math.min(elapsedSeconds, state.playbackDurationSeconds);
      const formatted = formatTimecode(clampedElapsed);
      if (formatted === '--:--') {
          elements.playbackClock.textContent = '';
          elements.playbackClock.classList.add('is-hidden');
          return;
      }

      elements.playbackClock.textContent = formatted;
      elements.playbackClock.classList.remove('is-hidden');
  }

  function clearPlaybackClock() {
      state.playbackStartTimestamp = null;
      state.playbackDurationSeconds = 0;
      updatePlaybackClockDisplay(null);
  }

  function shouldLockInteractions(elapsedSeconds, totalDuration) {
      if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
          return false;
      }
      const remaining = Math.max(totalDuration - elapsedSeconds, 0);
      return remaining <= LOCKOUT_THRESHOLD_SECONDS;
  }

  function startProgressAnimationFromPosition(durationSeconds, startPositionSeconds = 0, options = {}) {
      const resync = !!options.resync;

      if (resync && state.playbackStartTimestamp) {
          const priorElapsed = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
          const targetElapsed = Math.max(0, startPositionSeconds);
          const priorDuration = state.playbackDurationSeconds || 0;
          const targetDuration = Number.isFinite(durationSeconds) ? durationSeconds : priorDuration;

          const elapsedDelta = Math.abs(priorElapsed - targetElapsed);
          const durationDelta = Math.abs(priorDuration - targetDuration);

          if (elapsedDelta < 1 && durationDelta < 1 && priorDuration > 0) {
              state.playbackDurationSeconds = targetDuration;
              state.playbackStartTimestamp = Date.now() - targetElapsed * 1000;
              const effectiveProgress = targetDuration > 0 ? targetElapsed / targetDuration : 0;
              renderProgressBar(effectiveProgress);
              updatePlaybackClockDisplay(targetElapsed);
              return;
          }
      }

      // Clear any existing animation
      if (state.progressAnimation) {
          clearInterval(state.progressAnimation);
      }

      if (!resync) {
          midpointReached = false;
          cardsLocked = false;
          cardsInactiveTilted = false;

          state.usingOppositeDirection = false;
          clearReversePreference();

          // Unlock cards at start of new track
          unlockCardInteractions();

          // Restart inactivity tracking for new track
          markActivity();

          // Reset visuals only when starting a fresh track
          elements.progressWipe.style.width = '0%';
          elements.progressWipe.style.left = '0%';
          elements.progressWipe.style.right = 'auto';
          elements.fullscreenProgress.classList.add('active');
      } else {
          // Ensure progress container is visible on resync, but keep current fill
          elements.fullscreenProgress.classList.add('active');
      }

      console.log(`🎬 Starting progress animation for ${durationSeconds}s from position ${startPositionSeconds}s – lockout begins with ${LOCKOUT_THRESHOLD_SECONDS}s remaining`);

      const safeDuration = Math.max(durationSeconds, 0.001);
      const clampedStartPosition = Math.min(Math.max(startPositionSeconds, 0), safeDuration);
      const initialProgress = clampedStartPosition / safeDuration;
      const remainingDuration = Math.max((safeDuration - clampedStartPosition) * 1000, 0); // ms

      state.playbackDurationSeconds = safeDuration;
      state.playbackStartTimestamp = Date.now() - clampedStartPosition * 1000;

      renderProgressBar(initialProgress);
      updatePlaybackClockDisplay(clampedStartPosition);

      const initialShouldLock = shouldLockInteractions(clampedStartPosition, safeDuration);

      if (resync) {
          if (initialShouldLock) {
              if (!midpointReached || !cardsLocked) {
                  triggerMidpointActions();
              }
              midpointReached = true;
              cardsLocked = true;
          } else {
              if (cardsLocked || midpointReached) {
                  unlockCardInteractions();
              }
              midpointReached = false;
              cardsLocked = false;
              cardsInactiveTilted = false;
          }
      } else {
          if (!midpointReached && initialShouldLock) {
              triggerMidpointActions();
              midpointReached = true;
              cardsLocked = true;
          }
      }

      if (remainingDuration <= 0) {
          renderProgressBar(1);
          updatePlaybackClockDisplay(safeDuration);
          return;
      }

      const startTime = Date.now();

      state.progressAnimation = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const elapsedProgress = Math.min(elapsed / remainingDuration, 1);
          const progress = Math.min(initialProgress + elapsedProgress * (1 - initialProgress), 1);

          renderProgressBar(progress);
          updatePlaybackClockDisplay();

          const elapsedSeconds = progress * safeDuration;
          if (!midpointReached && shouldLockInteractions(elapsedSeconds, safeDuration)) {
              triggerMidpointActions();
              midpointReached = true;
              cardsLocked = true;
          }

          if (progress >= 1) {
              clearInterval(state.progressAnimation);
              state.progressAnimation = null;
              updatePlaybackClockDisplay(safeDuration);
          }
      }, 100); // Update every 100ms for smooth animation
  }

  function stopProgressAnimation() {
      if (state.progressAnimation) {
          clearInterval(state.progressAnimation);
          state.progressAnimation = null;
      }
      elements.fullscreenProgress.classList.remove('active');
      elements.progressWipe.style.width = '0%';
      elements.progressWipe.style.left = '0%';
      elements.progressWipe.style.right = 'auto';
      midpointReached = false;
      cardsLocked = false;
      console.log('🛑 Stopped progress animation');
      clearPlaybackClock();
      applyMetadataOpacity(0);
  }

  function triggerMidpointActions() {
      console.log(`🎯 Locking in selection - ${LOCKOUT_THRESHOLD_SECONDS}s or less remaining`);

      // Clear inactivity timer - no longer needed in second half
      if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
      }

      enterCardsDormantState();

      if (typeof clearStackedPreviewLayer === 'function') {
          clearStackedPreviewLayer();
      }

      // Tilt back all non-selected direction cards (if not already tilted from inactivity)
      const directionCards = document.querySelectorAll('.dimension-card:not(.track-detail-card)');
      directionCards.forEach(card => {
          // Remove any inactivity classes and apply midpoint tilt
          card.classList.remove('inactive-tilt', 'active');
          card.classList.add('midpoint-tilt');
      });
      cardsInactiveTilted = false; // Reset since we're now using midpoint tilt

      // Hide all reverse icons when entering second swipe
      const reverseIcons = document.querySelectorAll('.uno-reverse');
      reverseIcons.forEach(icon => {
          console.log('🔄 Hiding reverse icon for second swipe');
          icon.style.opacity = '0';
          icon.style.pointerEvents = 'none';
      });

      // Lock card interactions
      lockCardInteractions();
  }

  function lockCardInteractions() {
      console.log('🔒 Locking card interactions until next track');
      cardsLocked = true;

      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
          card.classList.add('interaction-locked');
          card.style.pointerEvents = 'none';
      });
  }

  function unlockCardInteractions() {
      console.log('🔓 Unlocking card interactions for new track');
      cardsLocked = false;
      cardsInactiveTilted = false;

      exitCardsDormantState({ immediate: true });

      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
          card.classList.remove('interaction-locked', 'midpoint-tilt', 'inactive-tilt');
          card.classList.add('active');
          card.style.pointerEvents = 'auto';
      });

      // Restore reverse icons for new track (first swipe)
      const reverseIcons = document.querySelectorAll('.uno-reverse');
      reverseIcons.forEach(icon => {
          console.log('🔄 Restoring reverse icon for new track');
          icon.style.opacity = '';
          icon.style.pointerEvents = '';
      });
  }

  // ====== Session Management ======

  // Smart SSE connection with health monitoring and reconnection
  function connectSSE() {
    const fingerprint = state.streamFingerprint;
    const eventsUrl = composeEventsEndpoint(fingerprint);
    syncEventsEndpoint(fingerprint);
    state.awaitingSSE = false;

    if (fingerprint) {
      console.log(`🔌 Connecting SSE to fingerprint: ${fingerprint}`);
    } else {
      console.log('🔌 Connecting SSE (awaiting fingerprint from audio stream)');
    }

    connectionHealth.sse.status = 'connecting';
    updateConnectionHealthUI();

    // Close existing connection if any
    if (connectionHealth.currentEventSource) {
      connectionHealth.currentEventSource.close();
    }

    const eventSource = new EventSource(eventsUrl);
    connectionHealth.currentEventSource = eventSource;

    const handleSseStuck = async () => {
      if (!state.streamFingerprint) {
        console.warn('📡 SSE stuck but fingerprint not yet assigned; waiting for audio session');
        return true;
      }

      const ok = await requestSSERefresh({ escalate: false });
      return !ok;
    };

    const resetStuckTimer = () => {
      if (connectionHealth.sse.stuckTimeout) {
        clearTimeout(connectionHealth.sse.stuckTimeout);
      }
      connectionHealth.sse.stuckTimeout = setTimeout(async () => {
        const shouldReconnect = await handleSseStuck();
        if (shouldReconnect) {
          console.warn('📡 SSE stuck check: forcing reconnect');
          connectionHealth.sse.status = 'reconnecting';
          updateConnectionHealthUI();
          eventSource.close();
          connectionHealth.sse.reconnectAttempts++;
          const delay = getReconnectDelay(connectionHealth.sse.reconnectAttempts);
          setTimeout(() => connectSSE(), delay);
        } else {
          resetStuckTimer();
        }
      }, 60000);
    };

    const simpleBody = state.streamFingerprint
      ? { fingerprint: state.streamFingerprint, sessionId: state.sessionId }
      : null;

    const handleHeartbeat = (heartbeat) => {
      if (!heartbeat || !heartbeat.currentTrack) {
        console.warn('⚠️ Heartbeat missing currentTrack payload');
        return;
      }

      if (heartbeat.fingerprint && state.streamFingerprint !== heartbeat.fingerprint) {
        applyFingerprint(heartbeat.fingerprint);
      }

      const currentTrack = heartbeat.currentTrack;
      const currentTrackId = currentTrack.identifier || null;
      const previousTrackId = state.latestCurrentTrack?.identifier || null;
      const trackChanged = Boolean(currentTrackId && previousTrackId && currentTrackId !== previousTrackId);

      if (Number.isFinite(currentTrack.durationMs)) {
        state.playbackDurationSeconds = Math.max(currentTrack.durationMs / 1000, 0);
      } else if (Number.isFinite(currentTrack.duration || currentTrack.length)) {
        state.playbackDurationSeconds = currentTrack.duration || currentTrack.length || 0;
      }

      if (currentTrack.startTime) {
        state.playbackStartTimestamp = currentTrack.startTime;
      } else if (Number.isFinite(heartbeat.timing?.elapsedMs)) {
        state.playbackStartTimestamp = Date.now() - heartbeat.timing.elapsedMs;
      }

      state.latestCurrentTrack = {
        ...state.latestCurrentTrack,
        ...currentTrack,
        duration: state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || null,
        length: state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || null
      };
      window.state.latestCurrentTrack = state.latestCurrentTrack;
      state.lastTrackUpdateTs = Date.now();

      if ((trackChanged || (!previousTrackId && currentTrackId)) && currentTrackId) {
        state.pendingSnapshotTrackId = currentTrackId;
      }

      const durationSeconds = state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || 0;
      let elapsedSeconds = null;
      if (Number.isFinite(heartbeat.timing?.elapsedMs)) {
        elapsedSeconds = Math.max(heartbeat.timing.elapsedMs / 1000, 0);
      } else if (state.playbackStartTimestamp) {
        elapsedSeconds = Math.max((Date.now() - state.playbackStartTimestamp) / 1000, 0);
      }

      if (durationSeconds > 0 && elapsedSeconds != null) {
        const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
        startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: !trackChanged });
      }

      const nextTrackId = heartbeat.nextTrack?.track?.identifier || heartbeat.nextTrack?.identifier || null;
      if (nextTrackId) {
        state.serverNextTrack = nextTrackId;
        state.serverNextDirection = heartbeat.nextTrack?.direction || heartbeat.nextTrack?.directionKey || null;
        if (!state.manualNextTrackOverride) {
          state.selectedIdentifier = nextTrackId;
        }
      }

      const overrideInfo = heartbeat.override || null;
      if (overrideInfo && overrideInfo.identifier) {
        const overrideId = overrideInfo.identifier;
        if (overrideInfo.status === 'pending' || overrideInfo.status === 'prepared' || overrideInfo.status === 'locked') {
          state.manualNextTrackOverride = true;
          state.pendingManualTrackId = overrideId;
          if (!state.selectedIdentifier || state.selectedIdentifier === state.serverNextTrack) {
            state.selectedIdentifier = overrideId;
          }
        }
      }

      if (trackChanged && currentTrackId && state.manualNextTrackOverride) {
        if (state.selectedIdentifier && currentTrackId === state.selectedIdentifier) {
          console.log('🎯 Heartbeat: manual override track is now playing; clearing override after confirmation');
          state.manualNextTrackOverride = false;
          state.manualNextDirectionKey = null;
          state.pendingManualTrackId = null;
          state.selectedIdentifier = currentTrackId;
          clearReversePreference();
          updateRadiusControlsUI();
        }
      }
    };

    const handleSelectionAck = (event) => {
      const trackId = event.trackId || event.track?.identifier || null;
      if (!trackId) {
        return;
      }

      console.log('🛰️ selection_ack', event);

      state.manualNextTrackOverride = true;
      state.pendingManualTrackId = trackId;
      if (event.direction) {
        state.manualNextDirectionKey = event.direction;
      }
      state.selectedIdentifier = trackId;

      if (Number.isFinite(event.generation)) {
        state.lastSelectionGeneration = event.generation;
        setReversePreference(trackId, { generation: event.generation });
      } else if (state.reversePreference && state.reversePreference.trackId === trackId) {
        setReversePreference(trackId);
      }

      const match = findTrackInExplorer(state.latestExplorerData, trackId);
      if (match?.track) {
        updateNextTrackMetadata(match.track);
      } else {
        updateNextTrackMetadata({ identifier: trackId });
      }

      refreshCardsWithNewSelection();
    };

    const handleSelectionReady = (event) => {
      const trackId = event.trackId || null;
      console.log('🛰️ selection_ready', event);

      if (trackId) {
        const match = findTrackInExplorer(state.latestExplorerData, trackId);
        if (match?.track) {
          updateNextTrackMetadata(match.track);
        } else {
          updateNextTrackMetadata({ identifier: trackId });
        }
      }

      if (trackId && state.pendingManualTrackId === trackId) {
        state.manualNextTrackOverride = true;
      }

      if (trackId && Number.isFinite(event.generation)) {
        state.lastSelectionGeneration = event.generation;
        setReversePreference(trackId, { generation: event.generation });
      }
    };

    const handleSelectionFailed = (event) => {
      console.warn('🛰️ selection_failed', event);
      const failedTrack = event.trackId || null;

      if (!failedTrack || state.pendingManualTrackId === failedTrack) {
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        clearReversePreference();
      }

      updateNextTrackMetadata(null);
      requestSSERefresh({ escalate: false });
    };

    const handleExplorerSnapshot = (snapshot) => {
      if (!snapshot) {
        return;
      }

      if (snapshot.fingerprint && state.streamFingerprint !== snapshot.fingerprint) {
        applyFingerprint(snapshot.fingerprint);
      }

      const previousTrackId = state.latestCurrentTrack?.identifier || null;
      const currentTrackId = snapshot.currentTrack?.identifier || previousTrackId;
      const trackChanged = Boolean(state.pendingSnapshotTrackId && currentTrackId && state.pendingSnapshotTrackId === currentTrackId);

      if (snapshot.currentTrack) {
        state.latestCurrentTrack = snapshot.currentTrack;
        window.state.latestCurrentTrack = snapshot.currentTrack;
        state.lastTrackUpdateTs = Date.now();
      }

      if (trackChanged && currentTrackId) {
        state.pendingSnapshotTrackId = null;
      }

      if (trackChanged) {
          exitCardsDormantState({ immediate: true });
          hideNextTrackPreview({ immediate: false });
      } else if (state.cardsDormant) {
          const info = resolveNextTrackData();
          if (info?.track) {
              showNextTrackPreview(info.track, { directionKey: info.directionKey || info.track?.directionKey || null });
          }
      }

      const rawResolution = snapshot.explorer?.resolution;
      const previousResolution = state.currentResolution;
      const normalizedResolution = normalizeResolution(rawResolution);
      const resolutionChanged = Boolean(normalizedResolution && normalizedResolution !== previousResolution);
      if (resolutionChanged) {
        state.currentResolution = normalizedResolution;
        updateRadiusControlsUI();
      }

      const inferredTrack = snapshot.explorer?.nextTrack?.track?.identifier
        || snapshot.explorer?.nextTrack?.identifier
        || snapshot.nextTrack?.track?.identifier
        || snapshot.nextTrack?.identifier
        || null;

      if (inferredTrack) {
        state.serverNextTrack = inferredTrack;
        state.serverNextDirection = snapshot.explorer?.nextTrack?.direction || snapshot.nextTrack?.direction || null;
      }

      const manualSelectionId = state.manualNextTrackOverride ? state.selectedIdentifier : null;
      if (trackChanged && state.manualNextTrackOverride && manualSelectionId && currentTrackId && currentTrackId !== manualSelectionId) {
        console.warn('🛰️ ACTION override-diverged', {
          manualSelection: manualSelectionId,
          playing: currentTrackId,
          manualDirection: state.manualNextDirectionKey,
          serverSuggestedNext: inferredTrack || null
        });
        scheduleHeartbeat(10000);
      }
      if (trackChanged) {
        if (state.manualNextTrackOverride) {
          const selectionVisible = manualSelectionId && snapshot.explorer && explorerContainsTrack(snapshot.explorer, manualSelectionId);
          if (!selectionVisible || manualSelectionId !== currentTrackId) {
            console.log('🛰️ ACTION override-cleared', {
              previousSelection: manualSelectionId,
              playing: currentTrackId
            });
            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            state.pendingManualTrackId = null;
            state.selectedIdentifier = currentTrackId;
            updateRadiusControlsUI();
          }
        } else if (currentTrackId) {
          state.selectedIdentifier = currentTrackId;
          updateRadiusControlsUI();
        }
      } else if (inferredTrack) {
        state.selectedIdentifier = inferredTrack;
        updateRadiusControlsUI();
      }
      if (!trackChanged) {
        if (resolutionChanged) {
          state.manualNextTrackOverride = false;
          state.manualNextDirectionKey = null;
          state.pendingManualTrackId = null;
          if (inferredTrack) {
            state.selectedIdentifier = inferredTrack;
          }
          updateRadiusControlsUI();
        } else if (!state.manualNextTrackOverride && inferredTrack) {
          state.selectedIdentifier = inferredTrack;
        }
      }

      if (state.manualNextTrackOverride && currentTrackId && state.pendingManualTrackId && currentTrackId === state.pendingManualTrackId) {
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = currentTrackId;
        updateRadiusControlsUI();
      }

      if (snapshot.explorer) {
        snapshot.explorer.currentTrack = snapshot.currentTrack || snapshot.explorer.currentTrack || null;
        state.latestExplorerData = snapshot.explorer;
        state.remainingCounts = {};
        createDimensionCards(snapshot.explorer);
      }

      if ((trackChanged || !previousTrackId) && (connectionHealth.audio.status === 'error' || connectionHealth.audio.status === 'failed')) {
        console.log('🔄 Explorer snapshot received but audio unhealthy; restarting session');
        handleDeadAudioSession();
        return;
      }

      if (snapshot.currentTrack) {
        console.log(`🎵 ${snapshot.currentTrack.title} by ${snapshot.currentTrack.artist}`);
        if (snapshot.driftState) {
          console.log(`🎯 Direction: ${snapshot.driftState.currentDirection}, Step: ${snapshot.driftState.stepCount}`);
        }
        updateNowPlayingCard(snapshot.currentTrack, snapshot.driftState);
      }

      const durationSeconds = snapshot.currentTrack?.duration || snapshot.currentTrack?.length || state.playbackDurationSeconds || 0;
      const startTimeMs = snapshot.currentTrack?.startTime || state.playbackStartTimestamp || null;
      if (durationSeconds > 0 && startTimeMs) {
        const elapsedSeconds = Math.max((Date.now() - startTimeMs) / 1000, 0);
        const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
        startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: !trackChanged });
      }
    };

    if (simpleBody) {
      fetch('/refresh-sse-simple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simpleBody)
      }).catch(() => {});
    }

    eventSource.onopen = () => {
      console.log('📡 SSE connected');
      connectionHealth.sse.status = 'connected';
      connectionHealth.sse.reconnectAttempts = 0;
      connectionHealth.sse.reconnectDelay = 2000;
      connectionHealth.sse.lastMessage = Date.now();
      updateConnectionHealthUI();

      resetStuckTimer();
    };

    eventSource.onmessage = (event) => {
      connectionHealth.sse.lastMessage = Date.now();
      resetStuckTimer();

      state.lastSSEMessageTime = Date.now();  // Update in SSE onmessage
      try {
        const raw = JSON.parse(event.data);

        // Normalize explorer sample tracks early (wrap { track } -> track)
        if (raw.explorer && raw.explorer.directions) {
          for (const directionKey of Object.keys(raw.explorer.directions)) {
            const direction = raw.explorer.directions[directionKey];
            if (Array.isArray(direction.sampleTracks)) {
              direction.sampleTracks = direction.sampleTracks.map(entry => entry.track || entry);
            }
            if (direction.oppositeDirection && Array.isArray(direction.oppositeDirection.sampleTracks)) {
              direction.oppositeDirection.sampleTracks = direction.oppositeDirection.sampleTracks.map(entry => entry.track || entry);
            }
          }
        }

       const data = raw;
       console.log('📡 Event:', data.type, data);

        if (data.type === 'error') {
          console.error('📡 SSE reported error payload:', data.message);
          if (audioHealth.isHealthy) {
            eventSource.close();
            if (data.message === 'fingerprint_not_found') {
              console.log('🔄 SSE fingerprint missing; requesting refresh');
              requestSSERefresh({ escalate: false })
                .then((ok) => {
                  if (ok) {
                    connectSSE();
                  } else {
                    console.warn('⚠️ Fingerprint refresh failed; bootstrapping new stream');
                    createNewJourneySession('fingerprint_not_found');
                  }
                })
                .catch((err) => {
                  console.error('❌ Fingerprint refresh request failed:', err);
                  connectionHealth.sse.reconnectAttempts++;
                  const delay = getReconnectDelay(connectionHealth.sse.reconnectAttempts);
                  setTimeout(() => connectSSE(), delay);
                });
            } else {
              console.log('🔄 SSE error payload received while audio healthy; reconnecting SSE');
              connectionHealth.sse.reconnectAttempts++;
              const delay = getReconnectDelay(connectionHealth.sse.reconnectAttempts);
              setTimeout(() => connectSSE(), delay);
            }
          } else {
            console.log('🔄 SSE error payload and audio unhealthy; restarting session');
            eventSource.close();
            handleDeadAudioSession();
          }
          return;
        }

        if (data.type === 'connected') {
          const previousSession = state.sessionId;
          if (data.sessionId) {
            state.sessionId = data.sessionId;
            if (previousSession && previousSession !== data.sessionId) {
              console.warn(`🆔 SSE reported session change ${previousSession} → ${data.sessionId}`);
            } else if (!previousSession) {
              console.log(`🆔 SSE assigned session: ${state.sessionId}`);
            }
          }

          if (data.fingerprint) {
            applyFingerprint(data.fingerprint);
          }
        }

        // Ignore events from other sessions (legacy safety)
        if (state.sessionId && data.session && data.session.sessionId && data.session.sessionId !== state.sessionId) {
          console.log(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${state.sessionId})`);
          return;
        }

        if (state.streamFingerprint && data.fingerprint && data.fingerprint !== state.streamFingerprint) {
          console.log(`🔄 Updating fingerprint from ${state.streamFingerprint} → ${data.fingerprint}`);
          applyFingerprint(data.fingerprint);
        }

       if (data.type === 'heartbeat') {
          handleHeartbeat(data);
          return;
        }

        if (data.type === 'explorer_snapshot') {
          handleExplorerSnapshot(data);
          return;
        }

        if (data.type === 'selection_ack') {
          handleSelectionAck(data);
          return;
        }

        if (data.type === 'selection_ready') {
          handleSelectionReady(data);
          return;
        }

        if (data.type === 'selection_failed') {
          handleSelectionFailed(data);
          return;
        }

        if (data.type === 'flow_options') {
          console.log('🌟 Flow options available:', Object.keys(data.flowOptions));
        }

        if (data.type === 'direction_change') {
          console.log(`🔄 Flow changed to: ${data.direction}`);
        }

      } catch (e) {
        console.log('📡 Raw event:', event.data);
      }
    };

    eventSource.onerror = (error) => {
      console.error('❌ SSE error:', error);
      connectionHealth.sse.status = 'reconnecting';
      updateConnectionHealthUI();

      if (audioHealth.handlingRestart) {
        eventSource.close();
        return;
      }

      if (audioHealth.isHealthy) {
        console.log('🔄 SSE died but audio healthy - reconnecting SSE to same session');
        eventSource.close();
        connectionHealth.sse.reconnectAttempts++;
        const delay = getReconnectDelay(connectionHealth.sse.reconnectAttempts);
        setTimeout(() => connectSSE(), delay);
      } else {
        console.log('🔄 SSE died and audio unhealthy - full restart needed');
        eventSource.close();
        handleDeadAudioSession();
      }
    };
  }

  console.log('🚢 Awaiting audio start to establish session.');


  // Swap stack contents between current and opposite direction
  function swapStackContents(currentDimensionKey, oppositeDimensionKey) {
      console.log(`🔄 swapStackContents called with ${currentDimensionKey} → ${oppositeDimensionKey}`);

      const previousOppositeState = state.usingOppositeDirection;
      // Toggle the simple opposite direction flag
      state.usingOppositeDirection = !state.usingOppositeDirection;
      console.log(`🔄 Toggled reverse mode: now using opposite direction = ${state.usingOppositeDirection}`);

      // Reset track index when flipping to opposite direction
      state.stackIndex = 0;
      console.log(`🔄 Reset track index to 0 for opposite direction`);

      // Determine base/opposite keys from state and current card metadata
      const centerCard = document.querySelector('.dimension-card.next-track');
      const storedBaseKey = centerCard?.dataset?.baseDirectionKey || null;
      const storedOppositeKey = centerCard?.dataset?.oppositeDirectionKey || null;

      const baseKey = state.baseDirectionKey || storedBaseKey || currentDimensionKey;
      const oppositeHint = storedOppositeKey
          || oppositeDimensionKey
          || state.currentOppositeDirectionKey
          || getOppositeDirection(baseKey);

      console.log(`🔄 About to call redrawNextTrackStack with baseDirectionKey: ${baseKey}, oppositeHint: ${oppositeHint}`);
      const preferredTrackId = state.selectedIdentifier || state.pendingManualTrackId || state.serverNextTrack || null;
      setReversePreference(preferredTrackId, {
          generation: state.lastSelectionGeneration,
          usingOpposite: state.usingOppositeDirection
      });
      const redrawOk = redrawNextTrackStack(baseKey, { oppositeKey: oppositeHint });
      if (!redrawOk) {
          state.usingOppositeDirection = previousOppositeState;
          console.warn('🔄 Redraw failed; restored previous reverse state');
      } else {
          console.log(`🔄 Finished calling redrawNextTrackStack`);
      }
  }

  window.swapStackContents = swapStackContents;

  // Redraw the next track stack respecting the reverse flag
  function redrawNextTrackStack(specifiedDimensionKey = null, options = {}) {
      if (!state.latestExplorerData?.nextTrack) return false;

      const forcedOppositeKey = options?.oppositeKey || null;

      const baseDimensionKey = specifiedDimensionKey
          || state.baseDirectionKey
          || state.latestExplorerData.nextTrack.directionKey;
      state.baseDirectionKey = baseDimensionKey;
      let baseDirection = state.latestExplorerData.directions[baseDimensionKey];

      const embeddedOppositeKey = baseDirection?.oppositeDirection?.key
          || baseDirection?.oppositeDirection?.direction
          || null;
      let resolvedOppositeKey = forcedOppositeKey
          || state.currentOppositeDirectionKey
          || embeddedOppositeKey
          || getOppositeDirection(baseDimensionKey)
          || null;

      const normalizeSampleEntries = (samples) => {
          if (!Array.isArray(samples)) return [];
          return samples
              .map(sample => (sample && typeof sample === 'object' && 'track' in sample) ? sample.track : sample)
              .filter(track => track && track.identifier);
      };

      const wrapTracksAsSamples = (tracks) => {
          return tracks
              .map(track => {
                  const base = track && typeof track === 'object' ? { ...track } : null;
                  if (!base) return null;
                  return { track: base };
              })
              .filter(Boolean);
      };

      let displayDimensionKey;
      let displayDirection;

      if (state.usingOppositeDirection) {
          displayDimensionKey = resolvedOppositeKey;
          displayDirection = displayDimensionKey ? state.latestExplorerData.directions[displayDimensionKey] : null;

          console.log(`🔄 Current direction data:`, baseDirection);
          console.log(`🔄 Has oppositeDirection:`, !!baseDirection?.oppositeDirection);
          console.log(`🔄 Opposite key target:`, displayDimensionKey);
          console.log(`🔄 Opposite exists in directions:`, !!displayDirection);

          if (baseDirection?.oppositeDirection) {
              displayDirection = baseDirection.oppositeDirection;
              displayDirection.hasOpposite = true;
              displayDimensionKey = baseDirection.oppositeDirection.key
                  || baseDirection.oppositeDirection.direction
                  || displayDimensionKey
                  || resolvedOppositeKey
                  || getOppositeDirection(baseDimensionKey);
              console.log(`🔄 Using embedded opposite direction data: ${displayDimensionKey}`);
          } else if (!displayDirection) {
              const searchKey = displayDimensionKey || resolvedOppositeKey || getOppositeDirection(baseDimensionKey);
              console.warn(`🔄 Opposite direction ${searchKey} missing in top-level list; searching embedded data`);

              for (const [dirKey, dirData] of Object.entries(state.latestExplorerData.directions)) {
                  if (dirData.oppositeDirection?.key === searchKey || dirData.oppositeDirection?.direction === searchKey) {
                      displayDirection = dirData.oppositeDirection;
                      displayDimensionKey = searchKey;
                      console.log(`🔄 Found embedded opposite direction ${searchKey} inside ${dirKey}.oppositeDirection`);
                      break;
                  }
              }

              if (!displayDirection) {
                  const syntheticKey = displayDimensionKey || resolvedOppositeKey || getOppositeDirection(baseDimensionKey);
                  const baseOppositeTracks = normalizeSampleEntries(baseDirection?.oppositeDirection?.sampleTracks);
                  const fallbackBaseTracks = baseOppositeTracks.length ? baseOppositeTracks : normalizeSampleEntries(baseDirection?.sampleTracks);

                  if (syntheticKey && fallbackBaseTracks.length) {
                      console.warn(`🔄 No opposite direction data available for ${baseDimensionKey}; synthesizing ${syntheticKey}`);

                      const syntheticSamples = wrapTracksAsSamples(fallbackBaseTracks);
                      const polarity = baseDirection?.polarity === 'positive'
                          ? 'negative'
                          : baseDirection?.polarity === 'negative'
                              ? 'positive'
                              : 'negative';

                      const syntheticDirection = {
                          ...baseDirection,
                          key: syntheticKey,
                          direction: baseDirection?.direction || syntheticKey,
                          sampleTracks: syntheticSamples,
                          trackCount: syntheticSamples.length,
                          hasOpposite: true,
                          polarity
                      };

                      syntheticDirection.oppositeDirection = {
                          key: baseDimensionKey,
                          sampleTracks: wrapTracksAsSamples(normalizeSampleEntries(baseDirection?.sampleTracks))
                      };

                      state.latestExplorerData.directions[syntheticKey] = syntheticDirection;
                      state.latestExplorerData.directions[baseDimensionKey] = {
                          ...state.latestExplorerData.directions[baseDimensionKey],
                          hasOpposite: true,
                          oppositeDirection: syntheticDirection.oppositeDirection
                      };

                      baseDirection = state.latestExplorerData.directions[baseDimensionKey];
                      displayDirection = state.latestExplorerData.directions[syntheticKey];

                      displayDimensionKey = syntheticKey;
                      resolvedOppositeKey = syntheticKey;
                      state.skipNextExitAnimation = true;
                  } else {
                      console.error(`🔄 No opposite direction data available for ${baseDimensionKey}`);
                      return false;
                  }
              }
          }

          resolvedOppositeKey = displayDimensionKey;
      } else {
          displayDimensionKey = baseDimensionKey;
          displayDirection = state.latestExplorerData.directions[baseDimensionKey];

          if (!displayDirection) {
              for (const [dirKey, dirData] of Object.entries(state.latestExplorerData.directions)) {
                  if (dirData.oppositeDirection?.key === baseDimensionKey) {
                      displayDirection = dirData.oppositeDirection;
                      displayDimensionKey = baseDimensionKey;
                      console.log(`🔄 Found embedded direction data for ${baseDimensionKey} in ${dirKey}.oppositeDirection`);
                      if (!resolvedOppositeKey) {
                          resolvedOppositeKey = dirKey;
                      }
                      break;
                  }
              }
          }

          if (!displayDirection) {
              console.error(`🔄 No direction data found for ${baseDimensionKey}`);
              return false;
          }

          resolvedOppositeKey = resolvedOppositeKey
              || embeddedOppositeKey
              || getOppositeDirection(baseDimensionKey)
              || null;
      }

      if (!displayDirection) {
          console.error(`🔄 Could not resolve direction data for ${state.usingOppositeDirection ? 'opposite' : 'base'} stack`, {
              baseDimensionKey,
              resolvedOppositeKey,
              available: Object.keys(state.latestExplorerData.directions || {})
          });
          return false;
      }

      state.currentOppositeDirectionKey = resolvedOppositeKey;

      console.log(`🔄 Redrawing next track stack: base=${baseDimensionKey}, display=${displayDimensionKey}, reversed=${state.usingOppositeDirection}`);
      console.log(`🔄 Direction sample tracks count:`, displayDirection?.sampleTracks?.length || 0);
      console.log(`🔄 First track in direction:`, displayDirection?.sampleTracks?.[0]?.title || 'None');

      const currentCard = document.querySelector('.dimension-card.next-track');
      if (!currentCard) {
          console.error('🔄 Could not find current next-track card');
          return false;
      }

      currentCard.dataset.baseDirectionKey = baseDimensionKey;
      if (resolvedOppositeKey) {
          currentCard.dataset.oppositeDirectionKey = resolvedOppositeKey;
      } else {
          delete currentCard.dataset.oppositeDirectionKey;
      }

      let displayTracks = normalizeSampleEntries(displayDirection.sampleTracks);

      if (!displayTracks.length && resolvedOppositeKey) {
          const topLevelOpposite = state.latestExplorerData.directions?.[resolvedOppositeKey];
          const topLevelTracks = normalizeSampleEntries(topLevelOpposite?.sampleTracks);
          if (topLevelTracks.length) {
              displayTracks = topLevelTracks;
              displayDirection.sampleTracks = [...topLevelTracks];
          }
      }

      if (!displayTracks.length && baseDirection?.oppositeDirection) {
          const embeddedTracks = normalizeSampleEntries(baseDirection.oppositeDirection.sampleTracks);
          if (embeddedTracks.length) {
              displayTracks = embeddedTracks;
              displayDirection.sampleTracks = [...embeddedTracks];
          }
      }

      if (!displayTracks.length) {
          const fallbackTrack = state.latestExplorerData?.nextTrack?.track
              || state.latestExplorerData?.nextTrack
              || state.previousNextTrack
              || null;
          const normalizedFallback = fallbackTrack && fallbackTrack.track ? fallbackTrack.track : fallbackTrack;
          if (normalizedFallback) {
              displayTracks = [normalizedFallback];
              displayDirection.sampleTracks = [normalizedFallback];
          }
      }

      if (!displayTracks.length) {
          console.error(`🔄 No tracks found for direction ${displayDimensionKey}`);
          return false;
      }

      if (displayDimensionKey) {
          const existingEntry = state.latestExplorerData.directions?.[displayDimensionKey];
          if (!existingEntry) {
              state.latestExplorerData.directions[displayDimensionKey] = {
                  ...displayDirection,
                  key: displayDimensionKey,
                  sampleTracks: Array.isArray(displayDirection.sampleTracks)
                      ? [...displayDirection.sampleTracks]
                      : [...displayTracks]
              };
          } else if (!Array.isArray(existingEntry.sampleTracks) || !existingEntry.sampleTracks.length) {
              existingEntry.sampleTracks = Array.isArray(displayDirection.sampleTracks)
                  ? [...displayDirection.sampleTracks]
                  : [...displayTracks];
          }
      }

      const trackToShow = displayTracks[0];
      const trackForCard = trackToShow?.track ? trackToShow.track : trackToShow;
      const nextTrackRecord = trackForCard ? { ...trackForCard } : null;

      console.log(`🔄 TRACK SELECTION DEBUG:`, {
          usingOppositeDirection: state.usingOppositeDirection,
          baseDimensionKey,
          displayDimensionKey,
          displayTracksCount: displayTracks.length,
          selectedTrack: trackToShow.title,
          selectedTrackId: trackToShow.identifier
      });

      state.stackIndex = 0;
      state.selectedIdentifier = trackForCard?.identifier || null;
      if (state.selectedIdentifier) {
          setReversePreference(state.selectedIdentifier, { generation: state.lastSelectionGeneration, usingOpposite: state.usingOppositeDirection });
      }
      console.log(`🔄 Updated selection to first track of ${state.usingOppositeDirection ? 'OPPOSITE' : 'ORIGINAL'} stack (${displayDimensionKey}): ${trackForCard?.title || trackToShow?.title} (${state.selectedIdentifier})`);

      if (!state.latestExplorerData) {
          state.latestExplorerData = {};
      }
      state.latestExplorerData.nextTrack = {
          directionKey: displayDimensionKey,
          direction: displayDirection?.direction || displayDimensionKey,
          track: nextTrackRecord
      };

      if (trackForCard?.identifier) {
          sendNextTrack(trackForCard.identifier, displayDimensionKey, 'user');
      }

      delete currentCard.dataset.originalBorderColor;
      delete currentCard.dataset.originalGlowColor;
      delete currentCard.dataset.borderColor;
      delete currentCard.dataset.glowColor;
      console.log(`🔄 Cleared ALL stored colors for direction switch to ${displayDimensionKey}`);

      displayDirection.key = displayDimensionKey;
      console.log(`🔄 Updated displayDirection.key to ${displayDimensionKey} for color calculation`);

      currentCard.dataset.directionKey = displayDimensionKey;
      console.log(`🔄 Updated card data-direction-key to ${displayDimensionKey} to match displayed direction`);

      if (state.usingOppositeDirection) {
          currentCard.dataset.oppositeDirectionKey = displayDimensionKey;
      }

      currentCard.style.removeProperty('--border-color');
      currentCard.style.removeProperty('--glow-color');
      currentCard.dataset.directionType = getDirectionType(displayDimensionKey);

      updateCardWithTrackDetails(currentCard, trackToShow, displayDirection, false, swapStackContents);
      return true;
  }

  // Animate a direction card from its clock position to center (becoming next track stack)
  function animateDirectionToCenter(directionKey) {
      console.log(`🎬 animateDirectionToCenter called for: ${directionKey}`);

      if (!directionKey) {
          const fallbackInfo = resolveNextTrackData();
          const nextTrackPayload = state.latestExplorerData?.nextTrack || null;
          const candidateTrack = fallbackInfo?.track
              || nextTrackPayload?.track
              || nextTrackPayload
              || (state.selectedIdentifier ? { identifier: state.selectedIdentifier } : null);

          const inferredKey = fallbackInfo?.directionKey
              || nextTrackPayload?.directionKey
              || (candidateTrack?.identifier ? findDirectionKeyContainingTrack(state.latestExplorerData, candidateTrack.identifier) : null);

          if (inferredKey) {
              console.warn(`🎬 animateDirectionToCenter received null key; inferred ${inferredKey}`);
              directionKey = inferredKey;
          } else {
              console.warn('🎬 animateDirectionToCenter could not determine direction key; deferring animation');
              if (!state.__pendingCenterRetry) {
                  state.__pendingCenterRetry = true;
                  setTimeout(() => {
                      state.__pendingCenterRetry = false;
                      const retryKey = state.latestExplorerData?.nextTrack?.directionKey
                          || (state.selectedIdentifier ? findDirectionKeyContainingTrack(state.latestExplorerData, state.selectedIdentifier) : null);
                      if (retryKey) {
                          animateDirectionToCenter(retryKey);
                      }
                  }, 120);
              }
              return;
          }
      }

      // Reset track index for the new dimension
      state.stackIndex = 0;
      let card = document.querySelector(`[data-direction-key="${directionKey}"]`);
      if (!card) {
          console.error(`🎬 Could not find card for direction: ${directionKey}`);
          console.error(`🎬 Available cards:`, Array.from(document.querySelectorAll('[data-direction-key]')).map(c => c.dataset.directionKey));

          // FALLBACK: Try to find the opposite direction if this direction doesn't exist
          const oppositeKey = getOppositeDirection(directionKey);
          console.log(`🎬 Trying fallback to opposite direction: ${oppositeKey}`);

          let fallbackCard = null;
          if (oppositeKey) {
              fallbackCard = document.querySelector(`[data-direction-key="${oppositeKey}"]`);
              if (!fallbackCard) {
                  const candidates = Array.from(document.querySelectorAll('[data-direction-key]'));
                  fallbackCard = candidates.find(node => node.dataset.directionKey === oppositeKey) || null;
              }
          }

          if (fallbackCard) {
              console.log(`🎬 Found fallback card for ${oppositeKey}, using it instead`);
              return animateDirectionToCenter(oppositeKey);
          }

          // As a last resort, create a temporary card in the center
          const container = elements.dimensionCards || document.getElementById('dimensionCards');
          if (container) {
              console.warn(`🎬 Creating temporary next track card for ${directionKey}`);
              card = document.createElement('div');
              card.className = 'dimension-card next-track track-detail-card visible';
              card.dataset.directionKey = directionKey;
              card.style.left = '50%';
              card.style.top = '45%';
              card.style.transform = 'translate(-50%, -40%) translateZ(-400px) scale(1.0)';
              card.style.zIndex = '120';
              container.appendChild(card);
              convertToNextTrackStack(directionKey);
              return;
          }

          // If no fallback works, just return without animation
          console.error(`🎬 No fallback card found either, skipping animation`);
          return;
      }

      console.log(`🎬 Found card element, animating ${directionKey} from clock position to center`);

      // Transform this direction card into a next-track stack
      card.classList.add('next-track', 'track-detail-card', 'animating-to-center');
      if (!card.dataset.originalDirectionKey) {
          card.dataset.originalDirectionKey = directionKey;
      }
      if (typeof clearStackedPreviewLayer === 'function') {
          clearStackedPreviewLayer();
      }

      if (typeof hideStackSizeIndicator === 'function') {
          hideStackSizeIndicator(card);
      }

      // Animate to center position
      card.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
      card.style.left = '50%';
      card.style.top = '45%';
      card.style.transform = 'translate(-50%, -40%) translateZ(-400px) scale(1.0)';
      card.style.zIndex = '100';

      // After animation completes, create stack indicators and update content
      setTimeout(() => {
          console.log(`🎬 Animation complete for ${directionKey}, converting to next track stack...`);
          convertToNextTrackStack(directionKey);
          card.classList.remove('animating-to-center');
          card.style.transition = ''; // Remove transition for normal interactions
      }, 800);
  }


  function createDirectionCard(direction, index, total, isNextTrack, nextTrackData, hasReverse = false, counterpart = null, directions) {
      console.log(`🕐 Card ${direction.key} (index ${index}): clockPosition=TBD`);
      const card = document.createElement('div');
      let cardClasses = 'dimension-card';

      // Add next-track class for larger sizing
      if (isNextTrack) {
          cardClasses += ' next-track';
      }

      // Add stacking classes based on sample count
      const directionTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];

      const sampleCount = directionTracks.length;
      if (sampleCount > 1) {
          cardClasses += ' stacked';
      }
      if (sampleCount >= 3) {
          cardClasses += ' heavily-stacked';
      }

      // Add negative-direction class for inverted rim
      if (isNegativeDirection(direction.key)) {
          cardClasses += ' negative-direction';
      }

      // Add outlier class for special styling
      if (direction.isOutlier) {
          cardClasses += ' outlier';
      }

      card.className = cardClasses;
      card.dataset.directionKey = direction.key;

      // Calculate clock-based position - simple sequential assignment
      // Use the creation index directly to assign positions around the clock
      let clockPosition;
      if (direction.isOutlier) {
          // Outliers go to 11 o'clock
          clockPosition = 11;
      } else {
          // Even distribution around clock face (skip 12 for outliers)
          const totalRegularCards = directions.filter(d => !d.isOutlier).length;
          const availablePositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]; // Skip 11 for outliers
          const regularCardIndex = directions.filter((d, i) => i <= index && !d.isOutlier).length - 1;

          if (totalRegularCards <= availablePositions.length) {
              // Evenly distribute cards around the clock
              const step = availablePositions.length / totalRegularCards;
              const positionIndex = Math.round(regularCardIndex * step) % availablePositions.length;
              clockPosition = availablePositions[positionIndex];
          } else {
              // Fallback if somehow we have too many cards
              clockPosition = availablePositions[regularCardIndex % availablePositions.length];
          }
      }
      console.log(`🕐 Card ${direction.key} (index ${index}): clockPosition=${clockPosition}`);

      // Store position for animation return
      card.dataset.clockPosition = clockPosition;
      card.dataset.originalClockPosition = clockPosition; // Remember original position

      // Get direction type and assign colors
      const directionType = getDirectionType(direction.key);
      console.log(`🎨 INITIAL COLOR DEBUG for ${direction.key}: directionType=${directionType}, isNegative=${direction.key.includes('_negative')}`);
      const colors = getDirectionColor(directionType, direction.key);
      const colorVariant = variantFromDirectionType(directionType);
      console.log(`🎨 INITIAL COLOR RESULT for ${direction.key}:`, colors);
      console.log(`🎨 Card ${direction.key}: type=${directionType}, colors=`, colors);

      // Store direction type and colors for consistent coloring
      card.dataset.directionType = directionType;
      card.dataset.borderColor = colors.border;
      card.style.setProperty('--card-border-color', colors.border);
      card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      card.dataset.glowColor = colors.glow;
      card.style.setProperty('--card-border-color', colors.border);
      card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      // Convert clock position to angle (12 o'clock = -90°, proceed clockwise)
      const angle = ((clockPosition - 1) / 12) * Math.PI * 2 - Math.PI / 2;
      const radiusX = 38; // Horizontal radius for clock layout
      const radiusY = 42; // Vertical radius for clock layout
      const centerX = 50; // Center horizontally for clock layout
      const centerY = 50; // Vertical center
      const x = centerX + radiusX * Math.cos(angle);
      const y = centerY + radiusY * Math.sin(angle);

      // Position cards on right side
      card.style.left = `${x}%`;
      card.style.top = `${y}%`;

      // Standard scaling and z-positioning - smaller direction cards
      const scale = isNextTrack ? 1.0 : 0.5;
      const zPosition = isNextTrack ? -400 : -800;
      const zIndex = isNextTrack ? 100 : 20;
      const offset = isNextTrack ? 40 : 50;
      card.style.transform = `translate(-50%, -${offset}%) translateZ(${zPosition}px) scale(${scale})`;
      card.style.zIndex = zIndex;
      card.style.position = 'absolute';

      let labelContent = '';
      if (isNextTrack && nextTrackData && nextTrackData.track) {
          // Full track details for next track
          console.log(`🐞 NEXT TRACK CARD: Using full track metadata for ${direction.key}`);
          const track = nextTrackData.track;
          const duration = (track.duration || track.length) ?
              `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
              '??:??';

          const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);
          labelContent = `
              <h2>${directionName}</h2>
              <h3>${getDisplayTitle(track)}</h3>
              <h4>${track.artist || 'Unknown Artist'}</h4>
              <h5>${track.album || ''}</h5>
              <p>${duration} · FLAC</p>
          `;
      } else {
          // Check if this is an outlier direction - use "Outlier" label instead of direction name
          console.log(`🐞 REGULAR CARD: Using direction name only for ${direction.key}`);
          const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);
          labelContent = `<div class="dimension-label">${directionName}</div>`;
          console.log(`🐞 REGULAR CARD labelContent: ${labelContent}`);
      }

      let unoReverseHtml = '';
      if (hasReverse) {
          const reverseColor = typeof resolveOppositeBorderColor === 'function'
              ? resolveOppositeBorderColor(direction, colors.border)
              : colors.border;
          card.dataset.oppositeBorderColor = reverseColor;

          if (typeof renderReverseIcon === 'function') {
              const isNegative = isNegativeDirection(direction.key);
              const topColor = isNegative ? (reverseColor || colors.border) : colors.border;
              const bottomColor = isNegative ? colors.border : (reverseColor || colors.border);
              const highlight = isNextTrack ? (isNegative ? 'top' : 'bottom') : null;
              if (isNextTrack) {
                  unoReverseHtml = renderReverseIcon({ interactive: true, topColor, bottomColor, highlight, extraClasses: 'enabled' });
              } else {
                  unoReverseHtml = renderReverseIcon({ interactive: false, topColor, bottomColor, highlight, extraClasses: 'has-opposite' });
              }
          }

          console.log(`🔄 Generated reverse HTML for ${direction.key}:`, unoReverseHtml);
      } else {
          delete card.dataset.oppositeBorderColor;
      }

      if (directionTracks.length === 0 && nextTrackData?.track) {
          directionTracks.push({ track: nextTrackData.track });
      }

      if (directionTracks.length === 0 && state.previousNextTrack) {
          directionTracks.push({ track: state.previousNextTrack });
      }

      if (directionTracks.length === 0) {
          console.error(`🔄 No sample tracks available for ${direction.key}, creating stub track`);
          directionTracks.push({
              track: {
                  identifier: nextTrackData?.track?.identifier || `stub_${direction.key}_${Date.now()}`,
                  title: nextTrackData?.track?.title || 'Upcoming Selection',
                  artist: nextTrackData?.track?.artist || '',
                  album: nextTrackData?.track?.album || '',
                  duration: nextTrackData?.track?.duration || null,
                  albumCover: nextTrackData?.track?.albumCover || state.latestCurrentTrack?.albumCover || ''
              }
          });
      }

      const primarySample = directionTracks[0];
      const selectedTrack = primarySample.track || primarySample;
      const coverArt = selectedTrack?.albumCover || primarySample?.albumCover || '';

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(coverArt)}"></div>
              <span class="rim"></span>
              <div class="label">
                  ${labelContent}
              </div>
              ${unoReverseHtml}
          </div>
      `;

      // Set CSS custom properties for border and glow colors AFTER innerHTML
      console.log(`🎨 Setting colors for ${direction.key}: border=${colors.border}, glow=${colors.glow}`);
      card.style.setProperty('--border-color', colors.border);
      card.style.setProperty('--glow-color', colors.glow);
      card.style.setProperty('--card-border-color', colors.border);
      card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      card.style.setProperty('--card-border-color', colors.border);
      card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      card.style.setProperty('--card-border-color', colors.border);
      card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      console.log(`🎨 Colors set. Card glow-color property:`, card.style.getPropertyValue('--glow-color'));

      // Double-check that the properties are actually set
      setTimeout(() => {
          const actualBorderColor = card.style.getPropertyValue('--border-color');
          const actualGlowColor = card.style.getPropertyValue('--glow-color');
          console.log(`🔍 Verification for ${direction.key}: border=${actualBorderColor}, glow=${actualGlowColor}`);
          if (!actualGlowColor) {
              console.error(`❌ GLOW COLOR NOT SET for ${direction.key}!`);
          }
      }, 100);

      console.log(`🎨 Applied ${directionType} colors to ${direction.key}: border=${colors.border}, glow=${colors.glow}`);


      // Add click handler for regular dimension cards (not next track)
      if (!isNextTrack) {
          // All direction cards use standard behavior - reverse functionality appears after selection
          let currentTrackIndex = 0; // Track which sample is currently shown

          card.addEventListener('click', (e) => {
              console.log(`🎬 Card clicked for dimension: ${direction.key}`);

              // Check if clicking on the reverse icon - if so, don't swap roles
              if (e.target.closest('.uno-reverse')) {
                  console.log(`🎬 Clicked on reverse icon, ignoring card click`);
                  return; // Let the reverse icon handle its own behavior
              }

              console.log(`🎬 Valid card click, triggering animation: ${direction.key} to center`);

              // Find any existing next track card (more reliable than using latestExplorerData)
              const existingNextTrackCard = document.querySelector('.dimension-card.next-track');

              if (!existingNextTrackCard) {
                  // No existing next track, animate directly to center
                  console.log(`🎬 No existing next track found, animating ${direction.key} directly to center`);
                  state.usingOppositeDirection = false; // Reset reverse flag when selecting new direction
                  animateDirectionToCenter(direction.key);
              } else {
                  // Check if this card represents the same base dimension (ignoring polarity)
                  const currentCardDirection = existingNextTrackCard.dataset.directionKey;
                     const baseCurrentDirection = currentCardDirection.replace(/_positive$|_negative$/, '');
                     const baseClickedDirection = direction.key.replace(/_positive$|_negative$/, '');
                     const isSameDimension = baseCurrentDirection === baseClickedDirection || currentCardDirection === direction.key;

                     console.log(`🎯 CLICK COMPARISON DEBUG:`);
                     console.log(`🎯   Current card direction: ${currentCardDirection}`);
                     console.log(`🎯   Clicked direction: ${direction.key}`);
                     console.log(`🎯   Base current: ${baseCurrentDirection}`);
                     console.log(`🎯   Base clicked: ${baseClickedDirection}`);
                     console.log(`🎯   Same dimension? ${isSameDimension}`);

                     if (isSameDimension) {
                         // it's already there so start cycling through the deck
                         console.log(`🔄 Cycling stack for ${direction.key}, current card shows ${currentCardDirection}, usingOppositeDirection = ${state.usingOppositeDirection}`);

                         // Determine which tracks to cycle through based on reverse flag
                        let tracksToUse, dimensionToShow;
                        if (state.usingOppositeDirection && Array.isArray(direction.oppositeDirection?.sampleTracks) && direction.oppositeDirection.sampleTracks.length) {
                            tracksToUse = direction.oppositeDirection.sampleTracks;
                            dimensionToShow = direction.oppositeDirection;
                            console.log(`🔄 Cycling through opposite direction tracks`);
                        } else {
                            tracksToUse = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
                            dimensionToShow = direction;
                            console.log(`🔄 Cycling through original direction tracks`);
                        }

                        if (!tracksToUse.length) {
                            console.warn(`⚠️ No sample tracks available to cycle for ${direction.key}`);
                            return;
                        }

                        // Cycle the appropriate tracks
                        const nextSample = tracksToUse.shift();
                        tracksToUse.push(nextSample);

                        const track = nextSample && (nextSample.track || nextSample);
                        if (!track) {
                            console.warn(`⚠️ Sample entry missing track data for ${direction.key}`);
                            return;
                        }
                        updateCardWithTrackDetails(card, track, dimensionToShow, true, swapStackContents);
                      } else {
                          console.log(`🎬 Found existing next track: ${existingNextTrackCard.dataset.directionKey}, rotating to next clock position`);
                          rotateCenterCardToNextPosition(existingNextTrackCard.dataset.directionKey);
                          // Wait for the rotation animation to complete before starting the new one
                          setTimeout(() => {
                              state.usingOppositeDirection = false; // Reset reverse flag when selecting new direction
                              animateDirectionToCenter(direction.key);
                          }, 400); // Half the animation time for smoother transition
                      }
                  }

                  // Update server with the new selection
                  const track = direction.sampleTracks[0].track || direction.sampleTracks[0];
                  sendNextTrack(track.identifier, direction.key, 'user');
          });
      }

      if (typeof evaluateDirectionConsistency === 'function') {
          const samplesForCheck = Array.isArray(directionTracks) && directionTracks.length
              ? directionTracks
              : (Array.isArray(direction.sampleTracks) ? direction.sampleTracks : []);
          evaluateDirectionConsistency(direction, {
              card,
              sampleTracks: samplesForCheck,
              currentTrack: state.latestCurrentTrack
          });
      }

      return card;
  }

  // Rotate center card to next available clock position (circular rotation system)
  function rotateCenterCardToNextPosition(directionKey) {
      let card = document.querySelector(`[data-direction-key="${directionKey}"].next-track`);
      if (!card) {
          card = document.querySelector(`.dimension-card.next-track[data-base-direction-key="${directionKey}"]`)
              || document.querySelector(`.dimension-card.next-track[data-original-direction-key="${directionKey}"]`);
      }
      if (!card) {
          console.warn(`🔄 rotateCenterCardToNextPosition: no center card found for ${directionKey}`);
          return false;
      }

      const cardDirectionKey = card.dataset.directionKey
          || card.dataset.baseDirectionKey
          || card.dataset.originalDirectionKey
          || directionKey;

      const stackedFollowers = Array.from(document.querySelectorAll('.dimension-card.next-track'))
          .filter(node => node !== card);
      if (stackedFollowers.length) {
          stackedFollowers.forEach(node => {
              node.style.opacity = '0';
              node.style.pointerEvents = 'none';
          });
          setTimeout(() => {
              stackedFollowers.forEach(node => {
                  if (node.parentElement) {
                      node.parentElement.removeChild(node);
                  }
              });
          }, 420);
      }

      console.log(`🔄 Rotating center card ${cardDirectionKey} to next clock position`);

      if (typeof hideStackSizeIndicator === 'function') {
          hideStackSizeIndicator(card);
      }

      // Get all cards on the clock face (not center)
      const clockCards = Array.from(document.querySelectorAll('[data-direction-key]:not(.next-track)'))
          .map(c => ({
              element: c,
              key: c.dataset.directionKey,
              position: parseInt(c.dataset.clockPosition) || 12
          }))
          .sort((a, b) => a.position - b.position);

      console.log(`🔄 Current clock positions:`, clockCards.map(c => `${c.key}@${c.position}`));

      // Find first available empty position on the clock face
      const occupiedPositions = new Set(clockCards.map(c => c.position));
      console.log(`🔄 Occupied positions:`, Array.from(occupiedPositions).sort((a, b) => a - b));

      // Check if we should try to return to the original position first
      const originalPosition = card.dataset.originalClockPosition ? parseInt(card.dataset.originalClockPosition) : null;
      console.log(`🔄 Card ${cardDirectionKey} original position was: ${originalPosition}`);

      let nextPosition = 1;
      if (originalPosition && !occupiedPositions.has(originalPosition)) {
          // Return to original position if it's available
          nextPosition = originalPosition;
          console.log(`🔄 Returning ${cardDirectionKey} to original position ${nextPosition}`);
      } else {
          // Find first available gap in positions 1-12 (preferring non-outlier positions)
          const availablePositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]; // Check 11 (outlier) last
          for (const pos of availablePositions) {
              if (!occupiedPositions.has(pos)) {
                  nextPosition = pos;
                  break;
              }
          }
          console.log(`🔄 Found first available position: ${nextPosition}`);
      }

      console.log(`🔄 Moving ${cardDirectionKey} to position ${nextPosition}`);

      // Calculate position coordinates
      const angle = ((nextPosition - 1) / 12) * Math.PI * 2 - Math.PI / 2;
      const radiusX = 38;
      const radiusY = 42;
      const centerX = 50;
      const centerY = 50;
      const x = centerX + radiusX * Math.cos(angle);
      const y = centerY + radiusY * Math.sin(angle);

      // Update card's stored position
      card.dataset.clockPosition = nextPosition;

      // Animate to the new clock position
      card.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
      card.style.left = `${x}%`;
      card.style.top = `${y}%`;
      card.style.transform = 'translate(-50%, -50%) translateZ(-800px) scale(0.5)';
      card.style.zIndex = '20';

      // After animation, remove next-track styling and reset to normal card
      setTimeout(() => {
          card.classList.remove('next-track', 'track-detail-card');
          // Stack indication is now handled by CSS pseudo-elements

          // Reset card content to simple direction display
          const resetKey = card.dataset.originalDirectionKey
              || card.dataset.baseDirectionKey
              || card.dataset.directionKey
              || cardDirectionKey;
          card.dataset.baseDirectionKey = resetKey;
          card.dataset.originalDirectionKey = resetKey;
          card.style.marginLeft = '0px';
          resetCardToDirectionDisplay(card, resetKey);

          card.style.transition = '';
      }, 800);

      return true;
  }

  // Reset a card back to simple direction display (when moving from center to clock position)
  function resetCardToDirectionDisplay(card, directionKey) {
      console.log(`🔄 Resetting card ${directionKey} to direction display`);

      // IMPORTANT: Reset reverse state and restore original face
      console.log(`🔄 Restoring original face for ${directionKey} (removing any reversed state)`);
      card.classList.remove('track-detail-card');

      const lingeringStackVisual = card.querySelector('.stack-line-visual');
      if (lingeringStackVisual) {
          lingeringStackVisual.remove();
      }
      const lingeringMetrics = card.querySelector('.track-metrics');
      if (lingeringMetrics) {
          lingeringMetrics.remove();
      }

      // Remove reversed classes and restore original direction
      card.classList.remove('reversed');

      const explorerDirections = state.latestExplorerData?.directions || {};
      const baseDirectionKey = card.dataset.originalDirectionKey || directionKey;
      let direction = explorerDirections[baseDirectionKey];

      if (!direction) {
          for (const [baseKey, baseDirection] of Object.entries(explorerDirections)) {
              if (baseDirection.oppositeDirection?.key === baseDirectionKey) {
                  direction = {
                      ...baseDirection.oppositeDirection,
                      hasOpposite: baseDirection.oppositeDirection.hasOpposite === true || baseDirection.hasOpposite === true
                  };
                  console.log(`🔄 Found embedded direction data for ${baseDirectionKey} inside ${baseKey}.oppositeDirection`);
                  break;
              }
          }
      }

      if (!direction) {
          const datasetTrackId = card.dataset.trackMd5 || card.dataset.trackIdentifier || null;
          if (datasetTrackId) {
              const syntheticTrack = {
                  identifier: datasetTrackId,
                  title: card.dataset.trackTitle || 'Unknown Track',
                  artist: card.dataset.trackArtist || '',
                  album: card.dataset.trackAlbum || '',
                  duration: card.dataset.trackDurationSeconds ? Number(card.dataset.trackDurationSeconds) : null,
                  albumCover: card.dataset.trackAlbumCover || ''
              };

              const syntheticDirection = {
                  key: baseDirectionKey,
                  sampleTracks: [{ track: syntheticTrack }],
                  trackCount: 1,
                  hasOpposite: !!getOppositeDirection(baseDirectionKey)
              };

              state.latestExplorerData = state.latestExplorerData || {};
              state.latestExplorerData.directions = state.latestExplorerData.directions || {};
              state.latestExplorerData.directions[baseDirectionKey] = syntheticDirection;

              direction = syntheticDirection;
              console.warn(`🔄 Synthesized direction data for ${baseDirectionKey} from card dataset`);
          }
      }

      if (!direction) {
          console.error(`🔄 No direction data found for ${baseDirectionKey}`);
          console.error(`🔄 Available directions:`, Object.keys(explorerDirections));
          return;
      }

      const resolvedKey = direction.key || baseDirectionKey;
      card.dataset.directionKey = resolvedKey;
      if (!card.dataset.originalDirectionKey) {
          card.dataset.originalDirectionKey = resolvedKey;
      }
      card.dataset.baseDirectionKey = resolvedKey;
      delete card.dataset.oppositeDirectionKey;
      const directionType = getDirectionType(resolvedKey);
      const colorVariant = variantFromDirectionType(directionType);

      // Get matching colors and variant
      const colors = getDirectionColor(directionType, resolvedKey);


      // Reset colors to original (non-reversed)
      card.style.setProperty('--border-color', colors.border);
      card.style.setProperty('--glow-color', colors.glow);

      // Reset rim to original (non-reversed) style
      const rimElement = card.querySelector('.rim');
      if (rimElement) {
          rimElement.style.background = ''; // Clear any reversed rim styling
          console.log(`🔄 Cleared reversed rim styling for ${directionKey}`);
      }

      const intrinsicNegative = isNegativeDirection(resolvedKey);
      card.classList.toggle('negative-direction', intrinsicNegative);

      // Reset to simple direction content
      const directionName = direction?.isOutlier ? "Outlier" : formatDirectionName(resolvedKey);
      const sample = Array.isArray(direction.sampleTracks) ? direction.sampleTracks[0] : null;
      const sampleTrack = sample?.track || sample || {};
      const albumCover = sampleTrack.albumCover || sample?.albumCover || '';
      const labelContent = `<div class="dimension-label">${directionName}</div>`;

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(albumCover)}"></div>
              <span class="rim"></span>
              <div class="label">
                  ${labelContent}
              </div>
          </div>
      `;

      if (typeof renderReverseIcon === 'function') {
          const hasOpposite = direction.hasOpposite === true || !!resolveOppositeDirectionKey(direction);
          if (hasOpposite) {
              const reverseColor = typeof resolveOppositeBorderColor === 'function'
                  ? resolveOppositeBorderColor(direction, colors.border)
                  : colors.border;
              card.dataset.oppositeBorderColor = reverseColor;
              const panel = card.querySelector('.panel');
              if (panel) {
                  const isNegative = isNegativeDirection(resolvedKey);
                  const topColor = isNegative ? (reverseColor || colors.border) : colors.border;
                  const bottomColor = isNegative ? colors.border : (reverseColor || colors.border);
                  panel.insertAdjacentHTML('beforeend', renderReverseIcon({ interactive: false, topColor, bottomColor, highlight: null, extraClasses: 'has-opposite' }));
              }
          } else {
              delete card.dataset.oppositeBorderColor;
          }
      }

      if (typeof applyDirectionStackIndicator === 'function') {
          applyDirectionStackIndicator(direction, card);
      }

      console.log(`🔄 Card ${resolvedKey} reset to simple direction display`);

      if (state.baseDirectionKey === directionKey || state.baseDirectionKey === resolvedKey) {
          state.baseDirectionKey = null;
      }
      if (!document.querySelector('.dimension-card.next-track')) {
          state.currentOppositeDirectionKey = null;
      }

      if (typeof evaluateDirectionConsistency === 'function') {
          evaluateDirectionConsistency(direction, {
              card,
              sampleTracks: direction.sampleTracks || [],
              currentTrack: state.latestCurrentTrack
          });
      }
  }

  function findDirectionKeyContainingTrack(explorerData, trackId) {
      if (!explorerData || !trackId) return null;
      for (const [dirKey, direction] of Object.entries(explorerData.directions || {})) {
          const samples = direction?.sampleTracks || [];
          const hit = samples.some(sample => {
              const track = sample?.track || sample;
              return track?.identifier === trackId;
          });
          if (hit) {
              return dirKey;
          }
      }
      return null;
  }

  function resolveNextTrackData() {
      const explorer = state.latestExplorerData;
      if (explorer) {
          const explorerNext = explorer.nextTrack;
          if (explorerNext) {
              const track = explorerNext.track || explorerNext;
              if (track) {
                  return {
                      track,
                      directionKey: explorerNext.directionKey
                        || explorerNext.direction
                        || findDirectionKeyContainingTrack(explorer, track.identifier)
                  };
              }
          }

          if (state.selectedIdentifier) {
              const match = findTrackInExplorer(explorer, state.selectedIdentifier);
              if (match?.track) {
                  return { track: match.track, directionKey: match.directionKey || null };
              }
          }

          if (state.serverNextTrack) {
              const match = findTrackInExplorer(explorer, state.serverNextTrack);
              if (match?.track) {
                  return { track: match.track, directionKey: match.directionKey || null };
              }
          }
      }

      if (state.previousNextTrack) {
          return { track: state.previousNextTrack, directionKey: null };
      }

      return null;
  }

  // Convert a direction card into a next track stack (add track details and indicators)
  function convertToNextTrackStack(directionKey) {
      console.log(`🔄 Converting ${directionKey} to next track stack...`);
      console.log(`🔄 Latest explorer data:`, state.latestExplorerData);
      console.log(`🔄 Direction data:`, state.latestExplorerData?.directions[directionKey]);

      const requestedDirectionKey = directionKey;
      let directionData = state.latestExplorerData?.directions[directionKey];
      let actualDirectionKey = directionKey;

      if (!directionData) {
          const oppositeKey = getOppositeDirection(directionKey);
          console.log(`🔄 No data for ${directionKey}, trying opposite: ${oppositeKey}`);

          if (oppositeKey && state.latestExplorerData?.directions[oppositeKey]) {
              directionData = state.latestExplorerData.directions[oppositeKey];
              actualDirectionKey = oppositeKey;
              console.log(`🔄 Using opposite direction data: ${oppositeKey}`);
          }
      }

      const explorerNextInfo = resolveNextTrackData();
      const explorerNextId = explorerNextInfo?.track?.identifier
        || state.latestExplorerData?.nextTrack?.track?.identifier
        || state.latestExplorerData?.nextTrack?.identifier
        || null;

      if (!directionData && explorerNextId) {
          const fallbackKey = findDirectionKeyContainingTrack(state.latestExplorerData, explorerNextId);
          if (fallbackKey) {
              console.warn(`🔄 No direction data for ${directionKey}; falling back to ${fallbackKey} for track ${explorerNextId}`);
              directionData = state.latestExplorerData?.directions?.[fallbackKey] || null;
              actualDirectionKey = fallbackKey;
          }
      }

      if (!directionData) {
          console.warn(`🔄 No direction data found for ${directionKey}; synthesizing temporary direction`);
          const trackFallback = explorerNextInfo?.track
            || state.latestExplorerData?.nextTrack?.track
            || state.latestExplorerData?.nextTrack
            || state.previousNextTrack
            || null;

          if (!trackFallback) {
              console.error(`🔄 Unable to synthesize direction: missing track information`);
              return;
          }

          actualDirectionKey = explorerNextInfo?.directionKey || directionKey;
          directionData = {
              key: actualDirectionKey,
              direction: explorerNextInfo?.directionKey || actualDirectionKey,
              sampleTracks: [{ track: trackFallback }],
              trackCount: 1,
              hasOpposite: false,
              description: 'auto-generated'
          };
      }

      const direction = { ...directionData };
      direction.key = actualDirectionKey;
      directionKey = actualDirectionKey;

      const directionTracks = Array.isArray(direction.sampleTracks) ? [...direction.sampleTracks] : [];

      const sampleTracks = directionTracks.slice();
      if (!sampleTracks.length && explorerNextInfo?.track) {
          sampleTracks.push({ track: explorerNextInfo.track });
      }
      if (!sampleTracks.length && state.previousNextTrack) {
          sampleTracks.push({ track: state.previousNextTrack });
      }
      if (!sampleTracks.length) {
          console.warn(`🔄 No sample tracks found for ${directionKey}, creating stub track`);
          sampleTracks.push({
              track: {
                  identifier: explorerNextInfo?.track?.identifier || `stub_${directionKey}_${Date.now()}`,
                  title: explorerNextInfo?.track?.title || 'Upcoming Selection',
                  artist: explorerNextInfo?.track?.artist || '',
                  album: explorerNextInfo?.track?.album || '',
                  duration: explorerNextInfo?.track?.duration || null,
                  albumCover: explorerNextInfo?.track?.albumCover || state.latestCurrentTrack?.albumCover || ''
              }
          });
      }

      if (!sampleTracks.length) {
          console.error(`🔄 Unable to produce sample tracks for ${directionKey}`);
          return;
      }

      const normalizeSample = (sample) => {
          if (!sample) return null;
          if (sample && typeof sample === 'object' && 'track' in sample) {
              const trackObj = sample.track || sample;
              return { ...sample, track: trackObj };
          }
          return { track: sample };
      };

      const normalizedSamples = sampleTracks.map(normalizeSample).filter(Boolean);
      if (!normalizedSamples.length) {
          console.error(`🔄 Unable to normalize sample tracks for ${directionKey}`);
          return;
      }

      direction.sampleTracks = normalizedSamples;
      direction.hasOpposite = direction.hasOpposite === true
          || !!direction.oppositeDirection
          || !!getOppositeDirection(actualDirectionKey);

      const finalSamples = normalizedSamples;

      if (!state.latestExplorerData.directions) {
          state.latestExplorerData.directions = {};
      }

      state.latestExplorerData.directions[actualDirectionKey] = {
          ...(state.latestExplorerData.directions[actualDirectionKey] || {}),
          ...direction,
          key: actualDirectionKey,
          sampleTracks: finalSamples
      };

      if (requestedDirectionKey && requestedDirectionKey !== actualDirectionKey) {
          state.latestExplorerData.directions[requestedDirectionKey] = {
              ...(state.latestExplorerData.directions[requestedDirectionKey] || {}),
              ...direction,
              key: requestedDirectionKey,
              sampleTracks: finalSamples
          };
      }

      state.baseDirectionKey = actualDirectionKey;
      const computedOppositeKey = direction.oppositeDirection?.key
          || direction.oppositeDirection?.direction
          || getOppositeDirection(actualDirectionKey)
          || null;
      state.currentOppositeDirectionKey = computedOppositeKey;

      let card = document.querySelector(`[data-direction-key="${actualDirectionKey}"]`);
      if (!card) {
          const fallbackKey = findDirectionKeyContainingTrack(state.latestExplorerData, (finalSamples[0]?.track || finalSamples[0])?.identifier);
          if (fallbackKey) {
              console.warn(`🔄 Could not find card for ${actualDirectionKey}; attempting fallback card ${fallbackKey}`);
              card = document.querySelector(`[data-direction-key="${fallbackKey}"]`);
              if (card) {
                  state.baseDirectionKey = fallbackKey;
                  actualDirectionKey = fallbackKey;
              }
          }
      }

      if (!card) {
          console.warn(`🔄 Could not find card element for ${actualDirectionKey}; creating temporary next-track card`);
          const container = elements.dimensionCards || document.getElementById('dimensionCards');
          if (container) {
              card = document.createElement('div');
              card.className = 'dimension-card next-track track-detail-card visible';
              card.dataset.directionKey = actualDirectionKey;
              card.style.left = '50%';
              card.style.top = '45%';
              card.style.transform = 'translate(-50%, -40%) translateZ(-400px) scale(1.0)';
              card.style.zIndex = '120';
              container.appendChild(card);
          }
      }

      if (!card) {
          console.error(`🔄 Could not find or create card element for ${actualDirectionKey}`);
          console.error('🎬 Available cards: ', Array.from(document.querySelectorAll('.dimension-card')).map(el => el.getAttribute('data-direction-key')));
          return;
      }
      card.dataset.baseDirectionKey = actualDirectionKey;
      if (computedOppositeKey) {
          card.dataset.oppositeDirectionKey = computedOppositeKey;
      } else {
          delete card.dataset.oppositeDirectionKey;
      }
      card.classList.add('track-detail-card');
      console.log(`🔄 Found card for ${actualDirectionKey}, updating with track details...`);
      console.log(`🔄 Card element:`, card);
      console.log(`🔄 Sample tracks:`, finalSamples);

      const primarySample = finalSamples[0] || {};
      const trackForCard = primarySample.track || primarySample;
      const preferredRecord = trackForCard ? { ...trackForCard } : null;

      console.log(`🔄 Selected track:`, trackForCard);
      console.log(`🔄 About to call updateCardWithTrackDetails with preserveColors=true...`);
      updateCardWithTrackDetails(card, trackForCard, direction, true, swapStackContents);
      console.log(`🔄 Finished calling updateCardWithTrackDetails`);

      state.skipNextExitAnimation = true;

      const previewDirectionKey = direction?.key
          || actualDirectionKey
          || requestedDirectionKey
          || directionKey;
      showNextTrackPreview(trackForCard, { directionKey: previewDirectionKey });

      state.latestExplorerData.nextTrack = {
          directionKey: previewDirectionKey,
          direction: direction?.direction || previewDirectionKey,
          track: preferredRecord
      };

      if (state.cardsDormant) {
          showNextTrackPreview(trackForCard, { directionKey: previewDirectionKey });
      }

      if (typeof updateNextTrackMetadata === 'function') {
          updateNextTrackMetadata(trackForCard);
      }

      // Stack depth indication is now handled via CSS pseudo-elements on the main card
  }

  // Periodic status check (optional, for monitoring)
  setInterval(() => {
    fetch('/status').catch(() => {});
  }, 30000);


// ====== Heartbeat & Sync System ======

// Unified next-track communication (handles user selection, heartbeat, and manual refresh)
async function sendNextTrack(trackMd5 = null, direction = null, source = 'user') {
    // source: 'user' | 'heartbeat' | 'manual_refresh'

    // Clear existing heartbeat
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
        state.heartbeatTimeout = null;
    }

    if (!state.streamFingerprint) {
        console.warn('⚠️ sendNextTrack: No fingerprint yet; waiting for SSE to bind');
        const ready = await waitForFingerprint(5000);

        if (!ready || !state.streamFingerprint) {
            console.warn('⚠️ sendNextTrack: Fingerprint still missing after wait; restarting session');
            await createNewJourneySession('missing_fingerprint');

            const fallbackReady = await waitForFingerprint(5000);
            if (!fallbackReady || !state.streamFingerprint) {
                console.error('❌ sendNextTrack: Aborting call - fingerprint unavailable');
                scheduleHeartbeat(10000);
                return;
            }
        }
    }

    // Use existing data if not provided (heartbeat/refresh case)
    const manualOverrideActive = state.manualNextTrackOverride && state.selectedIdentifier;

    const allowFallback = source !== 'manual_refresh';

    let md5ToSend = trackMd5;
    let dirToSend = direction;

    if (!md5ToSend && allowFallback) {
        if (manualOverrideActive && state.selectedIdentifier) {
            md5ToSend = state.selectedIdentifier;
            dirToSend = dirToSend || state.manualNextDirectionKey || null;
        }

        if (!md5ToSend) {
            if (state.serverNextTrack) {
                md5ToSend = state.serverNextTrack;
                dirToSend = dirToSend || state.serverNextDirection || null;
            }
        }

        if (!md5ToSend) {
            md5ToSend = state.latestExplorerData?.nextTrack?.track?.identifier || null;
            dirToSend = dirToSend || state.latestExplorerData?.nextTrack?.directionKey || null;
        }

        if (!md5ToSend && state.lastRefreshSummary?.nextTrack) {
            const refreshNextId = extractNextTrackIdentifier(state.lastRefreshSummary.nextTrack);
            if (refreshNextId) {
                md5ToSend = refreshNextId;
                if (!dirToSend) {
                    dirToSend = extractNextTrackDirection(state.lastRefreshSummary.nextTrack);
                }
            }
        }

        if (!md5ToSend) {
            md5ToSend = state.selectedIdentifier || null;
        }

        if (!md5ToSend && state.previousNextTrack?.identifier) {
            md5ToSend = state.previousNextTrack.identifier;
            dirToSend = dirToSend || state.previousNextTrack.directionKey || null;
        }

        if (!md5ToSend) {
            const activeCard = document.querySelector('.dimension-card.next-track');
            if (activeCard) {
                const datasetMd5 = activeCard.dataset.trackMd5 || activeCard.dataset.trackIdentifier || null;
                if (datasetMd5) {
                    md5ToSend = datasetMd5;
                }
                if (!dirToSend) {
                    dirToSend = activeCard.dataset.directionKey || activeCard.dataset.baseDirectionKey || null;
                }
            }
        }

        if (!md5ToSend && state.baseDirectionKey) {
            const direction = state.latestExplorerData?.directions?.[state.baseDirectionKey] || null;
            const candidate = direction?.sampleTracks?.[0];
            if (candidate) {
                const track = candidate.track || candidate;
                if (track?.identifier) {
                    md5ToSend = track.identifier;
                    dirToSend = dirToSend || state.baseDirectionKey;
                }
            }
        }
    }

    if (manualOverrideActive && !dirToSend) {
        dirToSend = state.manualNextDirectionKey;
    }

    if (!md5ToSend) {
        console.warn('⚠️ sendNextTrack: No track MD5 available; requesting fresh guidance from server');
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;

        if (source === 'heartbeat') {
            await requestSSERefresh();
            // TODO(lean-comms): remove fallback auto-heartbeat once E2E verified
            scheduleHeartbeat(30000);
        } else {
            await requestSSERefresh();
        }
        return;
    }

    console.log(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend || 'unknown'}`);

    if (source === 'user') {
        state.manualNextTrackOverride = true;
        state.manualNextDirectionKey = dirToSend;
        state.pendingManualTrackId = md5ToSend;
        if (state.nextTrackAnimationTimer) {
            clearTimeout(state.nextTrackAnimationTimer);
            state.nextTrackAnimationTimer = null;
        }
        if (state.cardsDormant) {
            const nextInfo = resolveNextTrackData();
            if (nextInfo?.track) {
                showNextTrackPreview(nextInfo.track, { directionKey: nextInfo.directionKey || nextInfo.track?.directionKey || null });
            }
        }
    }

    try {
        const response = await fetch('/next-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trackMd5: md5ToSend,
                direction: dirToSend,
                source,
                fingerprint: state.streamFingerprint,
                sessionId: state.sessionId
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        window.state = window.state || {};
        window.state.lastHeartbeatResponse = data;

        if (data.fingerprint) {
            if (state.streamFingerprint !== data.fingerprint) {
                console.log(`🔄 /next-track updated fingerprint to ${data.fingerprint}`);
            }
            applyFingerprint(data.fingerprint);
        }

        if (source === 'user' && md5ToSend) {
            state.selectedIdentifier = md5ToSend;
        }

        const serverTrack = data.currentTrack;
        const localTrack = state.latestCurrentTrack?.identifier || null;
        if (source === 'heartbeat' && serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch (immediate)', { serverTrack, localTrack });
            fullResync();
            return;
        }


        // data = { nextTrack, currentTrack, duration, remaining }

        if (DEBUG_FLAGS.deck) {
            console.log(`📥 Server response: next=${data.nextTrack?.substring(0,8)}, current=${data.currentTrack?.substring(0,8)}, remaining=${data.remaining}ms`);
        }

        // Analyze response and take appropriate action
        analyzeAndAct(data, source, md5ToSend);

    } catch (error) {
        console.error('❌ sendNextTrack failed:', error);

        const statusMatch = typeof error?.message === 'string' ? error.message.match(/HTTP\s+(\d+)/) : null;
        const statusCode = statusMatch ? Number(statusMatch[1]) : null;

        if (statusCode === 404) {
            console.warn('⚠️ next-track endpoint returned 404; requesting SSE refresh and backing off');

            // Clear any pending manual override so we can recover cleanly once data arrives
            state.pendingManualTrackId = null;

            if (typeof requestSSERefresh === 'function') {
                try {
                    await requestSSERefresh({ escalate: false, stage: 'next-track-404' });
                } catch (refreshError) {
                    console.warn('⚠️ SSE refresh after 404 failed', refreshError);
                }
            }

            // Reduce heartbeat pressure so we do not re-trigger the failure loop immediately
            scheduleHeartbeat(45000);
            return;
        }

        // Set shorter retry timeout for transient issues
        scheduleHeartbeat(10000); // Retry in 10s
    }
}

if (typeof window !== 'undefined') {
  window.sendNextTrack = sendNextTrack;
}

function analyzeAndAct(data, source, sentMd5) {
    const { nextTrack, currentTrack, duration, remaining } = data;

    if (data.fingerprint && state.streamFingerprint !== data.fingerprint) {
        if (!DEBUG_FLAGS.deck) {
            console.log(`🔄 Server response rotated fingerprint to ${data.fingerprint.substring(0, 6)}…`);
        }
        applyFingerprint(data.fingerprint);
    }

    if (!data || !currentTrack) {
        console.warn('⚠️ Invalid server response');
        // TODO(lean-comms): remove long auto heartbeat once SSE flow confirmed stable
        scheduleHeartbeat(60000);
        return;
    }

    const ICON = '🛰️';
    const serverDurationSeconds = (typeof duration === 'number' && duration > 0) ? (duration / 1000) : null;
    const serverElapsedSeconds = (typeof duration === 'number' && typeof remaining === 'number' && duration > 0)
        ? Math.max((duration - remaining) / 1000, 0)
        : null;
    const clientDurationSeconds = state.playbackDurationSeconds || null;
    const clientElapsedSeconds = (state.playbackStartTimestamp && state.playbackDurationSeconds)
        ? Math.max((Date.now() - state.playbackStartTimestamp) / 1000, 0)
        : null;

    const clientNextTrack = state.latestExplorerData?.nextTrack?.track?.identifier
        || state.latestExplorerData?.nextTrack?.identifier
        || state.selectedIdentifier
        || null;

    if (DEBUG_FLAGS.deck) {
        console.log(`${ICON} Sync snapshot (${source})`, {
            server: {
                currentTrack: currentTrack || null,
                elapsedSeconds: serverElapsedSeconds,
                durationSeconds: serverDurationSeconds,
                nextTrack: nextTrack || null
            },
            client: {
                currentTrack: state.latestCurrentTrack?.identifier || null,
                elapsedSeconds: clientElapsedSeconds,
                durationSeconds: clientDurationSeconds,
                nextTrack: clientNextTrack || null,
                pendingSelection: state.selectedIdentifier || null
            },
            sentOverride: sentMd5 || null
        });
    }

    // Check 1: Current track MD5 mismatch
    const currentMd5 = state.latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        console.log(`${ICON} ACTION current-track-mismatch`, {
            expected: currentMd5,
            received: currentTrack,
            source
        });
        fullResync();
        return;
    }

    // Check 2: Next track MD5 mismatch
    const expectedNextMd5 = state.latestExplorerData?.nextTrack?.track?.identifier || state.selectedIdentifier;
    const hasServerNext = Boolean(nextTrack);
    const nextTrackMismatch = Boolean(expectedNextMd5 && hasServerNext && nextTrack !== expectedNextMd5);

    if (expectedNextMd5 && !hasServerNext) {
        console.log(`${ICON} ACTION awaiting-server-next`, {
            expected: expectedNextMd5,
            source,
            sentMd5
        });
        if (state.manualNextTrackOverride) {
            // TODO(lean-comms): reassess auto heartbeat after override once staged refresh covers this case
            scheduleHeartbeat(10000);
        }
    }

    if (nextTrackMismatch) {
        if (state.manualNextTrackOverride || state.pendingManualTrackId) {
            console.log(`${ICON} ACTION server-next-ignored`, {
                expected: expectedNextMd5,
                received: nextTrack,
                source,
                overrideActive: state.manualNextTrackOverride,
                pendingManualTrackId: state.pendingManualTrackId,
                sentMd5
            });
            // TODO(lean-comms): reassess auto heartbeat after override mismatch once staged refresh covers this case
            scheduleHeartbeat(20000);
            return;
        }

        console.log(`${ICON} ACTION next-track-mismatch`, {
            expected: expectedNextMd5,
            received: nextTrack,
            source,
            sentMd5
        });

        // If this is what we just sent, it's a confirmation not a mismatch - just update our state
        if (sentMd5 && nextTrack === sentMd5) {
            console.log(`${ICON} ACTION confirmation`, {
                acknowledged: sentMd5,
                source
            });
            selectedNextTrackSha = nextTrack;
            // TODO(lean-comms): drop long heartbeat once confirmation flow is stable
            scheduleHeartbeat(60000);
            return;
        }

        // Otherwise, server picked something different (only happens on heartbeat/auto-transition)
        // Check if the server's next track is in our current neighborhood
        if (isTrackInNeighborhood(nextTrack)) {
            console.log(`${ICON} ACTION promote-neighborhood`, {
                track: nextTrack,
                source
            });
            promoteTrackToNextStack(nextTrack);
            // TODO(lean-comms): drop long heartbeat once confirmation flow is stable
            scheduleHeartbeat(60000);
        } else {
            console.log(`${ICON} ACTION full-resync-needed`, {
                track: nextTrack,
                reason: 'not_in_neighborhood',
                source
            });
            fullResync();
            return;
        }
    }

    // Check 3: Timing drift (just update, don't panic)
    if (typeof duration === 'number' && typeof remaining === 'number' && duration > 0) {
        const durationSeconds = Math.max(duration / 1000, 0);
        const elapsedSeconds = Math.max((duration - remaining) / 1000, 0);
        const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
        console.log(`${ICON} ACTION timing-update`, {
            durationSeconds,
            elapsedSeconds: clampedElapsed,
            source
        });
        startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: true });
    }

    // All checks passed
    console.log(`${ICON} ACTION sync-ok`, { source });

    if (state.cardsDormant) {
        const info = resolveNextTrackData();
        if (info?.track) {
            showNextTrackPreview(info.track, { directionKey: info.directionKey || info.track?.directionKey || null });
        }
    }

    // TODO(lean-comms): consider removing steady-state heartbeat once confidence high
    scheduleHeartbeat(60000);
}

function isTrackInNeighborhood(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        return false;
    }

    // Search through all directions' sample tracks
    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const found = direction.sampleTracks.some(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });
            if (found) {
                console.log(`🔍 Track ${trackMd5.substring(0,8)} found in direction: ${dirKey}`);
                return true;
            }
        }
    }

    return false;
}

function promoteTrackToNextStack(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        console.warn('⚠️ No explorer data to promote track from');
        return;
    }

    // Find which direction contains this track
    let foundDirection = null;
    let foundTrack = null;

    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const trackData = direction.sampleTracks.find(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });

            if (trackData) {
                foundDirection = dirKey;
                foundTrack = trackData.track || trackData;
                break;
            }
        }
    }

    if (!foundDirection || !foundTrack) {
        console.error('❌ Track not found in any direction, cannot promote');
        return;
    }

    console.log(`🎯 Promoting track from ${foundDirection} to next track stack`);

    // Use existing function to swap next track direction
    navigateDirectionToCenter(foundDirection);

    // Update selected track state
    state.selectedIdentifier = trackMd5;
}

function scheduleHeartbeat(delayMs = 60000) {
    const MIN_HEARTBEAT_INTERVAL = 1000;
    delayMs = Math.max(delayMs, MIN_HEARTBEAT_INTERVAL);
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
    }

    state.heartbeatTimeout = setTimeout(() => {
        console.log('💓 Heartbeat triggered');
        sendNextTrack(null, null, 'heartbeat');
        window.state = window.state || {};
        const serverTrack = window.state?.lastHeartbeatResponse?.currentTrack;
        const localTrack = window.state?.latestCurrentTrack?.identifier || null;
        if (serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch', { serverTrack, localTrack });
            fullResync();
            return;
        }

    }, delayMs);

    console.log(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

async function fullResync() {
    console.log('🔄 Full resync triggered - calling /refresh-sse');

    try {
        const payload = {};
        if (state.streamFingerprint) {
            payload.fingerprint = state.streamFingerprint;
        }
        if (state.sessionId) {
            payload.sessionId = state.sessionId;
        }

        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Check for 404 - session no longer exists (server restart)
        if (response.status === 404) {
            console.error('🚨 Session not found on server - session was destroyed (likely server restart)');
            console.log('🔄 Reloading page to get new session...');
            window.location.reload();
            return;
        }

        const result = await response.json();

        if (result.fingerprint) {
            if (state.streamFingerprint !== result.fingerprint) {
                console.log(`🔄 Resync payload updated fingerprint to ${result.fingerprint}`);
            }
            applyFingerprint(result.fingerprint);
        }

        if (result.ok) {
            console.log('✅ Resync broadcast triggered, waiting for SSE update...');
            // SSE event will update UI
            // TODO(lean-comms): revisit steady-state heartbeat once SSE proves reliable
            scheduleHeartbeat(60000);

            if (state.pendingResyncCheckTimer) {
              clearTimeout(state.pendingResyncCheckTimer);
            }

            state.pendingResyncCheckTimer = setTimeout(() => {
              const lastUpdate = state.lastTrackUpdateTs || 0;
              const age = Date.now() - lastUpdate;
              const hasCurrent = state.latestCurrentTrack && state.latestCurrentTrack.identifier;

              if (!hasCurrent || age > 5000) {
                console.warn('🛰️ ACTION resync-followup: no track update after broadcast, requesting SSE refresh');
                requestSSERefresh();
              }
            }, 5000);
        } else {
            console.warn('⚠️ Resync failed:', result.reason);

            // If session doesn't exist, reload
            if (result.error === 'Session not found' || result.error === 'Master session not found') {
                console.log('🔄 Session lost, reloading page...');
                window.location.reload();
                return;
            }

            // TODO(lean-comms): drop auto retry once staged refresh covers this path
            scheduleHeartbeat(10000); // Retry sooner
        }
    } catch (error) {
        console.error('❌ Resync error:', error);
        // TODO(lean-comms): drop auto retry once staged refresh covers this path
        scheduleHeartbeat(10000); // Retry sooner
    }
}

// Request SSE refresh from the backend
async function createNewJourneySession(reason = 'unknown') {
    if (state.creatingNewSession) {
        console.log(`🛰️ ACTION new-session-skip: already creating (${reason})`);
        return;
    }

    state.creatingNewSession = true;
    try {
        console.warn(`🛰️ ACTION new-session (${reason}) - requesting fresh journey`);

        const streamElement = state.isStarted ? elements.audio : null;
        if (streamElement) {
            try {
                streamElement.pause();
            } catch (err) {
                console.warn('🎵 Pause before new session failed:', err);
            }
        }

        clearFingerprint({ reason: `new_session_${reason}` });
        state.sessionId = null;

        const newStreamUrl = composeStreamEndpoint(null, Date.now());
        state.streamUrl = newStreamUrl;

        if (streamElement) {
            audioHealth.isHealthy = false;
            audioHealth.lastTimeUpdate = null;
            audioHealth.bufferingStarted = Date.now();
            connectAudioStream(newStreamUrl, { reason: `new-session-${reason}` });
            state.awaitingSSE = true;
        }

        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;
        state.latestExplorerData = null;
        state.remainingCounts = {};

        if (state.pendingInitialTrackTimer) {
            clearTimeout(state.pendingInitialTrackTimer);
            state.pendingInitialTrackTimer = null;
        }
        if (state.pendingResyncCheckTimer) {
            clearTimeout(state.pendingResyncCheckTimer);
            state.pendingResyncCheckTimer = null;
        }

        if (connectionHealth.currentEventSource) {
            connectionHealth.currentEventSource.close();
            connectionHealth.currentEventSource = null;
        }
        connectionHealth.sse.status = 'reconnecting';
        updateConnectionHealthUI();

        setTimeout(() => connectSSE(), 200);

        if (streamElement && state.isStarted) {
            startAudioHealthMonitoring();
            playAudioElement('new-session');
        }

        // TODO(lean-comms): revisit auto heartbeat after new session once staged recovery validated
        scheduleHeartbeat(5000);
    } catch (error) {
        console.error('❌ Failed to create new journey session:', error);
        // TODO(lean-comms): revisit auto heartbeat after new session failure once staged recovery validated
        scheduleHeartbeat(10000);
    } finally {
        state.creatingNewSession = false;
    }
}

async function verifyExistingSessionOrRestart(reason = 'unknown', options = {}) {
    const { escalate = true } = options;
    if (!state.streamFingerprint) {
        const ready = await waitForFingerprint(3000);
        if (!ready || !state.streamFingerprint) {
            if (escalate) {
                await createNewJourneySession(reason);
            }
            return false;
        }
    }

    try {
        const ok = await requestSSERefresh({ escalate: false });
        if (ok) {
            console.warn('🛰️ ACTION session-rebind: stream still active, reconnecting SSE without resetting');

            if (connectionHealth.currentEventSource) {
                connectionHealth.currentEventSource.close();
                connectionHealth.currentEventSource = null;
            }

            connectionHealth.sse.status = 'reconnecting';
            updateConnectionHealthUI();
            connectSSE();

            // TODO(lean-comms): evaluate removing auto heartbeat after session rebind once proven stable
            scheduleHeartbeat(10000);
            return true;
        }
    } catch (error) {
        console.error('❌ verifyExistingSessionOrRestart failed:', error);
    }

    if (escalate) {
        await createNewJourneySession(reason);
    }
    return false;
}

async function requestSSERefresh(options = {}) {
    const { escalate = true, stage = 'rebroadcast' } = options;
    if (!state.streamFingerprint) {
        console.warn('⚠️ requestSSERefresh: No fingerprint yet; waiting for SSE handshake');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            console.warn('⚠️ requestSSERefresh: Aborting refresh - fingerprint unavailable');
            return false;
        }
    }

    try {
        console.log('🔄 Sending SSE refresh request to backend...');
        const requestBody = {
            reason: 'zombie_session_recovery',
            clientTime: Date.now(),
            lastTrackStart: state.latestCurrentTrack?.startTime || null,
            fingerprint: state.streamFingerprint,
            sessionId: state.sessionId,
            stage
        };

        // Add session ID if we have one
        if (!state.latestExplorerData || !state.latestExplorerData.directions) {
            requestBody.requestExplorerData = true;
        }

        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ SSE refresh request successful:', result);

            state.lastRefreshSummary = result;

            if (result.fingerprint) {
                if (state.streamFingerprint !== result.fingerprint) {
                    console.log(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
                }
                applyFingerprint(result.fingerprint);
            }

            if (result.ok === false) {
                const reason = result.reason || 'unknown';
                console.warn(`🔄 SSE refresh reported issue: ${reason}`);

                if (reason === 'inactive') {
                    console.warn('🔄 SSE refresh indicates inactive session; verifying stream state');
                    if (!escalate) {
                        return false;
                    }
                    if (result.streamAlive === false) {
                        await createNewJourneySession('refresh_inactive');
                    } else {
                        await verifyExistingSessionOrRestart('refresh_inactive');
                    }
                } else if (reason === 'no_track') {
                    console.warn('🔄 SSE refresh returned no track; scheduling quick heartbeat');
                    // TODO(lean-comms): drop quick heartbeat once staged refresh proves sufficient
                    scheduleHeartbeat(5000);
                }
                return false;
            }

            if (result.currentTrack) {
                const previousTrackId = state.latestCurrentTrack?.identifier || null;
                console.log(`🔄 Backend reports active session with track: ${result.currentTrack.title} by ${result.currentTrack.artist}`);
                console.log(`🔄 Duration: ${result.currentTrack.duration}s, Broadcasting to ${result.clientCount} clients`);

                if (result.fingerprint && state.streamFingerprint !== result.fingerprint) {
                    console.log(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
                    applyFingerprint(result.fingerprint);
                }

                // Update the now playing card with current track data
                updateNowPlayingCard(result.currentTrack, null);
                const incomingTrackId = result.currentTrack?.identifier || null;

                // Update fallback next-track info so heartbeats have a baseline even without explorer data
                if (result.nextTrack) {
                    const nextTrackId = extractNextTrackIdentifier(result.nextTrack);
                    if (nextTrackId) {
                        state.serverNextTrack = nextTrackId;
                        const nextDirection = extractNextTrackDirection(result.nextTrack);
                        if (nextDirection) {
                            state.serverNextDirection = nextDirection;
                        }
                        if (!state.manualNextTrackOverride) {
                            state.selectedIdentifier = state.selectedIdentifier || nextTrackId;
                        }
                    } else {
                        console.warn('⚠️ SSE refresh nextTrack present but missing identifier', result.nextTrack);
                    }
                }

                // If the backend provides exploration data, update the cards
                if (result.explorerData) {
                    console.log(`🔄 Backend provided exploration data, updating direction cards`);
                    createDimensionCards(result.explorerData);
                } else {
                    console.log(`🔄 No exploration data from backend - keeping existing cards`);
                }

                if (!result.explorerData && (!state.latestExplorerData || !state.latestExplorerData.directions)) {
                    console.warn('⚠️ Explorer data still missing after refresh; forcing follow-up request');
                    fullResync();
                }

                // Start progress animation if duration is available
                const timingElapsedMs = Number.isFinite(result.currentTrack?.elapsedMs)
                    ? result.currentTrack.elapsedMs
                    : Number.isFinite(result.timing?.elapsedMs)
                        ? result.timing.elapsedMs
                        : null;

                const reportedDuration = Number.isFinite(result.currentTrack?.duration)
                    ? result.currentTrack.duration
                    : Number.isFinite(result.currentTrack?.length)
                        ? result.currentTrack.length
                        : null;

                if (Number.isFinite(reportedDuration) && reportedDuration > 0) {
                    state.playbackDurationSeconds = reportedDuration;
                }

                const audioElapsed = elements.audio && Number.isFinite(elements.audio.currentTime)
                    ? elements.audio.currentTime
                    : null;

                const elapsedSeconds = timingElapsedMs !== null
                    ? Math.max(timingElapsedMs / 1000, 0)
                    : audioElapsed;

                if (elapsedSeconds !== null) {
                    state.playbackStartTimestamp = Date.now() - elapsedSeconds * 1000;
                }

                const sameTrack = Boolean(incomingTrackId && previousTrackId && incomingTrackId === previousTrackId);
                const effectiveDuration = state.playbackDurationSeconds || reportedDuration || 0;

                if (effectiveDuration > 0) {
                    if (sameTrack) {
                        if (elapsedSeconds !== null) {
                            startProgressAnimationFromPosition(effectiveDuration, elapsedSeconds, { resync: true });
                        } else if (state.playbackStartTimestamp) {
                            const inferredElapsed = Math.max((Date.now() - state.playbackStartTimestamp) / 1000, 0);
                            startProgressAnimationFromPosition(effectiveDuration, inferredElapsed, { resync: true });
                        }
                    } else {
                        const startOffset = elapsedSeconds !== null ? Math.min(elapsedSeconds, effectiveDuration) : 0;
                        startProgressAnimationFromPosition(effectiveDuration, startOffset, { resync: true });
                        if (elapsedSeconds === null) {
                            state.playbackStartTimestamp = Date.now() - startOffset * 1000;
                        }
                    }
                }

            } else {
                console.warn('🔄 SSE refresh completed but no current track reported');
            }

            return true;

        } else {
            console.error('❌ SSE refresh request failed:', response.status, response.statusText);
            const errorText = await response.text();
            console.error('❌ Error details:', errorText);
        }

    } catch (error) {
        console.error('❌ SSE refresh request error:', error);
    }

    return false;
}

async function manualRefresh() {
    console.log('🔄 Manual refresh requested');

    if (!state.streamFingerprint) {
        console.warn('🛰️ Manual refresh: no fingerprint yet; waiting before attempting rebroadcast');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            console.warn('🛰️ Manual refresh: fingerprint still missing; escalating to new session');
            await createNewJourneySession('manual_refresh_stage3_no_fingerprint');
            return 'new_session';
        }
    }

    const rebroadcastOk = await requestSSERefresh({ escalate: false, stage: 'rebroadcast' });
    if (rebroadcastOk) {
        console.log('🔄 Manual refresh: heartbeat rebroadcast succeeded');
        return 'rebroadcast';
    }

        console.warn('🛰️ Manual refresh: rebroadcast did not recover; attempting session rebind');
    const rebindOk = await verifyExistingSessionOrRestart('manual_refresh_stage2', { escalate: false });
    if (rebindOk) {
        console.log('🔄 Manual refresh: session rebind succeeded');
        return 'session_rebind';
    }

    console.warn('🛰️ Manual refresh: session rebind failed; creating new journey session');
    await createNewJourneySession('manual_refresh_stage3');
    return 'new_session';
}


// Manual refresh button functionality
function setupManualRefreshButton() {
    const refreshButton = document.getElementById('refreshButton');

    if (refreshButton) {
        refreshButton.addEventListener('click', async () => {
            console.log('🔄 Manual refresh button clicked');

            // Add visual feedback
            refreshButton.classList.add('refreshing');

            try {
                const outcome = await manualRefresh();
                console.log(`🔄 Manual refresh completed via ${outcome}`);

                // Keep spinning animation for a bit longer to show it worked
                setTimeout(() => {
                    refreshButton.classList.remove('refreshing');
                }, 1500);

            } catch (error) {
                console.error('❌ Manual refresh failed:', error);
                refreshButton.classList.remove('refreshing');
            }
        });

        console.log('🔄 Manual refresh button set up');
    } else {
        console.warn('🔄 Manual refresh button not found in DOM');
    }
}

// Initialize manual refresh button when page loads
document.addEventListener('DOMContentLoaded', function () {
  setupManualRefreshButton();
  setupRadiusControls();
  setupFzfSearch(function () { state.journeyMode = true; });

  // reconnection: Visibility API
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const sseStale = Date.now() - state.lastSSEMessageTime > 30000;
      if (sseStale) connectSSE();
    }
  });

  // reconnection: Network change
  window.addEventListener('online', () => {
    setTimeout(() => {
      if (connectionHealth.sse.status !== 'connected') connectSSE();
    }, 1000);
  });
});

}

// Check if stream endpoint is reachable
async function checkStreamEndpoint() {
    try {
        console.log('🔍 Checking stream endpoint connectivity...');

        const targetUrl = state.streamFingerprint
            ? composeStreamEndpoint(state.streamFingerprint, Date.now())
            : (state.streamUrl || '/stream');

        const response = await fetch(targetUrl, {
            method: 'HEAD',
            cache: 'no-cache'
        });

        if (response.ok) {
            console.log('✅ Stream endpoint is reachable');
            console.log('🔍 Response headers:', Object.fromEntries(response.headers.entries()));
        } else {
            console.error(`❌ Stream endpoint returned: ${response.status} ${response.statusText}`);
        }

    } catch (error) {
        console.error('❌ Stream endpoint check failed:', error);
        console.error('❌ This suggests the audio server is not running or not reachable');

        // Try refresh button as recovery
        console.log('🔄 Attempting SSE refresh as recovery...');
        requestSSERefresh();
    }
}




if (typeof window !== 'undefined') {
  window.state = state;
  window.setCardVariant = setCardVariant;
  window.getCardBackgroundColor = getCardBackgroundColor;

  window.__uiTestHooks = window.__uiTestHooks || {};
  const progressHooks = {
    get state() {
      return state;
    },
    get elements() {
      return elements;
    }
  };

  if (typeof startProgressAnimationFromPosition === 'function') {
    progressHooks.startProgressAnimationFromPosition = startProgressAnimationFromPosition;
  }
  if (typeof stopProgressAnimation === 'function') {
    progressHooks.stopProgressAnimation = stopProgressAnimation;
  }
  if (typeof updatePlaybackClockDisplay === 'function') {
    progressHooks.updatePlaybackClockDisplay = updatePlaybackClockDisplay;
  }
  if (typeof renderProgressBar === 'function') {
    progressHooks.renderProgressBar = renderProgressBar;
  }

  window.__uiTestHooks.progress = progressHooks;
}
