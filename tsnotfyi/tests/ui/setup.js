const fs = require('fs');
const path = require('path');
const jestGlobals = require('@jest/globals');
const registerAfterEach = typeof jestGlobals.afterEach === 'function'
  ? jestGlobals.afterEach
  : (typeof global.afterEach === 'function' ? global.afterEach : null);
const registerAfterAll = typeof jestGlobals.afterAll === 'function'
  ? jestGlobals.afterAll
  : (typeof global.afterAll === 'function' ? global.afterAll : null);

jest.setTimeout(15000);

const originalSetTimeout = global.setTimeout.bind(global);
const originalClearTimeout = global.clearTimeout.bind(global);
const originalSetInterval = global.setInterval.bind(global);
const originalClearInterval = global.clearInterval.bind(global);

const trackedTimeouts = new Set();
const trackedIntervals = new Set();

function trackAndWrapTimerApi() {
  global.setTimeout = (...args) => {
    const id = originalSetTimeout(...args);
    trackedTimeouts.add(id);
    return id;
  };

  global.clearTimeout = (id) => {
    trackedTimeouts.delete(id);
    return originalClearTimeout(id);
  };

  global.setInterval = (...args) => {
    const id = originalSetInterval(...args);
    trackedIntervals.add(id);
    return id;
  };

  global.clearInterval = (id) => {
    trackedIntervals.delete(id);
    return originalClearInterval(id);
  };
}

function summarizeTrackedTimers() {
  return {
    timeouts: trackedTimeouts.size,
    intervals: trackedIntervals.size
  };
}

function flushTrackedTimers(reason) {
  if (trackedIntervals.size || trackedTimeouts.size) {
    const summary = summarizeTrackedTimers();
    // eslint-disable-next-line no-console
    console.warn(`[jest-timers] clearing pending timers (${reason})`, summary);
  }
  trackedIntervals.forEach((id) => originalClearInterval(id));
  trackedIntervals.clear();
  trackedTimeouts.forEach((id) => originalClearTimeout(id));
  trackedTimeouts.clear();
}

trackAndWrapTimerApi();

if (registerAfterEach) {
  registerAfterEach(() => {
    if (trackedIntervals.size || trackedTimeouts.size) {
      const summary = summarizeTrackedTimers();
      // eslint-disable-next-line no-console
      console.warn('[jest-timers] timers still active after test', summary);
    }
  });
}

if (registerAfterAll) {
  registerAfterAll(() => {
    flushTrackedTimers('suite teardown');
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });
}

// Ensure global state shape matches what the scripts expect
window.state = window.state || {};
window.state.trackMetadataCache = window.state.trackMetadataCache || {};
window.state.selection = window.state.selection || {
  trackId: null, directionKey: null, pendingTrackId: null,
  source: null, generation: 0, setAt: null
};

// Minimal THREE stub to satisfy color helpers invoked in tools.js
class DummyThreeColor {
  constructor() {
    this.h = 0;
    this.s = 0;
    this.l = 0;
  }

  setHSL(h, s, l) {
    this.h = h;
    this.s = s;
    this.l = l;
    return this;
  }
}

window.THREE = window.THREE || { Color: DummyThreeColor };

// Provide light-weight stubs for browser APIs the legacy scripts expect
class DummyEventSource {
  constructor() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

if (typeof window.EventSource === 'undefined') {
  window.EventSource = DummyEventSource;
  global.EventSource = DummyEventSource;
}

if (typeof window.fetch === 'undefined') {
  const resolved = Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => ({}),
    text: async () => ''
  });
  const fetchStub = jest.fn(() => resolved);
  window.fetch = fetchStub;
  global.fetch = fetchStub;
}

window.requestAnimationFrame = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
window.cancelAnimationFrame = window.cancelAnimationFrame || ((id) => clearTimeout(id));
window.animateBeams = window.animateBeams || (() => {});
window.sceneInit = window.sceneInit || (() => ({
  renderer: { domElement: document.createElement('canvas') },
  scene: {},
  camera: {}
}));
window.setupFzfSearch = window.setupFzfSearch || (() => {});
window.requestSSERefresh = window.requestSSERefresh || (async () => true);

