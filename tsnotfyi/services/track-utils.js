// Track utilities — hydration, cloning, metadata, lookup
// Extracted from drift-audio-mixer.js

const { getTrackTitle } = require('../schemas/track-definitions');

// ─── Pure utilities ──────────────────────────────────────────────────────────

function pruneEmptyStrings(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .map(item => pruneEmptyStrings(item))
      .filter(item => item !== undefined);
    return cleaned;
  }
  if (typeof value === 'object') {
    const result = {};
    let hasValue = false;
    Object.entries(value).forEach(([key, val]) => {
      const sanitized = pruneEmptyStrings(val);
      if (sanitized !== undefined) {
        result[key] = sanitized;
        hasValue = true;
      }
    });
    return hasValue ? result : undefined;
  }
  return value;
}

function cloneAndSanitizeBeetsMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(meta));
  } catch (error) {
    clone = { ...meta };
  }
  const cleaned = pruneEmptyStrings(clone);
  if (!cleaned || (typeof cleaned === 'object' && Object.keys(cleaned).length === 0)) {
    return null;
  }
  return cleaned;
}

function buildTrackMetadata(track) {
  if (!track) {
    return null;
  }
  return {
    identifier: track.identifier || track.md5 || null,
    title: track.title || null,
    artist: track.artist || null,
    album: track.album || null,
    path: track.path || null
  };
}

// ─── Cloning utilities ───────────────────────────────────────────────────────

function cloneFeatureMap(features) {
  if (!features || typeof features !== 'object') return null;
  const clone = {};
  for (const [key, value] of Object.entries(features)) {
    if (value === undefined) continue;
    clone[key] = value;
  }
  return clone;
}

