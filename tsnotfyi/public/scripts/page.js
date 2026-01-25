// Main page orchestrator - imports from all other modules
import { state, elements, connectionHealth, audioHealth, rootElement, PANEL_VARIANTS, debugLog, getCardBackgroundColor, initializeElements } from './globals.js';
import { applyFingerprint, clearFingerprint, waitForFingerprint, composeStreamEndpoint, composeEventsEndpoint, syncEventsEndpoint, normalizeResolution } from './session-utils.js';
import { initializeAudioManager, setAudioCallbacks, startAudioHealthMonitoring, updateConnectionHealthUI } from './audio-manager.js';
import { renderBeetsSegments, hideBeetsSegments } from './beets-ui.js';
import { getDirectionType, formatDirectionName, isNegativeDirection, getOppositeDirection, hasOppositeDirection, getDirectionColor, variantFromDirectionType, hsl } from './tools.js';
import { cloneExplorerData, findTrackInExplorer, explorerContainsTrack, extractNextTrackIdentifier, extractNextTrackDirection, pickPanelVariant, colorsForVariant, consolidateDirectionsForDeck, normalizeSamplesToTracks, mergeTrackMetadata } from './explorer-utils.js';
import { setDeckStaleFlag, clearExplorerSnapshotTimer, armExplorerSnapshotTimer, clearPendingExplorerLookahead, forceApplyPendingExplorerSnapshot } from './deck-state.js';
import { setCardVariant, getDeckFrameBuilder, runDeckFrameBuild, initDeckRenderWorker, requestDeckRenderFrame, resolveTrackColorAssignment, cacheTrackColorAssignment } from './deck-render.js';
import { exitDangerZoneVisualState, safelyExitCardsDormantState, enterDangerZoneVisualState, ensureDeckHydratedAfterTrackChange, enterCardsDormantState, exitCardsDormantState, ensureTrayPreviewForDangerZone, collapseDeckForDangerZone } from './danger-zone.js';
import { startProgressAnimation, clearPendingProgressStart, renderProgressBar, formatTimecode, startProgressAnimationFromPosition, maybeApplyDeferredNextTrack, maybeApplyPendingTrackUpdate, getVisualProgressFraction } from './progress-ui.js';
import { sendNextTrack, scheduleHeartbeat, fullResync, createNewJourneySession, verifyExistingSessionOrRestart, requestSSERefresh, manualRefresh, setupManualRefreshButton } from './sync-manager.js';
import { connectSSE } from './sse-client.js';
import { getDisplayTitle, photoStyle, renderReverseIcon, updateCardWithTrackDetails, cycleStackContents, applyDirectionStackIndicator, createNextTrackCardStack, clearStackedPreviewLayer, ensureStackedPreviewLayer, renderStackedPreviews, hideDirectionKeyOverlay, updateDirectionKeyOverlay, resolveOppositeBorderColor } from './helpers.js';

(function hydrateStateFromLocation() {
  state.streamUrlBase = '/stream';
  state.eventsEndpointBase = '/events';
  state.streamUrl = state.streamUrlBase;
  state.eventsEndpoint = state.eventsEndpointBase;
  window.streamUrl = state.streamUrl;
  window.eventsUrl = state.eventsEndpoint;
})();

const RADIUS_MODES = ['microscope', 'magnifying', 'binoculars'];

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

  // Setup beets hover interaction
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