// Construct minimal DOM so page.js can grab the elements it needs without exploding
function bootstrapMinimalDom() {
  document.body.innerHTML = `
    <div id="clickCatcher"></div>
    <div id="volumeControl"><div id="volumeBar"></div></div>
    <div id="fullscreenProgress" class="fullscreen-progress">
      <div id="progressWipe"></div>
    </div>
    <audio id="audio"></audio>
    <div id="playbackClock" class="playback-clock"></div>
    <div id="nowPlayingCard"></div>
    <div id="dimensionCards"></div>
    <div id="nextTrackTray">
      <div class="next-track-tray-preview"></div>
    </div>
    <div id="beetsSegments" data-has-data="false"></div>
    <button id="refreshButton"></button>
  `;
}

function loadScript(relativePath) {
  const filePath = path.resolve(__dirname, '../../public/scripts', relativePath);
  let source = fs.readFileSync(filePath, 'utf8');
  // Strip ES module import/export statements so source can run as inline <script>
  source = source.replace(/^\s*import\s+.*?from\s+['"].*?['"];?\s*$/gm, '');
  source = source.replace(/^\s*export\s+(function|async\s+function|class|const|let|var)\s/gm, '$1 ');
  source = source.replace(/^\s*export\s+default\s+/gm, '');
  source = source.replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
  if (relativePath === 'page.js') {
    source += `
if (typeof window !== 'undefined') {
  if (typeof createDimensionCards === 'function') {
    window.createDimensionCards = createDimensionCards;
  }
  if (typeof navigateDirectionToCenter === 'function') {
    window.navigateDirectionToCenter = navigateDirectionToCenter;
  }
  if (typeof rotateCenterCardToNextPosition === 'function') {
    window.rotateCenterCardToNextPosition = rotateCenterCardToNextPosition;
  }
  if (typeof convertToNextTrackStack === 'function') {
    window.convertToNextTrackStack = convertToNextTrackStack;
  }
  if (typeof startProgressAnimationFromPosition === 'function') {
    window.startProgressAnimationFromPosition = startProgressAnimationFromPosition;
  }
  if (typeof stopProgressAnimation === 'function') {
    window.stopProgressAnimation = stopProgressAnimation;
  }
  window.__deckTestHooks = Object.assign({}, window.__deckTestHooks, {
    createDimensionCards: typeof createDimensionCards === 'function' ? createDimensionCards : undefined,
    navigateDirectionToCenter: typeof navigateDirectionToCenter === 'function' ? navigateDirectionToCenter : undefined,
    rotateCenterCardToNextPosition: typeof rotateCenterCardToNextPosition === 'function' ? rotateCenterCardToNextPosition : undefined,
    convertToNextTrackStack: typeof convertToNextTrackStack === 'function' ? convertToNextTrackStack : undefined
  });
}
`;
  }
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.textContent = source;
  document.head.appendChild(script);
}

bootstrapMinimalDom();

// Stub createLogger before loading any scripts that import from log.js
window.createLogger = window.createLogger || function(category) {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, log: noop };
};

// Auto-stub: pre-declare all function names that page.js imports from other modules.
// When ES import lines are stripped, these names become undeclared references.
// Loading the actual scripts would pull in too many browser dependencies, so we stub them.
const importedFunctions = [
  // from session-utils.js
  'applyFingerprint', 'clearFingerprint', 'waitForFingerprint', 'composeStreamEndpoint',
  'composeEventsEndpoint', 'syncEventsEndpoint', 'normalizeResolution',
  // from audio-manager.js
  'initializeAudioManager', 'setAudioCallbacks', 'startAudioHealthMonitoring',
  'updateConnectionHealthUI', 'initPCMPipeline',
  // from explorer-utils.js
  'cloneExplorerData', 'findTrackInExplorer', 'explorerContainsTrack',
  'extractNextTrackIdentifier', 'extractNextTrackDirection', 'pickPanelVariant',
  'colorsForVariant', 'consolidateDirectionsForDeck', 'normalizeSamplesToTracks',
  'resolveCanonicalDirectionKey',
  // from deck-state.js
  'setDeckStaleFlag', 'clearExplorerSnapshotTimer', 'armExplorerSnapshotTimer',
  // from deck-render.js
  'setCardVariant', 'getDeckFrameBuilder', 'runDeckFrameBuild', 'initDeckRenderWorker',
  'requestDeckRenderFrame', 'resolveTrackColorAssignment', 'cacheTrackColorAssignment',
  // from card-state.js
  'safelyExitCardsDormantState', 'ensureDeckHydratedAfterTrackChange', 'exitCardsDormantState',
  // from progress-ui.js
  'startProgressAnimation', 'clearPendingProgressStart', 'renderProgressBar', 'formatTimecode',
  'startProgressAnimationFromPosition', 'maybeApplyDeferredNextTrack', 'getVisualProgressFraction',
  'stopProgressAnimation',
  // from sync-manager.js
  'sendNextTrack', 'scheduleHeartbeat', 'fullResync', 'createNewJourneySession',
  'verifyExistingSessionOrRestart', 'requestSSERefresh', 'manualRefresh', 'setupManualRefreshButton',
  // from sse-client.js
  'connectSSE',
  // from explorer-fetch.js
  'fetchExplorer', 'fetchExplorerWithPlaylist', 'getPlaylistTrackIds',
  // from playlist-tray.js
  'addToPlaylist', 'unwindPlaylist', 'popPlaylistHead', 'getPlaylistNext',
  'playlistHasItems', 'clearPlaylist', 'initPlaylistTray', 'renderPlaylistTray',
  'promoteCenterCardToTray',
  // from clock-animation.js
  'cancelPackAwayAnimation',
  // from selection.js
  'setSelection', 'clearSelection', 'isUserSelection',
  // from helpers.js (these get defined when helpers.js loads, but list for safety)
  'renderStackedPreviews', 'packUpStackCards', 'hideDirectionKeyOverlay',
  // from other scripts loaded by index.html
  'startBeamsAnimation', 'stopBeamsAnimation',
];
for (const fn of importedFunctions) {
  if (typeof window[fn] === 'undefined') {
    window[fn] = function() {};
  }
}

// Load dependencies in the same order as the browser
loadScript('globals.js');
loadScript('selection.js');
// selection.js functions need to be on window for other scripts that import them
if (typeof window.setSelection !== 'function') {
  // If the stripped script defined them as local functions, they won't be on window.
  // Provide fallback stubs that operate on window.state.selection directly.
  window.setSelection = function(trackId, source, directionKey) {
    const s = window.state.selection;
    const isUser = source === 'user' || source === 'ack';
    if (!isUser && s.source === 'user') return s;
    window.state.selection = {
      trackId,
      directionKey: directionKey || (isUser ? null : s.directionKey),
      pendingTrackId: isUser ? trackId : s.pendingTrackId,
      source,
      generation: source === 'user' ? s.generation + 1 : s.generation,
      setAt: Date.now(),
    };
    return window.state.selection;
  };
  window.clearSelection = function(reason) {
    const s = window.state.selection;
    if (s.source === 'user') {
      const alwaysClear = ['track_change','selection_failed','error','no_track','init','audio_restart'].includes(reason);
      if (!alwaysClear) return false;
      if (reason === 'track_change' && s.setAt && (Date.now() - s.setAt) < 1500) return false;
    }
    window.state.selection = { trackId: null, directionKey: null, pendingTrackId: null,
      source: null, generation: s.generation, setAt: null };
    return true;
  };
  window.isUserSelection = function() {
    const src = window.state.selection.source;
    return src === 'user' || src === 'ack';
  };
}
loadScript('tools.js');
loadScript('helpers.js');
loadScript('deck-frame-builder.js');

// Expose helper for direct tests
if (typeof window.getDisplayTitle === 'function') {
  global.getDisplayTitle = window.getDisplayTitle;
}

// Load page.js after base helpers so we can exercise progress/clock behaviour in tests
loadScript('page.js');

window.__deckTestHooks = window.__deckTestHooks || {};
window.__deckTestHooks.forceImmediateRender = true;

// Export a convenience hook for tests needing access to the elements/state
const resolveProgressHook = () => {
  const startFn = (window.__uiTestHooks && window.__uiTestHooks.progress && window.__uiTestHooks.progress.startProgressAnimationFromPosition)
    || window.startProgressAnimationFromPosition
    || (window.__progressFns && window.__progressFns.start);
  const stopFn = (window.__uiTestHooks && window.__uiTestHooks.progress && window.__uiTestHooks.progress.stopProgressAnimation)
    || window.stopProgressAnimation
    || (window.__progressFns && window.__progressFns.stop);

  return {
    get state() {
      return window.state;
    },
    get elements() {
      return window.elements;
    },
    startProgressAnimationFromPosition: startFn,
    stopProgressAnimation: stopFn
  };
};

if (window.__uiTestHooks && window.__uiTestHooks.progress) {
  global.__progressTestHooks = resolveProgressHook();
} else {
  global.__progressTestHooks = resolveProgressHook();
}