function clonePcaMap(pca) {
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

function cloneVaeData(vae) {
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

function cloneBaseTrack(radialSearch, track) {
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
    loved: track.loved,
    bpm: track.bpm,
    key: track.key
  };

  if (track.features) {
    clone.features = cloneFeatureMap(track.features);
  }
  if (track.pca) {
    clone.pca = clonePcaMap(track.pca);
  }
  if (track.vae) {
    clone.vae = cloneVaeData(track.vae);
  }
  if (track.beetsMeta) {
    const sanitized = cloneAndSanitizeBeetsMeta(track.beetsMeta);
    if (sanitized) {
      clone.beetsMeta = sanitized;
    }
  }
  if (track.analysis) {
    try {
      clone.analysis = JSON.parse(JSON.stringify(track.analysis));
    } catch (err) {
      // Non-serializable analysis structures can be ignored for hydration purposes
    }
  }

  if (!clone.title || (typeof clone.title === 'string' && clone.title.trim() === '')) {
    const fallbackTitle = getTrackTitle(track);
    if (fallbackTitle) {
      clone.title = fallbackTitle;
    }
  }

  return clone;
}

// ─── Merge utilities ─────────────────────────────────────────────────────────

function mergeFeatureMaps(...sources) {
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

function mergePcaMaps(...sources) {
  let merged = null;

  sources.forEach(source => {
    const clone = clonePcaMap(source);
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

// ─── Lookup utilities (need radialSearch + explorerDataCache) ────────────────

function findTrackInCurrentExplorer(explorerDataCache, identifier) {
  if (!identifier || !explorerDataCache?.size) return null;
  for (const [, explorerData] of explorerDataCache) {
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

function lookupTrackFeatures(radialSearch, explorerDataCache, identifier) {
  if (!identifier) return null;
  const track = radialSearch?.kdTree?.getTrack(identifier);
  if (!track) return findTrackInCurrentExplorer(explorerDataCache, identifier)?.features || null;
  return track.features || findTrackInCurrentExplorer(explorerDataCache, identifier)?.features || null;
}

function lookupTrackPca(radialSearch, explorerDataCache, identifier) {
  if (!identifier) return null;
  const track = radialSearch?.kdTree?.getTrack(identifier);
  if (!track) return findTrackInCurrentExplorer(explorerDataCache, identifier)?.pca || null;
  return track.pca || findTrackInCurrentExplorer(explorerDataCache, identifier)?.pca || null;
}

function lookupTrackAlbumCover(radialSearch, explorerDataCache, identifier) {
  if (!identifier) return null;
  const track = radialSearch?.kdTree?.getTrack(identifier);
  if (!track) return findTrackInCurrentExplorer(explorerDataCache, identifier)?.albumCover || null;
  return track.albumCover || findTrackInCurrentExplorer(explorerDataCache, identifier)?.albumCover || null;
}

function lookupTrackBeetsMeta(radialSearch, explorerDataCache, identifier) {
  if (!identifier) return null;
  const track = radialSearch?.kdTree?.getTrack(identifier);
  if (!track) {
    return findTrackInCurrentExplorer(explorerDataCache, identifier)?.beetsMeta || null;
  }
  return track.beetsMeta || findTrackInCurrentExplorer(explorerDataCache, identifier)?.beetsMeta || null;
}

// ─── Hydration ───────────────────────────────────────────────────────────────

function hydrateTrackRecord(radialSearch, trackCandidate, annotations = {}) {
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

  const kdTrack = radialSearch?.kdTree?.getTrack(identifier);
  const baseClone = cloneBaseTrack(radialSearch, kdTrack) || {};

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
    const sanitizedMeta = cloneAndSanitizeBeetsMeta(beetsMeta);
    if (sanitizedMeta) {
      result.beetsMeta = sanitizedMeta;
    } else {
      delete result.beetsMeta;
    }
  } else {
    delete result.beetsMeta;
  }

  const mergedFeatures = mergeFeatureMaps(
    baseClone.features,
    nestedCandidate?.features,
    overlay.features,
    annotations.features
  );
  if (mergedFeatures) {
    result.features = mergedFeatures;
  } else if (result.features) {
    result.features = cloneFeatureMap(result.features) || {};
  } else {
    result.features = {};
  }

  const mergedPca = mergePcaMaps(
    baseClone.pca,
    nestedCandidate?.pca,
    overlay.pca,
    annotations.pca
  );
  if (mergedPca) {
    result.pca = mergedPca;
  } else if (result.pca) {
    result.pca = clonePcaMap(result.pca);
  } else {
    result.pca = null;
  }

  const vaeSources = [overlay.vae, annotations.vae, nestedCandidate?.vae, baseClone.vae].filter(Boolean);
  const resolvedVae = vaeSources.find(source => Array.isArray(source?.latent)) || vaeSources[0] || null;
  if (resolvedVae) {
    result.vae = cloneVaeData(resolvedVae);
  } else if (result.vae) {
    result.vae = cloneVaeData(result.vae);
  } else {
    result.vae = null;
  }

  return result;
}

// ─── Duration utility ────────────────────────────────────────────────────────

function getAdjustedTrackDuration(currentTrack, audioMixer, track, { logging = true } = {}) {
  if (track === undefined) {
    track = currentTrack;
  }
  // Try to get the adjusted duration from the advanced audio mixer when querying the active track
  const mixerStatus = typeof audioMixer?.getStatus === 'function' ? audioMixer.getStatus() : null;
  const estimatedDuration = mixerStatus?.currentTrack?.estimatedDuration;
  const mixerTrackId = mixerStatus?.currentTrack?.identifier || null;
  const usingActiveTrack = track && currentTrack && track.identifier === currentTrack.identifier;

  // Only use mixer's estimatedDuration if mixer is playing the same track we're querying
  // During crossfade, mixer may have advanced to next track while currentTrack is still old
  const mixerMatchesTrack = mixerTrackId && track?.identifier && mixerTrackId === track.identifier;

  if (usingActiveTrack && mixerMatchesTrack && Number.isFinite(estimatedDuration) && estimatedDuration > 0) {
    if (logging) {
      if (track?.length) {
        console.log(`\u{1F4CF} Using adjusted track duration: ${estimatedDuration.toFixed(1)}s (original: ${track.length}s)`);
      } else {
        console.log(`\u{1F4CF} Using adjusted track duration: ${estimatedDuration.toFixed(1)}s (no original length available)`);
      }
    }
    return estimatedDuration;
  }

  // Fallback to original duration if mixer doesn't have adjusted duration yet
  if (track?.length) {
    if (logging) {
      console.log(`\u{1F4CF} Using original track duration: ${track.length}s (mixer not ready)`);
    }
    return track.length;
  }

  if (logging) {
    console.warn('\u{1F4CF} Unable to determine track duration; returning 0');
  }
  return 0;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Pure utilities
  pruneEmptyStrings,
  cloneAndSanitizeBeetsMeta,
  buildTrackMetadata,

  // Cloning
  cloneFeatureMap,
  clonePcaMap,
  cloneVaeData,
  cloneBaseTrack,

  // Merge
  mergeFeatureMaps,
  mergePcaMaps,

  // Lookup
  findTrackInCurrentExplorer,
  lookupTrackFeatures,
  lookupTrackPca,
  lookupTrackAlbumCover,
  lookupTrackBeetsMeta,

  // Hydration
  hydrateTrackRecord,

  // Duration
  getAdjustedTrackDuration
};