function applyMetadataOpacity(fadeRatio) {
      const ratio = Math.max(0, Math.min(fadeRatio, 1));
      if (state.metadataRevealPending && ratio > 0) {
          return;
      }
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
  if (typeof window !== 'undefined') {
      window.applyMetadataOpacity = applyMetadataOpacity;
      window.updateNowPlayingCard = updateNowPlayingCard;
      window.updateRadiusControlsUI = updateRadiusControlsUI;
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
      const layoutEntries = {};
      const layoutTimestamp = Date.now();

      Object.values(explorerData.directions || {}).forEach(normalizeTracks);

      if (DEBUG_FLAGS.duplicates) {
          performDuplicateAnalysis(explorerData, "createDimensionCards");
      }

      const container = document.getElementById('dimensionCards');
      deckLog('🎯 Container element:', container);

      if (state.dangerZoneVisualActive && options.forceDangerZoneRender !== true) {
          console.log('🔴 DIAG: applyDeckRenderFrame BLOCKED by dangerZoneVisualActive');
          deckLog('⏳ Danger Zone active; deferring deck render');
          state.dangerZoneDeferredExplorer = explorerData;
          state.lastDirectionSignature = null;
          return;
      }

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
          for (const t of tracks) preloadImage(t.albumCover);

          deckLog(`🎯 Creating direction card ${index}: ${direction.key} (${trackCount} tracks)${hasReverse ? ' with reverse' : ''}`);
          if (hasReverse) {
              const oppositeTracks = direction.oppositeDirection?.sampleTracks || [];
              const oppositeCount = oppositeTracks.length;
              for (const t of oppositeTracks) preloadImage(t.albumCover);
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

      state.nextTrackAnimationTimer = setTimeout(() => {
          if (explorerData.nextTrack) {
              deckLog(`🎯 Animating ${explorerData.nextTrack.directionKey} to center as next track`);
              animateDirectionToCenter(explorerData.nextTrack.directionKey);
          }
          state.nextTrackAnimationTimer = null;
      }, directions.length * 150 + 1500); // Wait for all cards to appear

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

          case 'ArrowRight': // rotate the wheel clockwise
              for (i = nextPosition + 1; i <= nextPosition + 12; i++) {
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
              for (i = nextPosition-1; i >= nextPosition - 12; i--) {
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

// Danger zone functions moved to danger-zone.js

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

    mergeTrackMetadata(trackDetails, pending.track);
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

// Exports for sse-client.js
if (typeof window !== 'undefined') {
  window.updatePlaylistTrayPreview = updatePlaylistTrayPreview;
  window.resolveTrackIdentifier = resolveTrackIdentifier;
  window.recordPendingLiveTrackCandidate = recordPendingLiveTrackCandidate;
  window.adoptPendingLiveTrackCandidate = adoptPendingLiveTrackCandidate;
}

// ====== Inactivity Management ======
  let inactivityTimer = null;
  let lastActivityTime = Date.now();
  let cardsInactiveTilted = false; // Track if cards are already tilted from inactivity
  let midpointReached = false; // Track if we've hit the lockout threshold
  let cardsLocked = false; // Track if card interactions are locked
  let dangerZoneReached = false;

  function publishInteractionState() {
      if (typeof window === 'undefined') {
          return;
      }
      window.__deckInteractionState = window.__deckInteractionState || {};
      window.__deckInteractionState.cardsLocked = cardsLocked;
      window.__deckInteractionState.dangerZoneReached = midpointReached;
  }
  window.publishInteractionState = publishInteractionState;
  publishInteractionState();

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

      publishInteractionState();
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

  // Progress bar functions moved to progress-ui.js

  function resetProgressAndDeck(reason = 'manual') {
      console.warn(`🧹 Forcing deck recovery (${reason})`);
      if (typeof window.stopProgressAnimation === 'function') {
          window.stopProgressAnimation();
      }
      if (typeof window.resetDangerZoneState === 'function') {
          window.resetDangerZoneState();
      }
      cardsInactiveTilted = false;
      midpointReached = false;
      window.exitDangerZoneVisualState({ reason: 'deck-reset' });
      cardsLocked = false;
      state.usingOppositeDirection = false;
      state.lastProgressDesync = null;
      state.progressEverStarted = false;
      publishInteractionState();
      clearReversePreference();
      window.safelyExitCardsDormantState({ immediate: true });
      unlockCardInteractions();
      markActivity();
  }

  function triggerMidpointActions() {
      // Defer danger zone entry if deck render is in progress to avoid blocking
      if (state.isRenderingDeck || state.pendingDeckHydration) {
          console.log('🎯 Deferring danger zone entry - deck render in progress');
          setTimeout(() => {
              if (!state.dangerZoneVisualActive && !state.isRenderingDeck && !state.pendingDeckHydration) {
                  triggerMidpointActions();
              }
          }, 50);
          return;
      }

      console.log(`🎯 Locking in selection - ${LOCKOUT_THRESHOLD_SECONDS}s or less remaining`);

      // Clear inactivity timer - no longer needed in second half
      if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
      }

      enterCardsDormantState();

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
      enterDangerZoneVisualState();
  }

  function triggerDangerZoneActions() {
      triggerMidpointActions();
  }

  function lockCardInteractions() {
      console.log('🔒 Locking card interactions until next track');
      cardsLocked = true;

      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
          card.classList.add('interaction-locked');
          card.style.pointerEvents = 'none';
      });

      publishInteractionState();
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

      publishInteractionState();
  }

  console.log('🚢 Awaiting audio start to establish session.');


  // Swap stack contents between current and opposite direction
  function swapStackContents(currentDimensionKey, oppositeDimensionKey) {
      console.log(`🔄 swapStackContents called with ${currentDimensionKey} → ${oppositeDimensionKey}`);

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
      redrawNextTrackStack(baseKey, { oppositeKey: oppositeHint });
      console.log(`🔄 Finished calling redrawNextTrackStack`);
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

      console.log(`🔄 Redrawing next track stack: base=${baseDimensionKey}, display=${displayDimensionKey}, reversed=${state.usingOppositeDirection}`);
      console.log(`🔄 Direction sample tracks count:`, displayDirection?.sampleTracks?.length || 0);
      console.log(`🔄 First track in direction:`, displayDirection?.sampleTracks?.[0]?.title || 'None');

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

      console.log(`🔄 TRACK SELECTION DEBUG:`, {
          usingOppositeDirection: state.usingOppositeDirection,
          baseDimensionKey,
          displayDimensionKey,
          displayTracksCount: displayTracks.length,
          selectedTrack: trackToShow.title,
          selectedTrackId: trackToShow.identifier
      });

      state.stackIndex = 0;
      state.selectedIdentifier = trackToShow.identifier;
      console.log(`🔄 Updated selection to first track of ${state.usingOppositeDirection ? 'OPPOSITE' : 'ORIGINAL'} stack (${displayDimensionKey}): ${trackToShow.title} (${trackToShow.identifier})`);

      sendNextTrack(trackToShow.identifier, displayDimensionKey, 'user');

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

          const fallbackCard = oppositeKey ? document.querySelector(`[data-direction-key="${oppositeKey}"]`) : null;
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
                         if (state.usingOppositeDirection && direction.oppositeDirection?.sampleTracks) {
                             tracksToUse = direction.oppositeDirection.sampleTracks;
                             dimensionToShow = direction.oppositeDirection;
                             console.log(`🔄 Cycling through opposite direction tracks`);
                         } else {
                             tracksToUse = direction.sampleTracks;
                             dimensionToShow = direction;
                             console.log(`🔄 Cycling through original direction tracks`);
                         }

                         // Cycle the appropriate tracks
                         tracksToUse.push(tracksToUse.shift());
                         const track = tracksToUse[0].track || tracksToUse[0];
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
      const card = document.querySelector(`[data-direction-key="${directionKey}"].next-track`);
      if (!card) return;

      console.log(`🔄 Rotating center card ${directionKey} to next clock position`);

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
      console.log(`🔄 Card ${directionKey} original position was: ${originalPosition}`);

      let nextPosition = 1;
      if (originalPosition && !occupiedPositions.has(originalPosition)) {
          // Return to original position if it's available
          nextPosition = originalPosition;
          console.log(`🔄 Returning ${directionKey} to original position ${nextPosition}`);
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

      console.log(`🔄 Moving ${directionKey} to position ${nextPosition}`);

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
  if (typeof window !== 'undefined') {
      window.rotateCenterCardToNextPosition = rotateCenterCardToNextPosition;
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
      const labelContent = sampleTrack?.title
          ? `<div class="dimension-label"><div class="track-title">${sampleTrack.title}</div><div class="direction-name">${directionName}</div></div>`
          : `<div class="dimension-label">${directionName}</div>`;

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

  if (typeof window !== 'undefined') {
    window.resolveNextTrackData = resolveNextTrackData;
  }

  // Convert a direction card into a next track stack (add track details and indicators)
  function convertToNextTrackStack(directionKey) {
      console.log(`🔄 Converting ${directionKey} to next track stack...`);
      console.log(`🔄 Latest explorer data:`, state.latestExplorerData);
      console.log(`🔄 Direction data:`, state.latestExplorerData?.directions[directionKey]);

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
      console.log(`🔄 Found card for ${actualDirectionKey}, updating with track details...`);
      console.log(`🔄 Card element:`, card);
      console.log(`🔄 Sample tracks:`, sampleTracks);

      const primarySample = sampleTracks[0] || {};
      const selectedTrack = primarySample.track || primarySample;

      console.log(`🔄 Selected track:`, selectedTrack);
      console.log(`🔄 About to call updateCardWithTrackDetails with preserveColors=true...`);
      updateCardWithTrackDetails(card, selectedTrack, direction, true, swapStackContents);
      console.log(`🔄 Finished calling updateCardWithTrackDetails`);

      if (state.cardsDormant) {
          showNextTrackPreview(selectedTrack);
      }

      if (typeof updateNextTrackMetadata === 'function') {
          updateNextTrackMetadata(selectedTrack);
      }

      // Stack depth indication is now handled via CSS pseudo-elements on the main card
  }
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
      let promotionDelay = 0;

      if (currentCenterKey && currentCenterKey !== canonicalDirectionKey && typeof rotateCenterCardToNextPosition === 'function') {
          const demoted = rotateCenterCardToNextPosition(currentCenterKey);
          if (demoted) {
              promotionDelay = 820;
          }
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

      if (promotionDelay > 0) {
          setTimeout(performPromotion, promotionDelay);
      } else {
          performPromotion();
      }

      tryFlushPendingCenterPromotion();
  }

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
