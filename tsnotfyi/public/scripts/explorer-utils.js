// Explorer utilities - direction handling, track normalization, explorer data processing
// Dependencies: globals.js (state, PANEL_VARIANTS, VARIANT_TO_DIRECTION_TYPE)
// Dependencies: tools.js (getOppositeDirection, getDirectionColor)

import { state, PANEL_VARIANTS, VARIANT_TO_DIRECTION_TYPE } from './globals.js';
import { getOppositeDirection, getDirectionColor } from './tools.js';

export function cloneExplorerData(payload) {
  if (!payload) return null;
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch (error) {
    console.warn('⚠️ Failed to clone explorer payload for backup', error);
    return null;
  }
}

export function summarizeDirectionForDiff(direction) {
  if (!direction) {
    return { topId: null, count: 0 };
  }
  const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
  const firstDeterministic = samples.find(sample => {
    const meta = sample?.meta || sample?.track?.meta;
    return !meta || meta.randomized !== true;
  });
  const topSample = firstDeterministic || samples[0] || null;
  const topTrack = topSample ? (topSample.track || topSample) : null;
  return {
    topId: topTrack?.identifier || null,
    count: samples.length
  };
}

export function summarizeExplorerSnapshot(explorerData) {
  if (!explorerData) {
    return { currentId: null, nextId: null, directions: {}, directionCount: 0 };
  }
  const directions = explorerData.directions || {};
  const summaries = {};
  Object.keys(directions).forEach((key) => {
    summaries[key] = summarizeDirectionForDiff(directions[key]);
  });
  const currentTrack = explorerData.currentTrack || {};
  const currentId = currentTrack.identifier || null;
  const nextTrack = explorerData.nextTrack || {};
  const nextId = nextTrack.track?.identifier || nextTrack.identifier || null;
  return {
    currentId,
    nextId,
    directions: summaries,
    directionCount: Object.keys(summaries).length
  };
}

export function shouldIgnoreExplorerUpdate(previousExplorer, incomingExplorer) {
  if (!previousExplorer || !incomingExplorer) {
    return false;
  }

  const prevSummary = summarizeExplorerSnapshot(previousExplorer);
  const nextSummary = summarizeExplorerSnapshot(incomingExplorer);

  if (!prevSummary.directionCount || !nextSummary.directionCount) {
    return false;
  }

  // If current track changed, definitely don't skip the update
  if (prevSummary.currentId !== nextSummary.currentId) {
    return false;
  }

  if (prevSummary.nextId && nextSummary.nextId && prevSummary.nextId !== nextSummary.nextId) {
    return false;
  }

  const prevKeys = Object.keys(prevSummary.directions);
  const nextKeys = Object.keys(nextSummary.directions);

  if (prevKeys.length !== nextKeys.length) {
    return false;
  }

  let diffs = 0;
  const tolerance = Math.max(1, Math.floor(prevKeys.length * 0.2));

  for (const key of prevKeys) {
    const prevDir = prevSummary.directions[key];
    const nextDir = nextSummary.directions[key];
    if (!nextDir) {
      diffs += 1;
      if (diffs > tolerance) {
        return false;
      }
      continue;
    }
    const topChanged =
      Boolean(prevDir.topId) &&
      Boolean(nextDir.topId) &&
      prevDir.topId !== nextDir.topId;
    const countChanged = prevDir.count !== nextDir.count;
    if (topChanged || countChanged) {
      diffs += 1;
      if (diffs > tolerance) {
        return false;
      }
    }
  }

  return diffs <= tolerance;
}

export function clearStaleNextTrack(explorerData, currentTrackId) {
  if (!explorerData || !currentTrackId) {
    return false;
  }

  const nextTrackEntry = explorerData.nextTrack || null;
  const nextId = nextTrackEntry?.track?.identifier || nextTrackEntry?.identifier || null;
  if (nextId && nextId === currentTrackId) {
    console.warn('🛰️ Clearing stale next-track that matches current playback', {
      currentTrackId,
      explorerNextDirection: nextTrackEntry?.directionKey || nextTrackEntry?.direction || null
    });
    delete explorerData.nextTrack;
    return true;
  }

  return false;
}

export function pickPanelVariant() {
  return PANEL_VARIANTS[Math.floor(Math.random() * PANEL_VARIANTS.length)];
}

export function colorsForVariant(variant) {
  const directionType = VARIANT_TO_DIRECTION_TYPE[variant] || 'outlier';
  const colors = getDirectionColor(directionType, `${directionType}_positive`);
  return {
    border: colors.border,
    glow: colors.glow
  };
}

