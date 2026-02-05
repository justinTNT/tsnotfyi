// Global state and constants - loaded before page.js
// This file defines shared state and configuration used across the application

export const rootElement = typeof document !== 'undefined' ? document.documentElement : null;

// Endpoint constants
export const STREAM_ENDPOINT_BASE = '/stream';
export const EVENTS_ENDPOINT_BASE = '/events';

// Timing constants
export const AUDIO_STARTUP_GRACE_MS = 20000;
export const CONNECTION_QUARANTINE_BASE_MS = 6000;
export const CONNECTION_QUARANTINE_MAX_MS = 60000;
export const TRACK_SWITCH_PROGRESS_THRESHOLD = 0.9;
export const PROGRESS_TICK_INTERVAL_MS = 100;
export const PROGRESS_ENVELOPE_STRETCH = 2.4;
export const PROGRESS_PULSE_AMPLITUDE = 0.04;
export const PROGRESS_AUDIO_WAIT_TIMEOUT_MS = 10000;
export const PROGRESS_DESYNC_MARGIN_SECONDS = 5;
export const TRACK_CHANGE_DESYNC_GRACE_MS = 7000;
export const MAX_PLAY_RETRY_ATTEMPTS = 4;
export const PLAY_RETRY_DELAY_MS = 700;
export const FORCE_SKIP_COOLDOWN_MS = 1500;
export const AUDIO_STALL_REBUILD_WINDOW_MS = 60000;
export const AUDIO_STALL_REBUILD_THRESHOLD = 4;
export const AUDIO_DEAD_REBUILD_WINDOW_MS = 120000;
export const AUDIO_DEAD_REBUILD_THRESHOLD = 2;
export const DECK_STALE_FAILSAFE_MS = 5000;
export const PENDING_EXPLORER_FORCE_MS = 6000;
export const LOCKOUT_THRESHOLD_SECONDS = 30;

// Card styling constants
export const PANEL_VARIANTS = ['red-variant', 'green-variant', 'yellow-variant', 'blue-variant'];
export const VARIANT_TO_DIRECTION_TYPE = {
  'red-variant': 'rhythmic_core',
  'green-variant': 'tonal_core',
  'blue-variant': 'spectral_core',
  'yellow-variant': 'latent'
};

export const CARD_BACKGROUND_BY_DIRECTION_TYPE = {
  rhythmic_core: '#2a1818',
  rhythmic_pca: '#2a1818',
  tonal_core: '#182a1a',
  tonal_pca: '#182a1a',
  spectral_core: '#18222a',
  spectral_pca: '#18222a',
  latent: '#2a1810'
};

export function getCardBackgroundColor(directionType) {
  return CARD_BACKGROUND_BY_DIRECTION_TYPE[directionType] || '#1b1b1b';
}

// Global application state
export const state = {
  lastSSEMessageTime: null,
  latestExplorerData: null,
  latestCurrentTrack: null,
  previousNextTrack: null,
  serverNextTrack: null,
  serverNextDirection: null,
  lastDirectionSignature: null,
  lastRefreshSummary: null,
  usingOppositeDirection: false,
  directionKeyAliases: {},
  reversePreference: null,
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
  streamUrl: STREAM_ENDPOINT_BASE,
  eventsEndpoint: EVENTS_ENDPOINT_BASE,
  streamUrlBase: STREAM_ENDPOINT_BASE,
  eventsEndpointBase: EVENTS_ENDPOINT_BASE,
  currentResolution: 'adaptive',
  manualNextTrackOverride: false,
  nextTrackAnimationTimer: null,
  manualNextDirectionKey: null,
  playbackStartTimestamp: null,
  playbackDurationSeconds: 0,
  lastTrackUpdateTs: 0,
  pendingInitialTrackTimer: null,
  pendingResyncCheckTimer: null,
  creatingNewSession: false,
  audioLoadPending: false,
  audioLoadStartedAt: 0,
  audioLoadReason: null,
  audioLoadUrl: null,
  pendingProgressStart: null,
  pendingProgressStartTimer: null,
  remainingCounts: {},
  pendingManualTrackId: null,
  pendingSnapshotTrackId: null,
  pendingCenterPromotionKey: null,
  pendingCenterPromotionOptions: null,
  awaitingSSE: false,
  cardsDormant: false,
  nextTrackPreviewTrackId: null,
  skipTrayDemotionForTrack: null,
  skipNextExitAnimation: false,
  trayPreviewState: null,
  directionLayout: {},
  trackMetadataCache: {},
  trackColorAssignments: {},
  nowPlayingSequence: 0,
  lastNowPlayingIdentity: null,
  nowPlayingInitialized: false,
  pendingExplorerSnapshot: null,
  pendingExplorerTimer: null,
  lastExplorerTimeoutRefreshTs: 0,
  explorerSnapshotTimeoutMs: 4000,
  staleExplorerDeck: false,
  deckStaleFailsafeTimer: null,
  deckStaleContext: null,
  noTrackRefreshCount: 0,
  lastExplorerPayload: null,
  pendingExplorerNext: null,
  pendingDeckHydration: false,
  audioTrackStartClock: null,
  playRetryTimer: null,
  playRetryAttempts: 0,
  forceSkipInFlight: false,
  lastForceSkipTs: 0,
  sessionBootstrapComplete: false,
  sessionBootstrapPromise: null,
  audioElementVersion: 1,
  audioElementRebuilds: 0,
  audioStallHistory: [],
  audioDeadHistory: [],
  isRenderingDeck: false,
  progressEverStarted: false,
  lastProgressDesync: null,
  lastTrackChangeGraceLog: null,
  hasSuccessfulAudioStart: false,
  audioStartupGraceUntil: 0,
  connectionQuarantineUntil: 0,
  connectionQuarantineReason: null,
  connectionQuarantineBackoffMs: CONNECTION_QUARANTINE_BASE_MS,
  hasRenderedDeck: false,

  // Playlist queue state (new explorer architecture)
  playlist: [],          // Array of {trackId, albumCover, directionKey, explorerSnapshot}

  // Session track history (for explorer exclusions)
  sessionTrackHistory: [], // Array of track IDs played in this session (most recent last)

  // Defer initial now-playing card until explorer data arrives (labels + cover + colors together)
  awaitingInitialExplorer: false
};

// Connection health management - tracks SSE and audio connection status
export const connectionHealth = {
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

// Audio health monitoring state
export const audioHealth = {
  lastTimeUpdate: null,
  bufferingStarted: null,
  isHealthy: false,
  checkInterval: null,
  handlingRestart: false,
  lastObservedTime: 0
};

// DOM element references - populated by initializeElements() after DOM ready
export const elements = {};

// Initialize DOM element references (call after DOMContentLoaded)
export function initializeElements() {
  elements.clickCatcher = document.getElementById('clickCatcher');
  elements.volumeControl = document.getElementById('volumeControl');
  elements.volumeBar = document.getElementById('volumeBar');
  elements.fullscreenProgress = document.getElementById('fullscreenProgress');
  elements.progressWipe = document.getElementById('progressWipe');
  elements.audio = document.getElementById('audio');
  elements.playbackClock = document.getElementById('playbackClock');
  elements.nowPlayingCard = document.getElementById('nowPlayingCard');
  elements.dimensionCards = document.getElementById('dimensionCards');

  if (elements.audio) {
    elements.audio.volume = 0.85;
  }
}

// Expose globals on window for backward compatibility and console debugging
if (typeof window !== 'undefined') {
  window.state = state;
  window.connectionHealth = connectionHealth;
  window.audioHealth = audioHealth;
  window.elements = elements;
  window.initializeElements = initializeElements;
}
