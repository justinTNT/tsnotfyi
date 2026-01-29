// Main page orchestrator - imports from all other modules
import { state, elements, connectionHealth, audioHealth, rootElement, PANEL_VARIANTS, debugLog, getCardBackgroundColor, initializeElements } from './globals.js';
import { applyFingerprint, clearFingerprint, waitForFingerprint, composeStreamEndpoint, composeEventsEndpoint, syncEventsEndpoint, normalizeResolution } from './session-utils.js';
import { initializeAudioManager, setAudioCallbacks, startAudioHealthMonitoring, updateConnectionHealthUI } from './audio-manager.js';
import { getDirectionType, formatDirectionName, isNegativeDirection, getOppositeDirection, hasOppositeDirection, getDirectionColor, variantFromDirectionType, hsl } from './tools.js';
import { cloneExplorerData, findTrackInExplorer, explorerContainsTrack, extractNextTrackIdentifier, extractNextTrackDirection, pickPanelVariant, colorsForVariant, consolidateDirectionsForDeck, normalizeSamplesToTracks, resolveCanonicalDirectionKey } from './explorer-utils.js';
import { setDeckStaleFlag, clearExplorerSnapshotTimer, armExplorerSnapshotTimer, clearPendingExplorerLookahead, forceApplyPendingExplorerSnapshot } from './deck-state.js';
import { setCardVariant, getDeckFrameBuilder, runDeckFrameBuild, initDeckRenderWorker, requestDeckRenderFrame, resolveTrackColorAssignment, cacheTrackColorAssignment, deckLog } from './deck-render.js';
import { safelyExitCardsDormantState, ensureDeckHydratedAfterTrackChange, exitCardsDormantState } from './card-state.js';
import { startProgressAnimation, clearPendingProgressStart, renderProgressBar, formatTimecode, startProgressAnimationFromPosition, maybeApplyDeferredNextTrack, maybeApplyPendingTrackUpdate, getVisualProgressFraction } from './progress-ui.js';
import { sendNextTrack, scheduleHeartbeat, fullResync, createNewJourneySession, verifyExistingSessionOrRestart, requestSSERefresh, manualRefresh, setupManualRefreshButton } from './sync-manager.js';
import { connectSSE } from './sse-client.js';
import { fetchExplorer, fetchExplorerWithPlaylist, getPlaylistTrackIds } from './explorer-fetch.js';
import { addToPlaylist, unwindPlaylist, popPlaylistHead, getPlaylistNext, playlistHasItems, clearPlaylist, initPlaylistTray, renderPlaylistTray } from './playlist-tray.js';
import { triggerPackAwayAnimation, checkPackAwayTrigger, cancelPackAwayAnimation, isPackAwayInProgress } from './clock-animation.js';
import { getDisplayTitle, photoStyle, renderReverseIcon, updateCardWithTrackDetails, cycleStackContents, applyDirectionStackIndicator, createNextTrackCardStack, clearStackedPreviewLayer, ensureStackedPreviewLayer, renderStackedPreviews, packUpStackCards, hideDirectionKeyOverlay, resolveOppositeBorderColor, resolveOppositeDirectionKey, redrawDimensionCardsWithNewNext, hasActualOpposite } from './helpers.js';

(function hydrateStateFromLocation() {
  state.streamUrlBase = '/stream';
  state.eventsEndpointBase = '/events';
  state.streamUrl = state.streamUrlBase;
  state.eventsEndpoint = state.eventsEndpointBase;
  window.streamUrl = state.streamUrl;
  window.eventsUrl = state.eventsEndpoint;
})();

const RADIUS_MODES = ['microscope', 'magnifying', 'binoculars'];

// Deck API references for ES module exports
let _createDimensionCards;
let _navigateDirectionToCenter;
let _rotateCenterCardToNextPosition;
let _convertToNextTrackStack;
let _prioritizeAlternateTrack;

// Explorer track lookup functions moved to explorer-utils.js

function getTrayPreviewElement() {
  if (elements.nextTrackTrayPreview && elements.nextTrackTrayPreview.isConnected) {
    return elements.nextTrackTrayPreview;
  }
  const resolved = document.querySelector('#nextTrackTray .next-track-tray-preview');
  if (resolved) {
    elements.nextTrackTrayPreview = resolved;
  }
  return resolved;
}

function demoteNextTrackCardToTray(card, onComplete = () => {}, options = {}) {
  const immediate = options.immediate === true;
  if (!card) {
    onComplete();
    return;
  }

  state.skipNextExitAnimation = true;

  if (typeof clearStackedPreviewLayer === 'function') {
    clearStackedPreviewLayer();
  }

  const skipTargetId = state.skipTrayDemotionForTrack || null;
  const datasetTrackId = card.dataset.trackMd5 || card.dataset.trackIdentifier || null;
  if (skipTargetId && datasetTrackId && skipTargetId === datasetTrackId) {
    state.skipTrayDemotionForTrack = null;
    card.remove();
    onComplete();
    return;
  }

  if (immediate) {
    card.remove();
    onComplete();
    return;
  }

  card.classList.add('card-exit');
  card.style.pointerEvents = 'none';
  card.style.willChange = 'transform, opacity';
  card.style.transition = 'transform 0.45s cubic-bezier(0.18, 0.8, 0.3, 1), opacity 0.4s ease';

  requestAnimationFrame(() => {
    card.style.transform = 'translate(-50%, -50%) translateZ(-900px) scale(0.45)';
    card.style.opacity = '0';
  });

  const cleanup = () => {
    card.removeEventListener('transitionend', handler);
    if (card.parentElement) {
      card.parentElement.removeChild(card);
    }
    onComplete();
  };

  const handler = (event) => {
    if (event.target === card) {
      cleanup();
    }
  };

  card.addEventListener('transitionend', handler);
  setTimeout(() => {
    if (card.parentElement) {
      cleanup();
    }
  }, 500);
}

// Fingerprint/session utilities moved to session-utils.js