export function resolveCanonicalDirectionKey(directionKey, aliasOverride = null) {
  if (!directionKey) {
    return directionKey;
  }
  const aliasMap = aliasOverride || state.directionKeyAliases || {};
  const visited = new Set();
  let current = directionKey;
  while (aliasMap[current] && !visited.has(current)) {
    visited.add(current);
    current = aliasMap[current];
  }
  return current;
}

export function getBaseDirectionKey(directionKey) {
  if (!directionKey || typeof directionKey !== 'string') {
    return null;
  }
  return directionKey.replace(/_(?:positive|negative)$/, '');
}

export function isPositivePolarityKey(directionKey) {
  return typeof directionKey === 'string' && directionKey.endsWith('_positive');
}

export function isNegativePolarityKey(directionKey) {
  return typeof directionKey === 'string' && directionKey.endsWith('_negative');
}

export function registerDirectionAlias(aliasKey, canonicalKey, targetMap = null) {
  if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) {
    return;
  }
  const map = targetMap || state.directionKeyAliases || (state.directionKeyAliases = {});
  map[aliasKey] = canonicalKey;
}

export function normalizeDirectionKey(value, directionMap) {
  const visited = new Set();

  const resolveString = (candidate) => {
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;

    if (directionMap && typeof directionMap === 'object') {
      if (Object.prototype.hasOwnProperty.call(directionMap, trimmed)) {
        return trimmed;
      }
      for (const [key, direction] of Object.entries(directionMap)) {
        if (!direction) continue;
        if (
          direction.direction === trimmed ||
          direction.name === trimmed ||
          direction.label === trimmed
        ) {
          return key;
        }
      }
    }

    if (trimmed.includes('_') || trimmed.includes('-')) {
      return trimmed;
    }

    return null;
  };

  const helper = (candidate) => {
    if (!candidate) return null;

    if (typeof candidate === 'string') {
      return resolveString(candidate);
    }

    if (typeof candidate === 'object') {
      if (visited.has(candidate)) {
        return null;
      }
      visited.add(candidate);

      const propertiesToInspect = [
        'directionKey',
        'key',
        'id',
        'identifier',
        'baseDirection',
        'baseDirectionKey',
        'dimensionKey',
        'dimension',
        'direction'
      ];

      for (const property of propertiesToInspect) {
        if (Object.prototype.hasOwnProperty.call(candidate, property)) {
          const result = helper(candidate[property]);
          if (result) {
            return result;
          }
        }
      }
    }

    return null;
  };

  const resolved = helper(value);
  return resolveCanonicalDirectionKey(resolved);
}

export function mergeSampleTrackLists(targetDirection, sourceDirection) {
  if (!targetDirection || !sourceDirection) {
    return;
  }

  const targetSamples = Array.isArray(targetDirection.sampleTracks)
    ? targetDirection.sampleTracks.slice()
    : [];
  const sourceSamples = Array.isArray(sourceDirection.sampleTracks)
    ? sourceDirection.sampleTracks
    : [];
  if (!sourceSamples.length) {
    targetDirection.sampleTracks = targetSamples;
    return;
  }

  const seenIds = new Set(
    targetSamples
      .map(entry => (entry?.track || entry)?.identifier)
      .filter(Boolean)
  );

  sourceSamples.forEach(entry => {
    if (!entry) return;
    const track = entry.track || entry;
    if (!track) return;
    if (track.identifier && seenIds.has(track.identifier)) {
      return;
    }
    targetSamples.push(entry.track ? entry : { track });
    if (track.identifier) {
      seenIds.add(track.identifier);
    }
  });

  targetDirection.sampleTracks = targetSamples;
  const targetCount = Number(targetDirection.trackCount) || targetSamples.length;
  targetDirection.trackCount = Math.max(targetCount, targetSamples.length);
}

