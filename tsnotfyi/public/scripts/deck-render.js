// Deck rendering - worker management, color assignment, frame building
// Dependencies: globals.js (state, getCardBackgroundColor)
// Dependencies: explorer-utils.js (deckFrameBuilderApi, deckRenderWorker*, fallbackNormalizeDirectionSamples, fallbackEnsureSyntheticOpposites, fallbackFrameMeta, pickPanelVariant, colorsForVariant, findTrackInExplorer)
// Dependencies: tools.js (getDirectionType, getDirectionColor, variantFromDirectionType)

import { state, getCardBackgroundColor } from './globals.js';
import { createLogger } from './log.js';
const log = createLogger('deck');
import {
  deckFrameBuilderApi,
  deckRenderWorker,
  deckRenderWorkerCounter,
  deckRenderWorkerRequests,
  DECK_RENDER_WORKER_TIMEOUT_MS,
  fallbackNormalizeDirectionSamples,
  fallbackEnsureSyntheticOpposites,
  fallbackFrameMeta,
  pickPanelVariant,
  colorsForVariant,
  findTrackInExplorer
} from './explorer-utils.js';
import { getDirectionType, getDirectionColor, variantFromDirectionType } from './tools.js';

// Module-level mutable state for worker
let localDeckRenderWorker = deckRenderWorker;
let localDeckRenderWorkerCounter = deckRenderWorkerCounter;

export function setCardVariant(card, variant) {
  if (!card) return;
  if (variant) {
    card.dataset.colorVariant = variant;
  } else {
    delete card.dataset.colorVariant;
  }
}

export function getDeckFrameBuilder() {
  if (deckFrameBuilderApi && typeof deckFrameBuilderApi.buildDeckRenderFrame === 'function') {
    return deckFrameBuilderApi;
  }
  if (typeof globalThis !== 'undefined'
    && globalThis.DeckFrameBuilder
    && typeof globalThis.DeckFrameBuilder.buildDeckRenderFrame === 'function') {
    return globalThis.DeckFrameBuilder;
  }
  if (typeof window !== 'undefined'
    && window.DeckFrameBuilder
    && typeof window.DeckFrameBuilder.buildDeckRenderFrame === 'function') {
    return window.DeckFrameBuilder;
  }
  return null;
}

export function runDeckFrameBuild(payload = {}) {
  try {
    const builder = getDeckFrameBuilder();
    if (!builder) {
      const fallbackExplorer = payload?.explorerData || null;
      if (fallbackExplorer && fallbackExplorer.directions) {
        Object.values(fallbackExplorer.directions).forEach(fallbackNormalizeDirectionSamples);
        fallbackEnsureSyntheticOpposites(fallbackExplorer);
      }
      return {
        explorerData: fallbackExplorer,
        meta: fallbackFrameMeta(fallbackExplorer, 'builder-unavailable')
      };
    }
    return builder.buildDeckRenderFrame(payload);
  } catch (error) {
    log.error('🛠️ Deck frame builder failed:', error);
    const fallbackExplorer = payload?.explorerData || null;
    if (fallbackExplorer && fallbackExplorer.directions) {
      Object.values(fallbackExplorer.directions).forEach(fallbackNormalizeDirectionSamples);
      fallbackEnsureSyntheticOpposites(fallbackExplorer);
    }
    return {
      explorerData: fallbackExplorer,
      meta: {
        ...fallbackFrameMeta(fallbackExplorer, 'builder-error'),
        error: error?.message || String(error)
      }
    };
  }
}

function handleDeckRenderWorkerMessage(event) {
  const data = event.data || {};
  if (typeof data.id === 'undefined') {
    return;
  }
  const pending = deckRenderWorkerRequests.get(data.id);
  if (!pending) {
    return;
  }
  deckRenderWorkerRequests.delete(data.id);
  clearTimeout(pending.timeout);
  if (data.success === false) {
    pending.reject(data.error ? new Error(data.error.message || 'Deck worker failure') : new Error('Deck worker failure'));
    return;
  }
  pending.resolve(data.frame || null);
}

function teardownDeckRenderWorker(error) {
  if (localDeckRenderWorker) {
    try {
      localDeckRenderWorker.terminate();
    } catch (terminateError) {
      log.warn('🛠️ Deck worker termination warning:', terminateError);
    }
  }
  localDeckRenderWorker = null;
  deckRenderWorkerRequests.forEach((pending) => {
    clearTimeout(pending.timeout);
    pending.reject(error || new Error('Deck render worker terminated'));
  });
  deckRenderWorkerRequests.clear();
}

export function initDeckRenderWorker() {
  if (typeof window === 'undefined' || typeof window.Worker === 'undefined') {
    return null;
  }

  if (localDeckRenderWorker) {
    return localDeckRenderWorker;
  }

  try {
    localDeckRenderWorker = new Worker('scripts/render-frame.worker.js');
    localDeckRenderWorker.addEventListener('message', handleDeckRenderWorkerMessage);
    localDeckRenderWorker.addEventListener('error', (event) => {
      log.error('🛠️ Deck render worker error:', event);
      teardownDeckRenderWorker(new Error('Deck render worker crashed'));
    });
  } catch (error) {
    log.warn('🛠️ Deck render worker unavailable; falling back to main thread', error);
    localDeckRenderWorker = null;
  }

  return localDeckRenderWorker;
}

export function requestDeckRenderFrame(payload = {}) {
  return new Promise((resolve, reject) => {
    const worker = initDeckRenderWorker();
    if (!worker) {
      reject(new Error('deck-worker-unavailable'));
      return;
    }

    const requestId = ++localDeckRenderWorkerCounter;
    const timeout = setTimeout(() => {
      if (deckRenderWorkerRequests.has(requestId)) {
        deckRenderWorkerRequests.delete(requestId);
        reject(new Error('Deck worker request timed out'));
      }
    }, DECK_RENDER_WORKER_TIMEOUT_MS);

    deckRenderWorkerRequests.set(requestId, { resolve, reject, timeout });
    try {
      worker.postMessage({ id: requestId, type: 'build-frame', payload });
    } catch (error) {
      clearTimeout(timeout);
      deckRenderWorkerRequests.delete(requestId);
      reject(error);
    }
  });
}

export function cacheTrackColorAssignment(trackId, info) {
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

export function resolveTrackColorAssignment(trackData, { directionKey } = {}) {
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

export function computeDirectionSignature(explorerData) {
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

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.setCardVariant = setCardVariant;
  window.getCardBackgroundColor = getCardBackgroundColor;
  window.runDeckFrameBuild = runDeckFrameBuild;
  window.requestDeckRenderFrame = requestDeckRenderFrame;
  window.cacheTrackColorAssignment = cacheTrackColorAssignment;
  window.resolveTrackColorAssignment = resolveTrackColorAssignment;
  window.computeDirectionSignature = computeDirectionSignature;
}