let nextTrackPreviewFadeTimer = null;

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
      // Fallback chain: driftState > state.currentTrackDirection > manualNextDirectionKey > 'Journey'
      const currentDirectionKey = (driftState && driftState.currentDirection)
          ? driftState.currentDirection
          : (state.currentTrackDirection || state.manualNextDirectionKey || null);
      const directionText = currentDirectionKey
          ? formatDirectionName(currentDirectionKey)
          : 'Journey';
      document.getElementById('cardDirection').textContent = directionText;

      document.getElementById('cardTitle').textContent = getDisplayTitle(trackData);
      document.getElementById('cardArtist').textContent = trackData.artist || 'Unknown Artist';

      // Get album name from various possible sources
      const albumName = trackData.album
          || trackData.beetsMeta?.album?.album
          || trackData.beetsMeta?.item?.album
          || '';
      document.getElementById('cardAlbum').textContent = albumName;

      // Update visualization tubes based on track data
      updateSelectedTubes(trackData);

      const photo = document.getElementById('cardPhoto');
      // Resolve album cover with comprehensive fallback chain
      const trackId = trackData.identifier || trackData.trackMd5 || trackData.md5 || null;
      let cover = trackData.albumCover || null;

      // Fallback 1: previousNextTrack (cached when it was "next")
      if (!cover && state.previousNextTrack?.identifier === trackId && state.previousNextTrack?.albumCover) {
          cover = state.previousNextTrack.albumCover;
      }
      // Fallback 2: current explorer's nextTrack (if it matches - track just promoted)
      if (!cover && state.latestExplorerData?.nextTrack?.track?.identifier === trackId) {
          cover = state.latestExplorerData.nextTrack.track.albumCover;
      }
      // Fallback 3: current explorer's currentTrack
      if (!cover && state.latestExplorerData?.currentTrack?.identifier === trackId) {
          cover = state.latestExplorerData.currentTrack.albumCover;
      }
      // Fallback 4: search direction sampleTracks for matching track
      if (!cover && trackId && state.latestExplorerData?.directions) {
          for (const dir of Object.values(state.latestExplorerData.directions)) {
              const match = dir.sampleTracks?.find(s => (s.track?.identifier || s.identifier) === trackId);
              if (match) {
                  cover = match.track?.albumCover || match.albumCover;
                  if (cover) break;
              }
          }
      }

      if (cover) {
          // Escape single quotes in path for CSS url()
          const escapedCover = cover.replace(/'/g, "\\'");
          photo.style.background = `url('${escapedCover}')`;
          photo.style.backgroundSize = 'cover';
          photo.style.backgroundPosition = 'center';
      }

      // Resolve panel color variant based on track + direction (deterministic per track)
      const panel = document.querySelector('#nowPlayingCard .panel');
      const cardFrame = document.querySelector('#nowPlayingCard .card');
      const rim = document.querySelector('#nowPlayingCard .rim');
      // trackId already declared above for albumCover resolution
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
          // Try to get colors from previousNextTrack cache
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

          // Fallback: check if track matches explorer's nextTrack (just promoted)
          if (!assignment && state.latestExplorerData?.nextTrack?.track?.identifier === trackId) {
              const nextTrackDir = state.latestExplorerData.nextTrack.directionKey;
              if (nextTrackDir) {
                  const directionType = getDirectionType(nextTrackDir);
                  const colors = getDirectionColor(directionType, nextTrackDir);
                  assignment = {
                      variant: variantFromDirectionType(directionType),
                      border: colors.border,
                      glow: colors.glow,
                      directionKey: nextTrackDir
                  };
              }
          }

          if (!assignment) {
              assignment = resolveTrackColorAssignment(trackData, { directionKey: currentDirectionKey || null });
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

  // Initialize DOM element references (connectionHealth, audioHealth, elements defined in globals.js)
  initializeElements();

  // Setup audio manager callbacks (functions now in separate modules)
  setAudioCallbacks({
    connectSSE,
    maybeApplyPendingTrackUpdate,
    startProgressAnimationFromPosition,
    clearPendingProgressStart,
    verifyExistingSessionOrRestart,
    createNewJourneySession,
    clearFingerprint,
    composeStreamEndpoint,
    fullResync
  });

  // Initialize audio manager (attaches event listeners, sets up health monitoring)
  initializeAudioManager();

  // Reset connection health timestamps on app init
  connectionHealth.sse.lastMessage = Date.now();

  let lastProgressPhase = null;


  function ensureBaseOpacity(node) {
      if (!node) {
          return 1;
      }
      const dataset = node.dataset || {};
      if (!dataset.baseOpacity) {
          const computedOpacity = typeof window !== 'undefined'
              ? parseFloat(window.getComputedStyle(node).opacity || '1')
              : 1;
          const base = Number.isFinite(computedOpacity) ? computedOpacity : 1;
          if (node.dataset) {
              node.dataset.baseOpacity = base.toString();
          }
          return base;
      }
      const parsed = parseFloat(node.dataset.baseOpacity);
      return Number.isFinite(parsed) ? parsed : 1;
  }

  if (typeof window !== 'undefined') {
      window.updateNowPlayingCard = updateNowPlayingCard;
      window.updateRadiusControlsUI = updateRadiusControlsUI;
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

  const albumCoverCache = typeof window !== 'undefined' ? new Map() : null;
  let preloadContainer = null;
  let preloadQueue = [];
  
  function ensurePreloadContainer() {
      if (typeof document === 'undefined') {
          return null;
      }
      if (preloadContainer) {
          return preloadContainer;
      }
      const createContainer = () => {
          if (preloadContainer) return;
          const node = document.createElement('div');
          node.style.position = 'absolute';
          node.style.width = '1px';
          node.style.height = '1px';
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          node.style.zIndex = '-1';
          (document.body || document.documentElement).appendChild(node);
          preloadContainer = node;
          if (preloadQueue.length) {
              const pending = preloadQueue.slice();
              preloadQueue = [];
              pending.forEach(src => preloadImage(src));
          }
      };
      if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', createContainer, { once: true });
      } else {
          createContainer();
      }
      return preloadContainer;
  }
  
  function preloadImage(url) {
      const container = ensurePreloadContainer();
      if (!url || typeof url !== 'string' || !albumCoverCache) {
          return;
      }
  
      if (!container) {
          preloadQueue.push(url);
          return;
      }
  
      const cacheEntry = albumCoverCache.get(url);
      if (cacheEntry && cacheEntry.success === true) {
          return;
      }
  
      const img = new Image();
      img.onload = () => {
          albumCoverCache.set(url, { success: true, timestamp: Date.now() });
          if (img.parentElement) {
              img.parentElement.removeChild(img);
          }
      };
      img.onerror = () => {
          albumCoverCache.delete(url);
          if (img.parentElement) {
              img.parentElement.removeChild(img);
          }
      };
      img.src = url;
      img.style.position = 'absolute';
      img.style.width = '1px';
      img.style.height = '1px';
      img.style.opacity = '0';
      container.appendChild(img);
  }
  
  function createDimensionCards(explorerData, options = {}) {
      console.log('🔵 DIAG: createDimensionCards called', {
          trackId: explorerData?.currentTrack?.identifier,
          hasDirections: !!explorerData?.directions,
          directionCount: Object.keys(explorerData?.directions || {}).length,
          options
      });
      if (!explorerData || typeof explorerData !== 'object') {
          console.warn('⚠️ Explorer render skipped: invalid explorer data payload');
          return null;
      }

      const previousExplorerData = state.latestExplorerData;
      let skipExitAnimationSeed = options.skipExitAnimation === true || state.skipNextExitAnimation === true;
      if (!state.hasRenderedDeck) {
          skipExitAnimationSeed = true;
      }

      const beginFrame = (payload) => applyDeckRenderFrame(payload.explorerData || explorerData, options, {
          previousExplorerData,
          skipExitAnimationSeed,
          frameMeta: payload.meta || null
      });

      state.isRenderingDeck = true;
      state.pendingDeckHydration = true;
      return requestDeckRenderFrame({ explorerData })
          .then(beginFrame)
          .catch((error) => {
              console.warn('🛠️ Deck worker fallback triggered:', error);
              const fallbackFrame = runDeckFrameBuild({ explorerData }) || { explorerData };
              return beginFrame(fallbackFrame);
          })
          .finally(() => {
              state.pendingDeckHydration = false;
              state.isRenderingDeck = false;
          });
}
// Export immediately after definition so exposeDeckHelpers can find it
_createDimensionCards = createDimensionCards;
if (typeof window !== 'undefined') {
    window.createDimensionCards = createDimensionCards;
    window.__driftCreateDimensionCardsRef = createDimensionCards;
}

function applyDeckRenderFrame(explorerData, options = {}, renderContext = {}) {
      if (!explorerData || typeof explorerData !== 'object') {
          console.warn('⚠️ Explorer render skipped: invalid explorer data payload');
          return null;
      }

      const normalizeTracks = (direction) => {
          if (!direction || !Array.isArray(direction.sampleTracks)) return;
          direction.sampleTracks = direction.sampleTracks.map(entry => {
              if (!entry) {
                  return entry;
              }
              if (entry.track) {
                  return entry;
              }
              return { track: entry };
          });
          if (direction.oppositeDirection) {
              normalizeTracks(direction.oppositeDirection);
          }
      };

      const previousExplorerData = renderContext.previousExplorerData || state.latestExplorerData;
      let skipExitAnimation;
      if (typeof renderContext.skipExitAnimationSeed === 'boolean') {
          skipExitAnimation = renderContext.skipExitAnimationSeed;
      } else {
          skipExitAnimation = options.skipExitAnimation === true || state.skipNextExitAnimation === true;
      }
      if (renderContext.skipExitAnimationSeed === undefined && state.skipNextExitAnimation) {
          state.skipNextExitAnimation = false;
      }
      if (!state.hasRenderedDeck) {
          skipExitAnimation = true;
      }
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

          // Only update previousNextTrack if not exploring ahead for playlist
          if (!options.isPlaylistExploration) {
              state.previousNextTrack = {
                  identifier: previousNextId,
                  albumCover: previousNext.track?.albumCover || previousNext.albumCover,
                  variant: assignment.variant,
                  borderColor: assignment.border,
                  glowColor: assignment.glow,
                  directionKey: assignment.directionKey
              };

              cacheTrackColorAssignment(previousNextId, assignment);
          }
      }
      state.remainingCounts = {};
      const layoutEntries = {};
      const layoutTimestamp = Date.now();

      Object.values(explorerData.directions || {}).forEach(normalizeTracks);

      if (DEBUG_FLAGS.duplicates) {
          performDuplicateAnalysis(explorerData, "createDimensionCards");
      }

      const container = document.getElementById('dimensionCards');
      deckLog('🎯 Container element:', container);

      if (!container) {
          console.error('❌ NO CONTAINER ELEMENT FOUND!');
          return;
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
      console.log('🔴 DIAG: applyDeckRenderFrame BLOCKED by manualOverrideActive');
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

      if (!forceRedraw && !skipExitAnimation && previousSignature && incomingSignature && previousSignature === incomingSignature) {
          deckLog('🛑 No direction changes detected; skipping redraw');
          state.latestExplorerData = explorerData;
          refreshCardsWithNewSelection();
          return;
      }

  state.latestExplorerData = explorerData;

      // Reset reverse state when rendering fresh explorer data
      state.usingOppositeDirection = false;

      if (!skipExitAnimation) {
          const exitingCards = container.querySelectorAll('.dimension-card');
          if (exitingCards.length > 0) {
              let remaining = exitingCards.length;
              let renderScheduled = false;
              const scheduleRender = () => {
                  if (renderScheduled) return;
                  renderScheduled = true;
                  createDimensionCards(explorerData, { skipExitAnimation: true });
              };
              const fallbackTimer = setTimeout(scheduleRender, 700);

              const tryComplete = () => {
                  remaining -= 1;
                  if (remaining <= 0 && !renderScheduled) {
                      clearTimeout(fallbackTimer);
                      scheduleRender();
                  }
              };

              exitingCards.forEach(card => {
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

                  const computed = window.getComputedStyle(card);
                  const baseTransform = card.style.transform || computed.transform || '';
                  const exitTransform = baseTransform && baseTransform !== 'none'
                      ? `${baseTransform} translateZ(-1200px) scale(0.2)`
                      : 'translateZ(-1200px) scale(0.2)';

                  card.classList.add('card-exit');
                  card.style.pointerEvents = 'none';
                  card.style.willChange = 'transform, opacity';
                  card.style.transition = 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease';
                  card.style.opacity = computed.opacity || '1';

                  requestAnimationFrame(() => {
                      card.style.opacity = '0';
                      card.style.transform = exitTransform;
                  });
              });
              return;
          }
      }

      // Clear existing cards
      container.innerHTML = '';

      // Restore visibility after pack-away animation
      container.style.opacity = '';
      container.style.visibility = '';
      container.style.transform = '';
      const clockEl = document.getElementById('playbackClock');
      const nowPlayingEl = document.getElementById('nowPlayingCard');
      if (clockEl) {
          clockEl.style.opacity = '';
          clockEl.style.visibility = '';
          clockEl.style.transform = '';
      }
      if (nowPlayingEl) {
          nowPlayingEl.style.opacity = '';
          nowPlayingEl.style.visibility = '';
          nowPlayingEl.style.transform = '';
      }

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

      // Separate latent (VAE) directions from regular directions
      const latentDirections = allDirections.filter(d =>
          d.key.includes('unknown') ||
          getDirectionType(d.key) === 'latent'
      );
      const regularDirections = allDirections.filter(d => !latentDirections.includes(d));

      deckLog(`🎯 Found ${regularDirections.length} regular directions, ${latentDirections.length} latent`);

      // Apply smart limits
      let directions;
      if (latentDirections.length > 0) {
          // 11 regular + latent (up to 12 total)
          const maxRegular = Math.min(11, 12 - latentDirections.length);
          directions = regularDirections.slice(0, maxRegular).concat(latentDirections.slice(0, 12 - maxRegular));
      } else {
          // 12 regular directions if no latent
          directions = regularDirections.slice(0, 12);
      }

      deckLog(`🎯 Using ${directions.length} total directions: ${directions.length - latentDirections.length} regular + ${latentDirections.length} latent`);
      const consolidationResult = consolidateDirectionsForDeck(directions);
      if (consolidationResult) {
          directions = consolidationResult.directions;
          state.directionKeyAliases = consolidationResult.aliasMap || {};
          if (Object.keys(state.directionKeyAliases).length > 0) {
              deckLog(`♻️ Collapsed polarity duplicates`, state.directionKeyAliases);
          }
      } else {
          state.directionKeyAliases = {};
      }

      if (directions.length === 0) {
          console.error(`❌ NO DIRECTIONS TO DISPLAY!`);
          console.error(`❌ All directions:`, allDirections);
          console.error(`❌ Explorer data:`, explorerData);
          return;
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

      // Create ALL directions as clock-positioned direction cards first
      directions.forEach((direction, index) => {
          // Use hasActualOpposite to verify there are distinct tracks in the opposite direction
          const hasReverse = hasActualOpposite(direction, direction.key);
          const tracks = direction.sampleTracks || [];
          const trackCount = tracks.length;
          for (const t of tracks) preloadImage(t.albumCover);

          const oppositeTracks = direction.oppositeDirection?.sampleTracks || [];
          if (hasReverse) {
              for (const t of oppositeTracks) preloadImage(t.albumCover);
          }
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

              const directionType = card.dataset.directionType || getDirectionType(direction.key);
              const colorVariant = card.dataset.colorVariant
                  || (typeof variantFromDirectionType === 'function' ? variantFromDirectionType(directionType) : null);
              layoutEntries[direction.key] = {
                  key: direction.key,
                  domain: direction.domain || null,
                  directionType,
                  colorVariant,
                  directionValue: direction.direction || direction.key,
                  sampleTracks: normalizeSamplesToTracks(direction.sampleTracks || []),
                  oppositeTracks: normalizeSamplesToTracks(direction.oppositeDirection?.sampleTracks || []),
                  hasOpposite: Boolean(hasReverse),
                  oppositeKey: direction.oppositeDirection?.key || getOppositeDirection(direction.key) || null,
                  isOutlier: Boolean(direction.isOutlier),
                  clockPosition: card.dataset.clockPosition ? parseInt(card.dataset.clockPosition, 10) : null,
                  originalClockPosition: card.dataset.originalClockPosition ? parseInt(card.dataset.originalClockPosition, 10) : null,
                  borderColor: card.dataset.borderColor || card.style.getPropertyValue('--border-color') || null,
                  glowColor: card.dataset.glowColor || card.style.getPropertyValue('--glow-color') || null,
                  label: direction.isOutlier ? 'Outlier' : formatDirectionName(direction.key),
                  stackSize: trackCount,
                  lastUpdated: layoutTimestamp,
                  isCenter: false
              };

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

      // After all cards are visible, animate the selected next track to center
      if (state.nextTrackAnimationTimer) {
          clearTimeout(state.nextTrackAnimationTimer);
          state.nextTrackAnimationTimer = null;
      }

      // Cards appear instantly now (stagger is disabled), so use short delay for paint/CSS
      const animationDelay = 150;
      state.nextTrackAnimationTimer = setTimeout(() => {
          if (explorerData.nextTrack) {
              animateDirectionToCenter(explorerData.nextTrack.directionKey);
          }
          state.nextTrackAnimationTimer = null;
      }, animationDelay);

      deckLog(`🎯 FINISHED creating ${cardsCreated} cards in container`);
      state.hasRenderedDeck = cardsCreated > 0;
      state.directionLayout = layoutEntries;
      if (typeof window !== 'undefined') {
          window.__lastDirectionLayout = layoutEntries;
      }

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
              showNextTrackPreview(info.track);
          }
      }
  }


  // Swap the roles: make a direction the new next track stack, demote current next track to regular direction
  function swapNextTrackDirection(newNextDirectionKey) {
      if (!state.latestExplorerData || !state.latestExplorerData.directions[newNextDirectionKey]) {
          console.error('Cannot swap to direction:', newNextDirectionKey);
          return;
      }

      deckLog(`🔄 Swapping next track direction from ${state.latestExplorerData.nextTrack?.directionKey} to ${newNextDirectionKey}`);

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
          console.error(`${ICON} ACTION selection-card-missing`, {
              selection: state.selectedIdentifier,
              availableCards: Array.from(allTrackCards).map(card => ({
                  direction: card.dataset.directionKey,
                  track: card.dataset.trackMd5
              }))
          });
          return;
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
              const resolvedAlbum = track.album || track.beetsMeta?.album?.album || track.beetsMeta?.item?.album || card.dataset.trackAlbum || '';

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
      state.streamUrl = streamUrl;
      window.streamUrl = streamUrl;
      console.log(`🎵 Audio connecting to ${streamUrl}`);

      startAudioHealthMonitoring();
      audioHealth.isHealthy = false;
      audioHealth.lastTimeUpdate = null;
      audioHealth.bufferingStarted = Date.now();

      connectionHealth.audio.status = 'connecting';
      updateConnectionHealthUI();

      elements.audio.src = streamUrl;
      elements.audio.load();
      state.awaitingSSE = true;

      elements.audio.play()
        .then(() => {
          connectionHealth.audio.status = 'connected';
          connectionHealth.audio.reconnectAttempts = 0;
          connectionHealth.audio.reconnectDelay = 2000;
          updateConnectionHealthUI();
        })
        .catch(e => {
          console.error('🎵 Play failed:', e);
          console.error('🎵 Audio state when play failed:', {
              error: elements.audio.error,
              networkState: elements.audio.networkState,
              readyState: elements.audio.readyState,
              src: elements.audio.src
          });
          connectionHealth.audio.status = 'error';
          updateConnectionHealthUI();
          if (!connectionHealth.currentEventSource) {
              window.connectSSE();
          }
        });
  }

  // Click to start
  if (elements.clickCatcher) {
    elements.clickCatcher.addEventListener('click', startAudio);
  }

  // Handle window resize for force layout
  window.addEventListener('resize', () => {
      if (state.forceLayout) {
          state.forceLayout.resizeContainer();
      }
  });

  // Keep manual start - do not auto-start
  if (elements.audio) {
    elements.audio.addEventListener('canplay', () => {
        if (state.isStarted) return;
        // User prefers manual click-to-start
    });
  }

  // Volume control
  if (elements.volumeControl) {
    elements.volumeControl.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = elements.volumeControl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const percent = 1 - (y / rect.height);
        const volume = Math.max(0, Math.min(1, percent));

        if (elements.audio) elements.audio.volume = volume;
        if (elements.volumeBar) elements.volumeBar.style.height = (volume * 100) + '%';
    });
  }

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

          case 'ArrowRight': // rotate the wheel clockwise
              for (let i = nextPosition + 1; i <= nextPosition + 12; i++) {
                  const posFromIndex = (i+11)%12+1;
                  if (occupiedPositions.has(posFromIndex)) {
                      nextPosition = posFromIndex;
                      break;
                  }
	      }

              swapNextTrackDirection(clockCards[nextPosition - 1].key);
              e.preventDefault();
              break;

          case 'ArrowLeft': // rotate the wheel counter-clockwise
              for (let i = nextPosition-1; i >= nextPosition - 12; i--) {
                  const posFromIndex = (i-1)%12 + 1;
                  if (occupiedPositions.has(posFromIndex)) {
                      nextPosition = posFromIndex;
                      break;
                  }
              }

              swapNextTrackDirection(clockCards[nextPosition - 1].key);
              e.preventDefault();
              break;

          case 'ArrowDown':
              // deal another card from the pack
              const directionKey =  state.latestExplorerData.nextTrack.directionKey;
              cycleStackContents(directionKey, state.stackIndex);
              e.preventDefault();
              break;

          case 'ArrowUp':
              // flip a reversable next track stack

                  const key =  state.latestExplorerData.nextTrack.directionKey;
                  const currentDirection = state.latestExplorerData.directions[key];
                  if (currentDirection && currentDirection.oppositeDirection) {
                      // Temporarily add the opposite direction to SSE data for swapping
                      const oppositeKey = getOppositeDirection(key);
                      if (oppositeKey) {
                          state.latestExplorerData.directions[oppositeKey] = {
                              ...currentDirection.oppositeDirection,
                              key: oppositeKey
                          };

                          // Swap stack contents immediately without animation
                          swapStackContents(key, oppositeKey);
                      }
                  } else {
                      console.warn(`Opposite direction not available for ${direction.key}`);
                  }
              e.preventDefault();
              break;

          case 'Escape':
              // Unwind playlist (same as clicking right pile in tray)
              if (typeof window.unwindPlaylist === 'function') {
                  const unwound = window.unwindPlaylist();
                  if (unwound && unwound.explorerData) {
                      // Display cached explorer data instantly
                      if (typeof window.createDimensionCards === 'function') {
                          window.createDimensionCards(unwound.explorerData, { skipExitAnimation: true });
                      }
                  }
              }
              e.preventDefault();
              break;

          case 'Enter':
              // Promote center card to playlist (same as clicking left pile in tray)
              if (typeof window.promoteCenterCardToTray === 'function') {
                  window.promoteCenterCardToTray();
              }
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
                                      const trackId = data.trackId || state.latestCurrentTrack?.identifier || null;
                                      startProgressAnimationFromPosition(data.newDuration, data.currentPosition, { resync: true, trackId });

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

      }
  });

  animateBeams(sceneInit());

  if (elements.audio) elements.audio.addEventListener('play', () => {
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


function showNextTrackPreview(track, options = {}) {
      if (!elements.nextTrackPreview || !elements.nextTrackPreviewImage) {
          return;
      }

      const cover = track?.albumCover || track?.cover || null;
      if (!cover) {
          hideNextTrackPreview({ immediate: true });
          return;
      }

      const trackId = track?.identifier || null;
      if (state.nextTrackPreviewTrackId === trackId && elements.nextTrackPreview.classList.contains('visible')) {
          return;
      }

      if (nextTrackPreviewFadeTimer) {
          clearTimeout(nextTrackPreviewFadeTimer);
          nextTrackPreviewFadeTimer = null;
      }

    if (elements.nextTrackPreviewImage.src !== cover) {
        elements.nextTrackPreviewImage.src = cover;
    }

    elements.nextTrackPreview.classList.remove('fade-out');
    elements.nextTrackPreview.classList.add('visible');
    state.nextTrackPreviewTrackId = trackId;
    state.trayPreviewState = {
        trackId,
        directionKey: options.directionKey || track.directionKey || null,
        title: getDisplayTitle(track) || '',
        artist: track?.artist || ''
    };
}

function hideNextTrackPreview({ immediate = false } = {}) {
    if (!elements.nextTrackPreview) {
        return;
    }

    if (nextTrackPreviewFadeTimer) {
        clearTimeout(nextTrackPreviewFadeTimer);
        nextTrackPreviewFadeTimer = null;
    }

    if (immediate) {
        elements.nextTrackPreview.classList.remove('visible', 'fade-out');
        if (elements.nextTrackPreviewImage) {
            elements.nextTrackPreviewImage.src = '';
        }
        state.nextTrackPreviewTrackId = null;
        state.trayPreviewState = null;
        return;
    }

    if (!elements.nextTrackPreview.classList.contains('visible')) {
        state.nextTrackPreviewTrackId = null;
        return;
    }

    elements.nextTrackPreview.classList.add('fade-out');
    nextTrackPreviewFadeTimer = setTimeout(() => {
        elements.nextTrackPreview.classList.remove('visible', 'fade-out');
        if (elements.nextTrackPreviewImage) {
            elements.nextTrackPreviewImage.src = '';
        }
        nextTrackPreviewFadeTimer = null;
        state.nextTrackPreviewTrackId = null;
        state.trayPreviewState = null;
    }, 600);
}

function updatePlaylistTrayPreview({ immediate = false } = {}) {
    const trayInfo = resolveNextTrackData();
    const trayTrack = trayInfo?.track || null;
    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (trayRoot) {
        elements.nextTrackTray = trayRoot;
    }

    if (!trayTrack) {
        hideNextTrackPreview({ immediate: true });
        trayRoot?.classList.remove('has-track');
        return;
    }

    showNextTrackPreview(trayTrack, { directionKey: trayInfo.directionKey || null });
    trayRoot?.classList.add('has-track');
}

function resolveTrackIdentifier(trackLike) {
    if (!trackLike || typeof trackLike !== 'object') {
        return null;
    }
    return trackLike.identifier || trackLike.trackMd5 || trackLike.md5 || null;
}

function recordPendingLiveTrackCandidate(trackDetails, driftState, context = {}) {
    if (!trackDetails || typeof trackDetails !== 'object') {
        return;
    }
    const identifier = resolveTrackIdentifier(trackDetails);
    if (!identifier) {
        return;
    }

    const snapshot = { ...trackDetails };
    state.pendingLiveTrackCandidate = {
        track: snapshot,
        driftState: driftState || null,
        lockedAt: Date.now(),
        context
    };
    if (typeof window !== 'undefined') {
        window.state = window.state || {};
        window.state.pendingLiveTrackCandidate = state.pendingLiveTrackCandidate;
    }
    console.log('📌 Pending now-playing candidate locked', {
        trackId: identifier,
        direction: driftState?.currentDirection || null,
        context,
        snapshotKeys: Object.keys(snapshot || {})
    });
}

function adoptPendingLiveTrackCandidate(trackDetails, fallbackDriftState = null) {
    const pending = state.pendingLiveTrackCandidate;
    if (!trackDetails || !pending || !pending.track) {
        return { driftState: fallbackDriftState || null, adopted: false };
    }
    const currentId = resolveTrackIdentifier(trackDetails);
    const pendingId = resolveTrackIdentifier(pending.track);
    if (!currentId || !pendingId || currentId !== pendingId) {
        return { driftState: fallbackDriftState || null, adopted: false };
    }

    const driftState = pending.driftState || fallbackDriftState || null;
    console.log('📌 Pending now-playing candidate applied', {
        trackId: currentId,
        lockedForMs: pending.lockedAt ? Date.now() - pending.lockedAt : null,
        context: pending.context || null
    });
    state.pendingLiveTrackCandidate = null;
    if (typeof window !== 'undefined' && window.state) {
        window.state.pendingLiveTrackCandidate = null;
    }
    updatePlaylistTrayPreview();
    updatePlaylistTrayPreview();
    return { driftState, adopted: true };
}



// Exports for sse-client.js
if (typeof window !== 'undefined') {
  window.updatePlaylistTrayPreview = updatePlaylistTrayPreview;
  window.resolveTrackIdentifier = resolveTrackIdentifier;
  window.recordPendingLiveTrackCandidate = recordPendingLiveTrackCandidate;
  window.adoptPendingLiveTrackCandidate = adoptPendingLiveTrackCandidate;
}

// ====== Activity Management ======
  // Card interactions are always enabled - server handles track selection arbitration
  let lastActivityTime = Date.now();

  function markActivity() {
      lastActivityTime = Date.now();
      exitCardsDormantState();

      // Bring cards back to active state
      const directionCards = document.querySelectorAll('.dimension-card:not(.track-detail-card)');
      directionCards.forEach(card => {
          card.classList.remove('inactive-tilt');
          card.classList.add('active');
      });
  }

  // Activity detection events
  ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'].forEach(event => {
      document.addEventListener(event, markActivity, { passive: true });
  });

  // Initialize activity tracking
  markActivity();

  function resetProgressAndDeck(reason = 'manual') {
      console.warn(`🧹 Forcing deck recovery (${reason})`);
      if (typeof window.stopProgressAnimation === 'function') {
          window.stopProgressAnimation();
      }
      state.usingOppositeDirection = false;
      state.lastProgressDesync = null;
      state.progressEverStarted = false;
      clearReversePreference();
      window.safelyExitCardsDormantState({ immediate: true });
      markActivity();
  }

  console.log('🚢 Awaiting audio start to establish session.');


  // Swap stack contents between current and opposite direction
  function swapStackContents(currentDimensionKey, oppositeDimensionKey) {
      // Toggle the simple opposite direction flag
      state.usingOppositeDirection = !state.usingOppositeDirection;

      // Reset track index when flipping to opposite direction
      state.stackIndex = 0;

      // Determine base/opposite keys from state and current card metadata
      const centerCard = document.querySelector('.dimension-card.next-track');
      const storedBaseKey = centerCard?.dataset?.baseDirectionKey || null;
      const storedOppositeKey = centerCard?.dataset?.oppositeDirectionKey || null;

      const baseKey = state.baseDirectionKey || storedBaseKey || currentDimensionKey;
      const oppositeHint = storedOppositeKey
          || oppositeDimensionKey
          || state.currentOppositeDirectionKey
          || getOppositeDirection(baseKey);

      redrawNextTrackStack(baseKey, { oppositeKey: oppositeHint });
  }

  window.swapStackContents = swapStackContents;

  function prioritizeAlternateTrack(samples, excludeTrackId) {
      if (!Array.isArray(samples) || samples.length < 2 || !excludeTrackId) {
          return samples;
      }
      const normalized = samples.map((entry, index) => ({
          index,
          track: entry?.track || entry || null
      }));
      const alternate = normalized.find(item => item.track && item.track.identifier && item.track.identifier !== excludeTrackId);
      if (!alternate || alternate.index === 0) {
          return samples;
      }
      const [entry] = samples.splice(alternate.index, 1);
      samples.unshift(entry);
      return samples;
  }