export function mergeOppositeDirectionData(primaryDirection, oppositeSource) {
  if (!primaryDirection || !oppositeSource) {
    return;
  }

  const incomingSamples = Array.isArray(oppositeSource.sampleTracks)
    ? oppositeSource.sampleTracks
    : [];
  if (!incomingSamples.length) {
    return;
  }

  const existingOpposite = primaryDirection.oppositeDirection || {};
  const derivedOppositeKey =
    existingOpposite.key ||
    oppositeSource.key ||
    getOppositeDirection(primaryDirection.key) ||
    oppositeSource.direction ||
    null;

  const mergedSamples = Array.isArray(existingOpposite.sampleTracks)
    ? existingOpposite.sampleTracks.slice()
    : [];
  const seenIds = new Set(
    mergedSamples
      .map(entry => (entry?.track || entry)?.identifier)
      .filter(Boolean)
  );

  incomingSamples.forEach(entry => {
    if (!entry) return;
    const track = entry.track || entry;
    if (!track) return;
    if (track.identifier && seenIds.has(track.identifier)) {
      return;
    }
    mergedSamples.push(entry.track ? entry : { track });
    if (track.identifier) {
      seenIds.add(track.identifier);
    }
  });

  primaryDirection.oppositeDirection = {
    ...existingOpposite,
    key: derivedOppositeKey || existingOpposite.key || oppositeSource.key || null,
    direction:
      existingOpposite.direction ||
      oppositeSource.direction ||
      derivedOppositeKey ||
      existingOpposite.key ||
      null,
    description:
      existingOpposite.description ||
      oppositeSource.description ||
      existingOpposite.description ||
      ''
  };
  primaryDirection.oppositeDirection.sampleTracks = mergedSamples;
  primaryDirection.oppositeDirection.trackCount = Math.max(
    Number(primaryDirection.oppositeDirection.trackCount) || mergedSamples.length,
    mergedSamples.length,
    Number(oppositeSource.trackCount) || incomingSamples.length
  );
  primaryDirection.hasOpposite = true;
}

export function ensureDirectionLayout() {
  if (!state.directionLayout || typeof state.directionLayout !== 'object') {
    state.directionLayout = {};
  }
  return state.directionLayout;
}

export function getLayoutEntryForDirection(key) {
  if (!key) {
    return null;
  }
  const layoutMap = ensureDirectionLayout();
  const canonicalKey = resolveCanonicalDirectionKey(key);
  return layoutMap[key] || layoutMap[canonicalKey] || null;
}

export function consolidateDirectionsForDeck(directionList = []) {
  const aliasMap = {};
  const canonicalOrder = [];
  const baseKeyMap = new Map();

  directionList.forEach(direction => {
    if (!direction) {
      return;
    }

    const directionKey = direction.key || direction.direction || null;
    if (!directionKey) {
      canonicalOrder.push(direction);
      return;
    }

    const baseKey = getBaseDirectionKey(directionKey) || directionKey;
    const existing = baseKeyMap.get(baseKey);

    if (!existing) {
      baseKeyMap.set(baseKey, {
        direction,
        index: canonicalOrder.length
      });
      canonicalOrder.push(direction);
      return;
    }

    const canonicalDirection = existing.direction;
    const samePolarity =
      isNegativePolarityKey(canonicalDirection.key) === isNegativePolarityKey(directionKey);

    if (samePolarity) {
      mergeSampleTrackLists(canonicalDirection, direction);
      registerDirectionAlias(directionKey, canonicalDirection.key, aliasMap);
      return;
    }

    const preferIncoming =
      isNegativePolarityKey(canonicalDirection.key) && !isNegativePolarityKey(directionKey);

    if (preferIncoming) {
      canonicalOrder[existing.index] = direction;
      registerDirectionAlias(canonicalDirection.key, directionKey, aliasMap);
      mergeOppositeDirectionData(direction, canonicalDirection);
      existing.direction = direction;
    } else {
      registerDirectionAlias(directionKey, canonicalDirection.key, aliasMap);
      mergeOppositeDirectionData(canonicalDirection, direction);
    }
  });

  return { directions: canonicalOrder, aliasMap };
}