_prioritizeAlternateTrack = prioritizeAlternateTrack;
if (typeof window !== 'undefined') {
    window.prioritizeAlternateTrack = prioritizeAlternateTrack;
}

  // Redraw the next track stack respecting the reverse flag
  function redrawNextTrackStack(specifiedDimensionKey = null, options = {}) {
      if (!state.latestExplorerData?.nextTrack) return;

      const forcedOppositeKey = options?.oppositeKey || null;

      const baseDimensionKey = specifiedDimensionKey
          || state.baseDirectionKey
          || state.latestExplorerData.nextTrack.directionKey;
      state.baseDirectionKey = baseDimensionKey;
      const baseDirection = state.latestExplorerData.directions[baseDimensionKey];

      const embeddedOppositeKey = baseDirection?.oppositeDirection?.key
          || baseDirection?.oppositeDirection?.direction
          || null;
      const fallbackOppositeKey =
          state.currentOppositeDirectionKey
          || embeddedOppositeKey
          || getOppositeDirection(baseDimensionKey)
          || null;
      let resolvedOppositeKey = fallbackOppositeKey;

      let displayDimensionKey;
      let displayDirection;

      if (state.usingOppositeDirection) {
          displayDimensionKey = forcedOppositeKey || fallbackOppositeKey;
          displayDirection = displayDimensionKey ? state.latestExplorerData.directions[displayDimensionKey] : null;

          if (baseDirection?.oppositeDirection) {
              displayDirection = baseDirection.oppositeDirection;
              displayDirection.hasOpposite = true;
              displayDimensionKey = baseDirection.oppositeDirection.key
                  || baseDirection.oppositeDirection.direction
                  || displayDimensionKey
                  || resolvedOppositeKey
                  || getOppositeDirection(baseDimensionKey);
          } else if (!displayDirection) {
              const searchKey = displayDimensionKey || resolvedOppositeKey || getOppositeDirection(baseDimensionKey);
              console.warn(`🔄 Opposite direction ${searchKey} missing in top-level list; searching embedded data`);

              for (const [dirKey, dirData] of Object.entries(state.latestExplorerData.directions)) {
                  if (dirData.oppositeDirection?.key === searchKey || dirData.oppositeDirection?.direction === searchKey) {
                      displayDirection = dirData.oppositeDirection;
                      displayDimensionKey = searchKey;
                      break;
                  }
              }

              if (!displayDirection) {
                  console.error(`🔄 No opposite direction data available for ${baseDimensionKey}`);
                  return;
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
                      if (!resolvedOppositeKey) {
                          resolvedOppositeKey = dirKey;
                      }
                      break;
                  }
              }
          }

          if (!displayDirection) {
              console.error(`🔄 No direction data found for ${baseDimensionKey}`);
              return;
          }

          resolvedOppositeKey = fallbackOppositeKey;
      }

      if (!displayDirection) {
          console.error(`🔄 Could not resolve direction data for ${state.usingOppositeDirection ? 'opposite' : 'base'} stack`, {
              baseDimensionKey,
              resolvedOppositeKey,
              available: Object.keys(state.latestExplorerData.directions || {})
          });
          return;
      }

      state.currentOppositeDirectionKey = resolvedOppositeKey;

      const currentCard = document.querySelector('.dimension-card.next-track');
      if (!currentCard) {
          console.error('🔄 Could not find current next-track card');
          return;
      }

      currentCard.dataset.baseDirectionKey = baseDimensionKey;
      if (resolvedOppositeKey) {
          currentCard.dataset.oppositeDirectionKey = resolvedOppositeKey;
      } else {
          delete currentCard.dataset.oppositeDirectionKey;
      }

      const displayTracks = (displayDirection.sampleTracks || []).map(entry => entry.track || entry);
      if (displayTracks.length === 0) {
          console.error(`🔄 No tracks found for direction ${displayDimensionKey}`);
          return;
      }

      const trackToShow = displayTracks[0];

      state.stackIndex = 0;
      state.selectedIdentifier = trackToShow.identifier;

      sendNextTrack(trackToShow.identifier, displayDimensionKey, 'user');

      delete currentCard.dataset.originalBorderColor;
      delete currentCard.dataset.originalGlowColor;
      delete currentCard.dataset.borderColor;
      delete currentCard.dataset.glowColor;

      displayDirection.key = displayDimensionKey;

      currentCard.dataset.directionKey = displayDimensionKey;

      if (state.usingOppositeDirection) {
          currentCard.dataset.oppositeDirectionKey = displayDimensionKey;
      }

      currentCard.style.removeProperty('--border-color');
      currentCard.style.removeProperty('--glow-color');
      currentCard.dataset.directionType = getDirectionType(displayDimensionKey);

      updateCardWithTrackDetails(currentCard, trackToShow, displayDirection, false, swapStackContents);
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
          const fallbackCard = oppositeKey ? document.querySelector(`[data-direction-key="${oppositeKey}"]`) : null;
          if (fallbackCard) {
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

      // Transform this direction card into a next-track stack
      card.classList.add('next-track', 'track-detail-card', 'animating-to-center');
      if (!card.dataset.originalDirectionKey) {
          card.dataset.originalDirectionKey = directionKey;
      }
      if (typeof hideStackSizeIndicator === 'function') {
          hideStackSizeIndicator(card);
      }

      // Set trackMd5 immediately so heartbeats can find the card during animation
      const direction = state.latestExplorerData?.directions?.[directionKey];
      const sampleTracks = direction?.sampleTracks || [];
      const primarySample = sampleTracks[0];
      const primaryTrack = primarySample?.track || primarySample;
      if (primaryTrack?.identifier) {
          card.dataset.trackMd5 = primaryTrack.identifier;
          state.selectedIdentifier = primaryTrack.identifier;
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
      const availablePositions = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9 ];
      let clockPosition = availablePositions[index];

      // Store position for animation return
      card.dataset.clockPosition = clockPosition;
      card.dataset.originalClockPosition = clockPosition; // Remember original position

      // Get direction type and assign colors
      const directionType = getDirectionType(direction.key);
      const colors = getDirectionColor(directionType, direction.key);
      const colorVariant = variantFromDirectionType(directionType);

      // Store direction type and colors for consistent coloring
      card.dataset.directionType = directionType;
      card.dataset.borderColor = colors.border;
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
          const track = nextTrackData.track;

          const albumName = track.album
              || track.beetsMeta?.album?.album
              || track.beetsMeta?.item?.album
              || '';

          const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);
          labelContent = `
              <h2>${directionName}</h2>
              <h3>${getDisplayTitle(track)}</h3>
              <h4>${track.artist || 'Unknown Artist'}</h4>
              <h5>${albumName}</h5>
          `;
      } else {
          // Check if this is an outlier direction - use "Outlier" label instead of direction name
          const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);
          labelContent = `<div class="dimension-label">${directionName}</div>`;
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
              // Check if clicking on the reverse icon - if so, don't swap roles
              if (e.target.closest('.uno-reverse')) {
                  return; // Let the reverse icon handle its own behavior
              }

              // Find any existing next track card (more reliable than using latestExplorerData)
              const existingNextTrackCard = document.querySelector('.dimension-card.next-track');

              if (!existingNextTrackCard) {
                  // No existing next track, animate directly to center
                  state.usingOppositeDirection = false; // Reset reverse flag when selecting new direction
                  animateDirectionToCenter(direction.key);
              } else {
                  // Check if this card represents the same base dimension (ignoring polarity)
                  const currentCardDirection = existingNextTrackCard.dataset.directionKey;
                     const baseCurrentDirection = currentCardDirection.replace(/_positive$|_negative$/, '');
                     const baseClickedDirection = direction.key.replace(/_positive$|_negative$/, '');
                     const isSameDimension = baseCurrentDirection === baseClickedDirection || currentCardDirection === direction.key;

                     if (isSameDimension) {
                         // it's already there so start cycling through the deck
                         // Determine which tracks to cycle through based on reverse flag
                         let tracksToUse, dimensionToShow;
                         if (state.usingOppositeDirection && direction.oppositeDirection?.sampleTracks) {
                             tracksToUse = direction.oppositeDirection.sampleTracks;
                             dimensionToShow = direction.oppositeDirection;
                         } else {
                             tracksToUse = direction.sampleTracks;
                             dimensionToShow = direction;
                         }

                         // Cycle the appropriate tracks
                         tracksToUse.push(tracksToUse.shift());
                         const track = tracksToUse[0].track || tracksToUse[0];
                         updateCardWithTrackDetails(card, track, dimensionToShow, true, swapStackContents);
                      } else {
                          // Pack up stack cards first, then rotate and animate
                          packUpStackCards().then(() => {
                              rotateCenterCardToNextPosition(existingNextTrackCard.dataset.directionKey);
                              // Wait for the rotation animation to complete before starting the new one
                              setTimeout(() => {
                                  state.usingOppositeDirection = false; // Reset reverse flag when selecting new direction
                                  animateDirectionToCenter(direction.key);
                              }, 400); // Half the animation time for smoother transition
                          });
                      }
                  }

                  // Only tell server if playlist is empty (immediate selection needed)
                  // Otherwise, track will be queued and server notified via playlist
                  if (!playlistHasItems()) {
                      const track = direction.sampleTracks[0].track || direction.sampleTracks[0];
                      sendNextTrack(track.identifier, direction.key, 'user');
                  }
          });
      }

      return card;
  }

  // Rotate center card to next available clock position (circular rotation system)
  function rotateCenterCardToNextPosition(directionKey) {
      const card = document.querySelector(`[data-direction-key="${directionKey}"].next-track`);
      if (!card) return;

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

      // Find first available empty position on the clock face
      const occupiedPositions = new Set(clockCards.map(c => c.position));

      // Check if we should try to return to the original position first
      const originalPosition = card.dataset.originalClockPosition ? parseInt(card.dataset.originalClockPosition) : null;

      let nextPosition = 1;
      if (originalPosition && !occupiedPositions.has(originalPosition)) {
          // Return to original position if it's available
          nextPosition = originalPosition;
      } else {
          // Find first available gap in positions 1-12 (preferring non-outlier positions)
          const availablePositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]; // Check 11 (outlier) last
          for (const pos of availablePositions) {
              if (!occupiedPositions.has(pos)) {
                  nextPosition = pos;
                  break;
              }
          }
      }

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
          resetCardToDirectionDisplay(card, card.dataset.originalDirectionKey || directionKey);

          card.style.transition = '';
      }, 800);
  }