export function extractNextTrackIdentifier(candidate) {
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

export function extractNextTrackDirection(candidate) {
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

export function normalizeNextTrackPayload(nextTrack, directionMap) {
  if (!nextTrack || typeof nextTrack !== 'object') {
    return nextTrack;
  }

  const normalizedKey = normalizeDirectionKey(
    nextTrack.directionKey || nextTrack.direction || nextTrack.stackDirection || null,
    directionMap
  );

  if (normalizedKey) {
    if (nextTrack.direction && typeof nextTrack.direction === 'object' && !nextTrack.directionMeta) {
      nextTrack.directionMeta = nextTrack.direction;
    }
    nextTrack.directionKey = normalizedKey;
    nextTrack.direction = normalizedKey;
    if (nextTrack.track && typeof nextTrack.track === 'object') {
      if (!nextTrack.track.directionKey) {
        nextTrack.track.directionKey = normalizedKey;
      }
    }
  }

  return nextTrack;
}

export function normalizeSampleTrack(sample) {
  if (!sample) {
    return null;
  }

  let raw = sample;
  if (typeof raw === 'object' && raw !== null && 'track' in raw) {
    raw = raw.track;
  }

  if (typeof raw === 'string') {
    const cached = state.trackMetadataCache?.[raw];
    if (cached && typeof cached === 'object') {
      const hydrated = { ...cached };
      hydrated.identifier = hydrated.identifier || raw;
      return hydrated;
    }
    return {
      identifier: raw,
      title: 'Upcoming Selection',
      artist: '',
      album: '',
      duration: null,
      albumCover: ''
    };
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const normalized = { ...raw };
  const identifier = extractNextTrackIdentifier(normalized);
  if (!identifier) {
    return null;
  }

  if (!normalized.identifier) {
    normalized.identifier = identifier;
  }

  return normalized;
}

export function cloneTrackRecord(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }
  return { ...track };
}

export function normalizeSamplesToTracks(samples) {
  if (!Array.isArray(samples)) {
    return [];
  }
  return samples
    .map(entry => normalizeSampleTrack(entry && typeof entry === 'object' && entry.track ? entry.track : entry))
    .filter(Boolean)
    .map(cloneTrackRecord)
    .filter(Boolean);
}

export function getTrackMetadataCache() {
  if (!state.trackMetadataCache) {
    state.trackMetadataCache = {};
  }
  return state.trackMetadataCache;
}

export function mergeTrackMetadata(target, source) {
  if (!target || !source || typeof target !== 'object' || typeof source !== 'object') {
    return target;
  }

  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    if (key === 'features' && typeof value === 'object') {
      target.features = target.features && typeof target.features === 'object'
        ? { ...target.features, ...value }
        : { ...value };
      return;
    }

    if (key === 'pca' && typeof value === 'object') {
      target.pca = target.pca && typeof target.pca === 'object'
        ? { ...target.pca, ...value }
        : { ...value };
      return;
    }

    if (key === 'beetsMeta' || key === 'beets') {
      target.beetsMeta = value;
      return;
    }

    if (key === 'albumCover' && !value) {
      return;
    }

    target[key] = value;
  });

  return target;
}

export function applyTrackDetailsToExplorer(identifier, details) {
  if (!identifier || !details || !state.latestExplorerData) {
    return;
  }

  const mergeIntoSample = (sample) => {
    if (!sample) return;
    const target = sample.track || sample;
    if (target && (target.identifier === identifier || target.trackMd5 === identifier || target.md5 === identifier)) {
      mergeTrackMetadata(target, details);
    }
  };

  const directions = state.latestExplorerData.directions || {};
  Object.values(directions).forEach(direction => {
    if (!direction) return;
    (direction.sampleTracks || []).forEach(mergeIntoSample);
    if (direction.oppositeDirection && Array.isArray(direction.oppositeDirection.sampleTracks)) {
      direction.oppositeDirection.sampleTracks.forEach(mergeIntoSample);
    }
  });

  const nextTrack = state.latestExplorerData.nextTrack;
  if (nextTrack) {
    if (nextTrack.identifier === identifier) {
      mergeTrackMetadata(nextTrack, details);
    }
    if (nextTrack.track && nextTrack.track.identifier === identifier) {
      mergeTrackMetadata(nextTrack.track, details);
    }
  }

  if (state.previousNextTrack && state.previousNextTrack.identifier === identifier) {
    mergeTrackMetadata(state.previousNextTrack, details);
  }

  if (state.latestCurrentTrack && state.latestCurrentTrack.identifier === identifier) {
    mergeTrackMetadata(state.latestCurrentTrack, details);
  }
}

export function hydrateTrackDetails(trackOrIdentifier, options = {}) {
  const identifier = typeof trackOrIdentifier === 'string'
    ? trackOrIdentifier
    : (trackOrIdentifier && (trackOrIdentifier.identifier || trackOrIdentifier.trackMd5 || trackOrIdentifier.md5));

  if (!identifier) {
    return Promise.resolve(null);
  }

  const cache = getTrackMetadataCache();
  const entry = cache[identifier] || (cache[identifier] = { id: identifier, meta: null, details: null, promise: null });

  if (entry.details) {
    if (trackOrIdentifier && typeof trackOrIdentifier === 'object') {
      mergeTrackMetadata(trackOrIdentifier, entry.details);
    }
    applyTrackDetailsToExplorer(identifier, entry.details);
    return Promise.resolve(entry.details);
  }

  if (entry.promise) {
    return entry.promise.then(details => {
      if (details && trackOrIdentifier && typeof trackOrIdentifier === 'object') {
        mergeTrackMetadata(trackOrIdentifier, details);
      }
      return details;
    }).catch(() => null);
  }

  const fetchPromise = fetch(`/track/${encodeURIComponent(identifier)}/meta`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then(result => {
      const payload = result?.track || null;
      if (!payload) {
        return null;
      }

      entry.details = payload;
      if (payload.beetsMeta && !entry.meta) {
        entry.meta = payload.beetsMeta;
      }

      if (trackOrIdentifier && typeof trackOrIdentifier === 'object') {
        mergeTrackMetadata(trackOrIdentifier, payload);
      }
      applyTrackDetailsToExplorer(identifier, payload);

      return payload;
    })
    .catch(error => {
      console.warn('⚠️ Failed to hydrate track metadata:', error);
      return null;
    })
    .finally(() => {
      entry.promise = null;
    });

  entry.promise = fetchPromise;
  return fetchPromise;
}

export const deckFrameBuilderApi = (typeof globalThis !== 'undefined' && globalThis.DeckFrameBuilder)
  ? globalThis.DeckFrameBuilder
  : (typeof window !== 'undefined' ? window.DeckFrameBuilder : null);

export let deckRenderWorker = null;
export let deckRenderWorkerCounter = 0;
export const deckRenderWorkerRequests = new Map();
export const DECK_RENDER_WORKER_TIMEOUT_MS = 3000;

export function fallbackNormalizeDirectionSamples(direction) {
  if (!direction || !Array.isArray(direction.sampleTracks)) {
    direction.sampleTracks = [];
    return;
  }

  direction.sampleTracks = direction.sampleTracks
    .map(entry => {
      if (!entry) return null;
      if (entry.track && typeof entry.track === 'object') {
        return { track: { ...entry.track } };
      }
      if (typeof entry === 'object') {
        return { track: { ...entry } };
      }
      return null;
    })
    .filter(Boolean);

  if (direction.sampleTracks.length > 0) {
    direction.isSynthetic = false;
  }

  if (direction.oppositeDirection) {
    fallbackNormalizeDirectionSamples(direction.oppositeDirection);
    if (Array.isArray(direction.oppositeDirection.sampleTracks) && direction.oppositeDirection.sampleTracks.length > 0) {
      direction.oppositeDirection.isSynthetic = false;
    }
  }
}

export function fallbackEnsureSyntheticOpposites(data) {
  if (!data || !data.directions) {
    return;
  }

  const directionsMap = data.directions;
  const processedPairs = new Set();

  const cloneSampleList = (samples = []) => (
    Array.isArray(samples)
      ? samples.map(entry => {
        if (!entry) return null;
        if (entry.track && typeof entry.track === 'object') {
          return { track: { ...entry.track } };
        }
        if (typeof entry === 'object') {
          return { track: { ...entry } };
        }
        return null;
      }).filter(Boolean)
      : []
  );

  Object.entries(directionsMap).forEach(([key, direction]) => {
    if (!direction || processedPairs.has(key)) {
      return;
    }
    const oppositeKey = getOppositeDirection(key);
    if (!oppositeKey) {
      return;
    }
    const pairKey = [key, oppositeKey].sort().join('::');
    if (processedPairs.has(pairKey)) {
      return;
    }

    const baseSamples = cloneSampleList(direction.sampleTracks || []);
    const hasBase = baseSamples.length > 0;
    const oppositeDirectionEntry = directionsMap[oppositeKey];

    if (oppositeDirectionEntry) {
      const oppositeSamples = cloneSampleList(oppositeDirectionEntry.sampleTracks || []);
      if (!oppositeSamples.length && hasBase) {
        oppositeDirectionEntry.sampleTracks = baseSamples.map(sample => ({ track: { ...sample.track } }));
        oppositeDirectionEntry.generatedOpposite = true;
        oppositeDirectionEntry.isSynthetic = true;
      } else if (oppositeSamples.length && !hasBase) {
        direction.sampleTracks = oppositeSamples.map(sample => ({ track: { ...sample.track } }));
        direction.generatedOpposite = true;
        direction.isSynthetic = true;
      }
      direction.hasOpposite = true;
      oppositeDirectionEntry.hasOpposite = true;
      oppositeDirectionEntry.oppositeDirection = {
        key,
        direction: direction.direction || key,
        domain: direction.domain || oppositeDirectionEntry.domain || null,
        sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } })),
        generatedOpposite: false
      };

      processedPairs.add(pairKey);
      return;
    }

    if (directionsMap[oppositeKey]?.generatedOpposite) {
      delete directionsMap[oppositeKey];
    }

    direction.hasOpposite = false;
    if (direction.oppositeDirection) {
      delete direction.oppositeDirection;
    }

    if (!directionsMap[oppositeKey]) {
      directionsMap[oppositeKey] = {
        key: oppositeKey,
        direction: oppositeKey,
        sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } })),
        generatedOpposite: true,
        isSynthetic: true
      };
    }

    processedPairs.add(pairKey);
  });
}