_rotateCenterCardToNextPosition = rotateCenterCardToNextPosition;
if (typeof window !== 'undefined') {
    window.rotateCenterCardToNextPosition = rotateCenterCardToNextPosition;
}

  // Reset a card back to simple direction display (when moving from center to clock position)
  function resetCardToDirectionDisplay(card, directionKey) {
      // Reset reverse state and restore original face
      card.classList.remove('track-detail-card');

      const lingeringStackVisual = card.querySelector('.stack-line-visual');
      if (lingeringStackVisual) {
          lingeringStackVisual.remove();
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
                  break;
              }
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
      }

      const intrinsicNegative = isNegativeDirection(resolvedKey);
      card.classList.toggle('negative-direction', intrinsicNegative);

      // Reset to simple direction content (direction label only, no track title)
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

      // Only show reverse icon if there are actual distinct tracks in the opposite direction
      if (typeof renderReverseIcon === 'function' && typeof hasActualOpposite === 'function') {
          const hasDistinctOpposite = hasActualOpposite(direction, resolvedKey);
          if (hasDistinctOpposite) {
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
              direction.hasOpposite = true;
          } else {
              delete card.dataset.oppositeBorderColor;
              direction.hasOpposite = false;
          }
      }

      if (typeof applyDirectionStackIndicator === 'function') {
          applyDirectionStackIndicator(direction, card);
      }

      if (state.baseDirectionKey === directionKey || state.baseDirectionKey === resolvedKey) {
          state.baseDirectionKey = null;
      }
      if (!document.querySelector('.dimension-card.next-track')) {
          state.currentOppositeDirectionKey = null;
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

  if (typeof window !== 'undefined') {
    window.resolveNextTrackData = resolveNextTrackData;
  }

  // Convert a direction card into a next track stack (add track details and indicators)
  function convertToNextTrackStack(directionKey) {
      let directionData = state.latestExplorerData?.directions[directionKey];
      let actualDirectionKey = directionKey;

      if (!directionData) {
          const oppositeKey = getOppositeDirection(directionKey);
          if (oppositeKey && state.latestExplorerData?.directions[oppositeKey]) {
              directionData = state.latestExplorerData.directions[oppositeKey];
              actualDirectionKey = oppositeKey;
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

      const direction = directionData;
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

      state.baseDirectionKey = actualDirectionKey;
      const computedOppositeKey = direction.oppositeDirection?.key
          || direction.oppositeDirection?.direction
          || getOppositeDirection(actualDirectionKey)
          || null;
      state.currentOppositeDirectionKey = computedOppositeKey;

      let card = document.querySelector(`[data-direction-key="${actualDirectionKey}"]`);
      if (!card) {
          const fallbackKey = findDirectionKeyContainingTrack(state.latestExplorerData, (sampleTracks[0]?.track || sampleTracks[0])?.identifier);
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

      const primarySample = sampleTracks[0] || {};
      const selectedTrack = primarySample.track || primarySample;

      updateCardWithTrackDetails(card, selectedTrack, direction, true, swapStackContents);

      if (state.cardsDormant) {
          showNextTrackPreview(selectedTrack);
      }

      // Stack depth indication is now handled via CSS pseudo-elements on the main card
  }
_convertToNextTrackStack = convertToNextTrackStack;
if (typeof window !== 'undefined') {
    window.convertToNextTrackStack = convertToNextTrackStack;
}

  // Periodic status check (optional, for monitoring)
  setInterval(() => {
    fetch('/status').catch(() => {});
  }, 30000);

  function navigateDirectionToCenter(newDirectionKey) {
      const canonicalDirectionKey = resolveCanonicalDirectionKey(newDirectionKey);
      if (!state.latestExplorerData || !state.latestExplorerData.directions) {
          console.warn('Cannot navigate directions: explorer data missing');
          return;
      }

      const direction = state.latestExplorerData.directions[canonicalDirectionKey];
      if (!direction) {
          console.warn('Cannot navigate: direction not found', canonicalDirectionKey);
          return;
      }

      const sampleTracks = direction.sampleTracks || [];
      const primaryEntry = sampleTracks[0];
      const primaryTrack = primaryEntry ? (primaryEntry.track || primaryEntry) : null;
      if (!primaryTrack || !primaryTrack.identifier) {
          console.warn('Cannot navigate: direction has no primary track', canonicalDirectionKey);
          return;
      }

      const currentCenterKey = resolveCanonicalDirectionKey(state.latestExplorerData?.nextTrack?.directionKey || null);
      if (currentCenterKey && currentCenterKey === canonicalDirectionKey) {
          cycleStackContents(canonicalDirectionKey, state.stackIndex);
          return;
      }

      const performPromotion = () => {
          state.selectedIdentifier = primaryTrack.identifier;
          state.stackIndex = 0;
          state.pendingManualTrackId = primaryTrack.identifier;
          state.manualSelectionPending = true;
          state.manualNextTrackOverride = false;
          state.skipTrayDemotionForTrack = null;
          state.manualNextDirectionKey = canonicalDirectionKey;
          state.pendingSnapshotTrackId = primaryTrack.identifier;

          if (!state.remainingCounts) {
              state.remainingCounts = {};
          }
          state.remainingCounts[canonicalDirectionKey] = Math.max(0, sampleTracks.length - 1);

          state.latestExplorerData.nextTrack = {
              directionKey: canonicalDirectionKey,
              direction: direction.direction,
              track: primaryTrack
          };

          state.usingOppositeDirection = false;
          const selectionOptions = {
              origin: 'deck',
              notifyServer: true,
              explorerSignature: state.lastDirectionSignature
          };

          if (typeof animateDirectionToCenter === 'function') {
              animateDirectionToCenter(canonicalDirectionKey, selectionOptions);
          } else {
              convertToNextTrackStack(canonicalDirectionKey, selectionOptions);
          }

          sendNextTrack(primaryTrack.identifier, canonicalDirectionKey, {
              source: 'user',
              origin: 'deck',
              explorerSignature: state.lastDirectionSignature
          });
      };

      // Pack up stack cards, then rotate existing center out, then promote new one
      if (currentCenterKey && currentCenterKey !== canonicalDirectionKey && typeof rotateCenterCardToNextPosition === 'function') {
          packUpStackCards().then(() => {
              rotateCenterCardToNextPosition(currentCenterKey);
              setTimeout(performPromotion, 400);
          });
      } else {
          performPromotion();
      }

      tryFlushPendingCenterPromotion();
  }

_navigateDirectionToCenter = navigateDirectionToCenter;
if (typeof window !== 'undefined') {
    window.navigateDirectionToCenter = navigateDirectionToCenter;
}

  function queueCenterPromotion(directionKey, options = {}) {
      const canonicalKey = resolveCanonicalDirectionKey(directionKey);
      if (!canonicalKey) {
          return;
      }

      state.pendingCenterPromotionKey = canonicalKey;
      state.pendingCenterPromotionOptions = { ...options };

      tryFlushPendingCenterPromotion();
  }

  function tryFlushPendingCenterPromotion() {
      if (!state.pendingCenterPromotionKey) {
          return;
      }

      if (!state.nowPlayingInitialized || !state.latestCurrentTrack?.identifier) {
          return;
      }

      const directionKey = resolveCanonicalDirectionKey(state.pendingCenterPromotionKey);
      const options = state.pendingCenterPromotionOptions || {};
      state.pendingCenterPromotionKey = null;
      state.pendingCenterPromotionOptions = null;

      if (state.nextTrackAnimationTimer) {
          clearTimeout(state.nextTrackAnimationTimer);
          state.nextTrackAnimationTimer = null;
      }

      const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');

      state.nextTrackAnimationTimer = setTimeout(() => {
          const candidateCard = deckContainer
              ? deckContainer.querySelector(`[data-direction-key="${directionKey}"]`)
              : null;
          if (candidateCard) {
              deckLog(`🎯 Animating ${directionKey} to center as next track (queued)`);
              animateDirectionToCenter(directionKey, options);
          } else {
              console.warn(`⚠️ Could not find card to promote for ${directionKey}; synthesizing center card`);
              convertToNextTrackStack(directionKey, options);
          }
          state.nextTrackAnimationTimer = null;
      }, 120);
  }

  if (typeof window !== 'undefined') {
      window.tryFlushPendingCenterPromotion = tryFlushPendingCenterPromotion;
  }

// Heartbeat & Sync System moved to sync-manager.js


if (typeof window !== 'undefined') {
    // Expose deck helpers immediately so exposeDeckHelpers() can find them at module level
    window.createDimensionCards = createDimensionCards;
    window.swapStackContents = swapStackContents;
    window.rotateCenterCardToNextPosition = rotateCenterCardToNextPosition;
    window.convertToNextTrackStack = convertToNextTrackStack;
    window.__driftCreateDimensionCardsRef = createDimensionCards;
    window.__driftSwapStackContentsRef = swapStackContents;

    window.__deckTestHooks = window.__deckTestHooks || {};
    window.__deckTestHooks.getDeckApi = function getDeckApi() {
        return {
            createDimensionCards,
            navigateDirectionToCenter,
            rotateCenterCardToNextPosition,
            convertToNextTrackStack,
            resetCardToDirectionDisplay,
            elements,
            state
        };
    };
    const reverseHelper =
        (typeof prioritizeAlternateTrack === 'function' && prioritizeAlternateTrack)
        || window.prioritizeAlternateTrack
        || null;
    if (reverseHelper) {
        window.__deckTestHooks.prioritizeAlternateTrack = reverseHelper;
    }
    window.__deckTestHooks.setDeckStaleFlag = setDeckStaleFlag;
    window.__deckTestHooks.armExplorerSnapshotTimer = armExplorerSnapshotTimer;
    window.__deckTestHooks.clearExplorerSnapshotTimer = clearExplorerSnapshotTimer;
}

// Initialize manual refresh button when page loads
document.addEventListener('DOMContentLoaded', function () {
    if (typeof window.setupManualRefreshButton === 'function') {
        window.setupManualRefreshButton();
    }
    setupRadiusControls();
    setupFzfSearch(function () { state.journeyMode = true; });

    // Initialize playlist tray
    initPlaylistTray();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const sseStale = Date.now() - state.lastSSEMessageTime > 30000;
            if (sseStale) {
                window.connectSSE();
            }
        }
    });

    window.addEventListener('online', () => {
        setTimeout(() => connectSSE(), 1000);
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
        if (typeof requestSSERefresh === 'function') {
            requestSSERefresh().catch(err => {
                console.warn('⚠️ SSE refresh recovery attempt failed', err);
            });
        }
    }
}

const MAX_DECK_HELPER_EXPOSURE_ATTEMPTS = 48;
let deckHelperExposureLogged = false;
function exposeDeckHelpers(attempt = 0) {
    if (typeof window === 'undefined') {
        return;
    }
    const createRef = (typeof createDimensionCards === 'function' && createDimensionCards)
        || (window && typeof window.__driftCreateDimensionCardsRef === 'function' && window.__driftCreateDimensionCardsRef)
        || null;
    const swapRef = (typeof swapStackContents === 'function' && swapStackContents)
        || (window && typeof window.__driftSwapStackContentsRef === 'function' && window.__driftSwapStackContentsRef)
        || null;
    const missingCreate = !createRef;
    const missingSwap = !swapRef;
    if (missingCreate || missingSwap) {
        if (attempt >= MAX_DECK_HELPER_EXPOSURE_ATTEMPTS && !deckHelperExposureLogged) {
            console.error('⛔ Deck helpers still unavailable; continuing to retry in background');
            deckHelperExposureLogged = true;
        }
        const delay = Math.min(250, 25 * (attempt + 1));
        setTimeout(() => exposeDeckHelpers(attempt + 1), delay);
        return;
    }

    if (deckHelperExposureLogged) {
        console.log('✅ Deck helpers bound after extended retry');
        deckHelperExposureLogged = false;
    }

    window.__driftCreateDimensionCardsRef = createRef;
    window.__driftSwapStackContentsRef = swapRef;
    window.createDimensionCards = createRef;
    window.rotateCenterCardToNextPosition = typeof rotateCenterCardToNextPosition === 'function'
        ? rotateCenterCardToNextPosition
        : undefined;
    window.convertToNextTrackStack = typeof convertToNextTrackStack === 'function'
        ? convertToNextTrackStack
        : undefined;
    window.swapStackContents = swapRef;
    window.showNextTrackPreview = typeof showNextTrackPreview === 'function'
        ? showNextTrackPreview
        : undefined;
    window.hideNextTrackPreview = typeof hideNextTrackPreview === 'function'
        ? hideNextTrackPreview
        : undefined;

    window.__deckTestHooks = Object.assign({}, window.__deckTestHooks, {
        createDimensionCards,
        rotateCenterCardToNextPosition: window.rotateCenterCardToNextPosition,
        convertToNextTrackStack: window.convertToNextTrackStack,
        swapStackContents: window.swapStackContents,
        showNextTrackPreview: window.showNextTrackPreview,
        hideNextTrackPreview: window.hideNextTrackPreview,
        prioritizeAlternateTrack: (typeof prioritizeAlternateTrack === 'function' && prioritizeAlternateTrack)
            || window.prioritizeAlternateTrack
            || undefined
    });
}

if (typeof window !== 'undefined') {
    exposeDeckHelpers();
}

// ES module exports for deck API (used by tests)
// Assignments happen right after each function definition (see lines ~2164, ~2809, ~3162, ~3257)

export {
    _createDimensionCards as createDimensionCards,
    _navigateDirectionToCenter as navigateDirectionToCenter,
    _rotateCenterCardToNextPosition as rotateCenterCardToNextPosition,
    _convertToNextTrackStack as convertToNextTrackStack,
    _prioritizeAlternateTrack as prioritizeAlternateTrack
};