export function fallbackFrameMeta(explorerData, reason) {
  const directions = explorerData?.directions || {};
  const directionCount = Object.keys(directions).length;
  let trackCount = 0;
  Object.values(directions).forEach(direction => {
    if (!direction) {
      return;
    }
    trackCount += Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
    if (direction.oppositeDirection) {
      trackCount += Array.isArray(direction.oppositeDirection.sampleTracks) ? direction.oppositeDirection.sampleTracks.length : 0;
    }
  });
  return {
    normalized: true,
    reason,
    normalizedAt: Date.now(),
    directionCount,
    trackCount
  };
}

export function explorerContainsTrack(explorerData, identifier) {
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

export function findTrackInExplorer(explorerData, identifier) {
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

export function reapplyManualOverrideToExplorerData(explorerData, manualTrackId, manualDirectionKey, fallbackExplorerData = null, fallbackTrack = null) {
  if (!explorerData || !manualTrackId) return;

  let match = findTrackInExplorer(explorerData, manualTrackId);
  if (!match && fallbackExplorerData) {
    match = findTrackInExplorer(fallbackExplorerData, manualTrackId);
  }

  let trackRecord = match?.track ? { ...match.track } : null;
  if (!trackRecord && fallbackTrack) {
    const candidate = fallbackTrack.track || fallbackTrack;
    trackRecord = candidate ? { ...candidate } : null;
  }

  if (!trackRecord) {
    trackRecord = { identifier: manualTrackId };
  }

  const directionCandidate =
    manualDirectionKey ||
    match?.directionKey ||
    (fallbackTrack?.directionKey ?? null) ||
    explorerData.nextTrack?.directionKey ||
    explorerData.nextTrack?.direction ||
    null;

  const resolvedDirectionKey =
    normalizeDirectionKey(directionCandidate, explorerData.directions) ||
    directionCandidate ||
    manualDirectionKey ||
    match?.directionKey ||
    null;

  explorerData.nextTrack = {
    directionKey: resolvedDirectionKey,
    direction: resolvedDirectionKey,
    track: {
      ...trackRecord,
      identifier: manualTrackId
    }
  };

  if (resolvedDirectionKey && explorerData.directions) {
    const targetDirection = explorerData.directions[resolvedDirectionKey];
    let samplesContainer = targetDirection?.sampleTracks;
    if (!Array.isArray(samplesContainer)) {
      samplesContainer = [];
    }
    const alreadyPresent = samplesContainer.some(sample => {
      const candidate = sample?.track || sample;
      return candidate?.identifier === manualTrackId;
    });
    if (!alreadyPresent) {
      const sampleEntry = trackRecord.track ? { ...trackRecord } : { track: { ...trackRecord } };
      if (!sampleEntry.track) {
        sampleEntry.track = { ...trackRecord };
      }
      sampleEntry.track.identifier = manualTrackId;
      samplesContainer.unshift(sampleEntry);
      explorerData.directions[resolvedDirectionKey] = {
        ...(targetDirection || {}),
        sampleTracks: samplesContainer
      };
    }
  }
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.resolveCanonicalDirectionKey = resolveCanonicalDirectionKey;
  window.hydrateTrackDetails = hydrateTrackDetails;
  window.explorerContainsTrack = explorerContainsTrack;
  window.findTrackInExplorer = findTrackInExplorer;
  window.reapplyManualOverrideToExplorerData = reapplyManualOverrideToExplorerData;
  window.extractNextTrackIdentifier = extractNextTrackIdentifier;
  window.extractNextTrackDirection = extractNextTrackDirection;
  window.summarizeExplorerSnapshot = summarizeExplorerSnapshot;
  window.shouldIgnoreExplorerUpdate = shouldIgnoreExplorerUpdate;
  window.clearStaleNextTrack = clearStaleNextTrack;
  window.cloneExplorerData = cloneExplorerData;
}
