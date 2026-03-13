/**
 * Explorer Service — standalone explorer computation module.
 *
 * Extracted from DriftAudioMixer.runComprehensiveExplorerData() so the heavy
 * KD-tree work can run inside a Worker thread (or be tested independently).
 *
 * Every function here is a pure(ish) computation that reads from a RadialSearch
 * instance and session context passed in as arguments — no mixer state mutations.
 */

const { setImmediate: setImmediatePromise } = require('timers/promises');

const VERBOSE_EXPLORER = process.env.LOG_EXPLORER === '1';

function explorerLog(...args) {
  if (VERBOSE_EXPLORER) {
    console.log(...args);
  }
}

const VAE_LATENT_LABELS = [
  'Hidden Doorway',
  'Clandestine Passage',
  'Secret Path',
  'Whispered Corridor',
  'Shrouded Walkway',
  'Candlelit Arcade',
  'Phantom Stairwell',
  'Midnight Causeway'
];

const NEGATIVE_DIRECTION_KEYS = new Set([
  'slower', 'less_danceable', 'more_atonal', 'simpler', 'smoother',
  'sparser_onsets', 'looser_tuning', 'weaker_fifths', 'weaker_chords',
  'slower_changes', 'less_bass', 'less_air', 'calmer', 'darker'
]);

function isNegativeDirectionKey(directionKey) {
  if (!directionKey || typeof directionKey !== 'string') return false;
  if (directionKey.includes('_negative')) return true;
  return NEGATIVE_DIRECTION_KEYS.has(directionKey);
}

// ─── Pure computation helpers ───────────────────────────────────────────────

function computeNeighborhoodStats(neighborhoodEntries) {
  if (!Array.isArray(neighborhoodEntries) || neighborhoodEntries.length === 0) {
    return { count: 0, distanceCount: 0, min: null, max: null, median: null, average: null, p95: null };
  }

  const distances = neighborhoodEntries
    .map(entry => {
      if (!entry) return null;
      const dist = Number(entry.distance);
      if (Number.isFinite(dist)) return dist;
      const similarity = Number(entry.similarity);
      return Number.isFinite(similarity) ? similarity : null;
    })
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);

  const stats = {
    count: neighborhoodEntries.length,
    distanceCount: distances.length,
    min: null, max: null, median: null, average: null, p95: null
  };

  if (distances.length > 0) {
    const sum = distances.reduce((acc, value) => acc + value, 0);
    stats.average = sum / distances.length;
    stats.min = distances[0];
    stats.max = distances[distances.length - 1];

    if (distances.length === 1) {
      stats.median = distances[0];
      stats.p95 = distances[0];
    } else {
      const mid = Math.floor(distances.length / 2);
      stats.median = distances.length % 2 === 0
        ? (distances[mid - 1] + distances[mid]) / 2
        : distances[mid];
      const p95Index = Math.min(distances.length - 1, Math.floor(distances.length * 0.95));
      stats.p95 = distances[p95Index];
    }
  }

  return stats;
}

function calculateDirectionDiversity(trackCount, totalNeighborhoodSize) {
  if (trackCount === 0 || totalNeighborhoodSize === 0) return 0;

  const ratio = trackCount / totalNeighborhoodSize;
  let score;

  if (ratio >= 0.70 && ratio <= 0.80) {
    score = 100 - Math.abs(ratio - 0.75) * 200;
  } else if (ratio >= 0.20 && ratio <= 0.30) {
    score = 100 - Math.abs(ratio - 0.25) * 200;
  } else if (ratio >= 0.45 && ratio <= 0.55) {
    score = 80 - Math.abs(ratio - 0.50) * 100;
  } else if (ratio >= 0.30 && ratio <= 0.70) {
    const distanceFrom50 = Math.abs(ratio - 0.50);
    const distanceFrom75 = Math.min(Math.abs(ratio - 0.75), Math.abs(ratio - 0.25));
    score = 60 + (distanceFrom50 * 40) - (distanceFrom75 * 20);
  } else {
    const extremeness = ratio < 0.20 ? (0.20 - ratio) : (ratio - 0.80);
    score = Math.max(0, 40 - (extremeness * 200));
  }

  return Math.max(0, Math.min(100, score));
}

function selectStrategicSamples(candidates, currentTrack) {
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length === 1) return candidates;

  const withMetrics = candidates.map(c => {
    const track = c.track || c;
    const playCount = track.playCount || 0;
    const playPenalty = 1 + 0.03 * playCount;
    return {
      ...c,
      track,
      dirDist: (c.distance || c.similarity || 0) * playPenalty,
      priDist: Math.abs((track).pca?.primary_d || 0)
    };
  });

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
    if (currentIdentifier && id === currentIdentifier) return false;
    if (dealt.has(id)) return false;
    dealt.add(id);
    result.push(c);
    return true;
  };

  // Deal loved tracks first — they float to top of the stack
  const lovedCandidates = withMetrics.filter(c => (c.track || c).loved);
  for (const c of lovedCandidates) {
    tryDeal([c], 0);
  }

  for (let i = 0; result.length < candidates.length && i < Math.max(byDir.length, byPri.length); i++) {
    tryDeal(byDir, i);
    tryDeal(byDir, byDir.length - 1 - i);
    tryDeal(byPri, i);
    tryDeal(byPri, byPri.length - 1 - i);
  }

  return result;
}

function filterSessionRepeats(tracks, sessionContext) {
  const originalCount = tracks.length;
  const { sessionHistoryCount, noArtist, noAlbum, seenArtists, seenAlbums, currentTrackId } = sessionContext;

  if (sessionHistoryCount <= 3) {
    console.log(`🔓 Session filtering DISABLED - only ${sessionHistoryCount} tracks played, allowing all ${originalCount} candidates`);
    return tracks;
  }

  const seenArtistSet = new Set(seenArtists);
  const seenAlbumSet = new Set(seenAlbums);

  const filtered = tracks.filter(trackObj => {
    const track = trackObj.track || trackObj;

    if (currentTrackId && track.identifier === currentTrackId) return false;
    if (noArtist && track.artist && seenArtistSet.has(track.artist)) return false;
    if (noAlbum && track.album && seenAlbumSet.has(track.album)) return false;

    return true;
  });

  if (filtered.length < originalCount) {
    console.log(`🚫 Session filtering: ${originalCount - filtered.length} tracks removed (${filtered.length} remaining)`);
  }

  if (filtered.length === 0 && originalCount > 0) {
    console.log(`🚨 Session filtering removed ALL candidates! Falling back to unfiltered list for core directions`);
    return tracks;
  }

  return filtered;
}

// ─── Direction exploration ──────────────────────────────────────────────────

async function exploreDirection(explorerData, radialSearch, domain, component, directionName, description, polarity, totalNeighborhoodSize, targetTrack, searchState) {
  const directionKey = polarity ? `${domain}_${component}_${polarity}` : `${domain}_${polarity || component}`;

  try {
    const searchConfig = {
      resolution: searchState.explorerResolution || 'adaptive',
      limit: 40,
      adaptiveRadius: searchState.adaptiveRadius,
      precomputedNeighbors: searchState.neighborhoodSnapshot
    };

    const candidates = await radialSearch.getPCADirectionalCandidates(
      targetTrack.identifier, domain, component, polarity || component, searchConfig
    );

    const trackCount = candidates.totalAvailable || 0;
    const strategicSamples = selectStrategicSamples(candidates.candidates || [], targetTrack);

    const formattedTracks = strategicSamples.map(sample => {
      const track = sample.track || sample;
      const pcaSlices = radialSearch.kdTree.calculatePcaContributionFractions(
        targetTrack, track, domain, `${directionKey}:${track.identifier}`, component
      );
      const distanceSlices = {
        kind: 'pca', domain,
        reference: { key: pcaSlices.referenceKey, distance: pcaSlices.referenceDistance },
        total: pcaSlices.total, slices: pcaSlices.slices
      };
      return {
        identifier: track.identifier, title: track.title, artist: track.artist,
        album: track.album, albumCover: track.albumCover, duration: track.length,
        loved: track.loved || false, playCount: track.playCount || 0,
        distance: sample.distance, pca: track.pca, features: track.features,
        distanceSlices,
        pcaDistanceSlices: {
          referenceKey: pcaSlices.referenceKey, referenceDistance: pcaSlices.referenceDistance,
          total: pcaSlices.total, slices: pcaSlices.slices
        }
      };
    });

    const originalSamples = formattedTracks.map(track => ({
      ...track, features: track.features ? { ...track.features } : track.features
    }));

    if (trackCount === 0) return;
    if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
      console.log(`🚫 Ignoring direction ${directionKey}: selects too many tracks (${trackCount}/${totalNeighborhoodSize})`);
      return;
    }

    explorerData.directions[directionKey] = {
      direction: directionName, description, domain, component, polarity,
      trackCount: formattedTracks.length, totalNeighborhoodSize,
      diversityScore: calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
      isOutlier: formattedTracks.length < 3,
      splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
      sampleTracks: formattedTracks, originalSampleTracks: originalSamples
    };
  } catch (error) {
    console.error(`Failed to explore direction ${directionKey}:`, error);
    explorerData.directions[directionKey] = {
      direction: directionName, description, domain, component, polarity,
      sampleTracks: [], error: error.message
    };
  }
}

async function exploreOriginalFeatureDirection(explorerData, radialSearch, feature, polarity, totalNeighborhoodSize, targetTrack, sessionContext) {
  const direction = polarity === 'positive' ? feature.positive : feature.negative;
  const directionKey = `${feature.name}_${polarity}`;

  try {
    const candidates = await radialSearch.getDirectionalCandidates(targetTrack.identifier, direction);

    const trackCount = candidates.totalAvailable || 0;
    const filteredCandidates = filterSessionRepeats(candidates.candidates || [], sessionContext);
    const strategicSamples = selectStrategicSamples(filteredCandidates, targetTrack, 50);

    if (trackCount === 0) return;
    if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) return;

    const formattedTracks = strategicSamples.map(sample => {
      const track = sample.track || sample;
      const directionDim = radialSearch.kdTree.getDirectionDimension(direction);
      const activeDimensions = radialSearch.kdTree.dimensions.filter(dim => dim !== directionDim);
      const featureSlices = radialSearch.kdTree.calculateFeatureContributionFractions(
        targetTrack, track, activeDimensions, null,
        `${directionKey}:${track.identifier || track.track?.identifier}`, directionDim
      );
      const distanceSlices = {
        kind: 'feature', dimensions: activeDimensions,
        reference: { key: directionDim, distance: featureSlices.referenceDistance },
        total: featureSlices.total, slices: featureSlices.slices
      };
      return {
        identifier: track.identifier || track.track?.identifier,
        title: track.title || track.track?.title,
        artist: track.artist || track.track?.artist,
        album: track.album || track.track?.album,
        duration: track.length || track.track?.length,
        loved: track.loved || track.track?.loved || false,
        playCount: track.playCount || track.track?.playCount || 0,
        distance: sample.distance || sample.similarity,
        features: track.features || track.track?.features,
        albumCover: track.albumCover || track.track?.albumCover,
        distanceSlices,
        featureDistanceSlices: {
          referenceKey: directionDim, referenceDistance: featureSlices.referenceDistance,
          total: featureSlices.total, slices: featureSlices.slices
        }
      };
    });

    const originalSamples = formattedTracks.map(track => ({
      ...track, features: track.features ? { ...track.features } : track.features
    }));

    explorerData.directions[directionKey] = {
      direction, description: feature.description, domain: 'original',
      component: feature.name, polarity,
      trackCount: formattedTracks.length, totalNeighborhoodSize,
      diversityScore: calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
      isOutlier: formattedTracks.length < 3,
      splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
      sampleTracks: formattedTracks, originalSampleTracks: originalSamples
    };
  } catch (error) {
    console.error(`🚨 CORE SEARCH ERROR: Failed to explore original feature direction ${directionKey}:`, error);
    explorerData.directions[directionKey] = {
      direction, description: feature.description, domain: 'original',
      component: feature.name, polarity, trackCount: 0, totalNeighborhoodSize,
      sampleTracks: [], diversityScore: 0, isOutlier: true, error: error.message
    };
  }
}

async function exploreVaeDirection(explorerData, radialSearch, latentIndex, polarity, options = {}) {
  const targetTrack = options.targetTrack;
  const directionKey = `vae_latent_${latentIndex}_${polarity}`;
  const baseLabel = VAE_LATENT_LABELS[latentIndex] || `Latent Axis ${latentIndex + 1}`;
  const directionName = baseLabel;
  const orientationDescriptor = polarity === 'positive' ? 'forward flow' : 'mirrored flow';
  const description = `${baseLabel} (${orientationDescriptor})`;

  try {
    const scope = options.explorerResolution || 'adaptive';
    const resolutionPriority = (() => {
      switch (scope) {
        case 'microscope': return ['microscope', 'magnifying_glass', 'binoculars', 'adaptive'];
        case 'binoculars': return ['binoculars', 'magnifying_glass', 'adaptive'];
        case 'adaptive': return ['magnifying_glass', 'binoculars', 'adaptive'];
        default: return ['magnifying_glass', 'binoculars', scope];
      }
    })();

    const limit = options.limit || 24;
    let result = null;
    let candidates = [];

    for (const resolutionCandidate of resolutionPriority) {
      try {
        result = await radialSearch.getVAEDirectionalCandidates(
          targetTrack.identifier, latentIndex, polarity, { resolution: resolutionCandidate, limit }
        );
        candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        if (candidates.length > 0) break;
      } catch (innerError) {
        console.warn(`⚠️ VAE search failed for resolution ${resolutionCandidate}:`, innerError.message || innerError);
      }
    }

    if (candidates.length === 0) {
      console.log(`🚫 VAE direction ${directionKey} returned no candidates`);
      return;
    }

    const strategicSamples = selectStrategicSamples(candidates, targetTrack);

    const formattedTracks = strategicSamples.map(candidate => {
      const track = candidate.track || {};
      return {
        identifier: track.identifier, title: track.title, artist: track.artist,
        album: track.album, albumCover: track.albumCover, duration: track.length,
        loved: track.loved || false, playCount: track.playCount || 0,
        distance: candidate.distance, latentValue: candidate.latentValue,
        latentDelta: candidate.delta, vae: track.vae, features: track.features
      };
    });

    const totalAvailable = result.totalAvailable || formattedTracks.length;
    const neighborhoodSize = totalAvailable > 0 ? totalAvailable : formattedTracks.length;

    explorerData.directions[directionKey] = {
      direction: directionName, description, domain: 'vae',
      component: `latent_${latentIndex}`, polarity,
      trackCount: formattedTracks.length, totalNeighborhoodSize: neighborhoodSize,
      diversityScore: calculateDirectionDiversity(formattedTracks.length, neighborhoodSize),
      isOutlier: formattedTracks.length < 3,
      splitRatio: neighborhoodSize > 0 ? (formattedTracks.length / neighborhoodSize) : 0,
      sampleTracks: formattedTracks,
      originalSampleTracks: formattedTracks.map(track => ({ ...track }))
    };
  } catch (error) {
    console.error(`🚨 VAE SEARCH ERROR: Failed to explore latent direction ${directionKey}:`, error);
  }
}

async function exploreVaeDirections(explorerData, radialSearch, targetTrack, explorerResolution) {
  const latentVector = targetTrack?.vae?.latent;
  if (!Array.isArray(latentVector) || latentVector.length === 0) return;

  for (let index = 0; index < latentVector.length; index += 1) {
    await exploreVaeDirection(explorerData, radialSearch, index, 'positive', { targetTrack, explorerResolution });
    await exploreVaeDirection(explorerData, radialSearch, index, 'negative', { targetTrack, explorerResolution });
  }
}

// ─── Deduplication & post-processing ────────────────────────────────────────

function deduplicateTracksStrategically(directions, options = {}) {
  if (!directions || typeof directions !== 'object') return directions;

  const entries = Object.entries(directions);
  if (entries.length === 0) return directions;

  const maxCardsPerStack = Math.max(1, Number.isFinite(options.maxCardsPerStack) ? options.maxCardsPerStack : 12);
  const totalNeighborhoodSize = Number.isFinite(options.totalNeighborhoodSize) ? options.totalNeighborhoodSize : null;

  const cloneSampleEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.track && typeof entry.track === 'object') {
      return { ...entry, track: { ...entry.track } };
    }
    const clonedTrack = { ...entry };
    return { track: clonedTrack };
  };

  const stacks = entries.map(([directionKey, direction], index) => {
    const sampleTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.slice() : [];
    const domain = direction?.domain || '';
    const priority = (() => {
      if (domain === 'original') return 0;
      if (domain === 'vae') return 2;
      return 1;
    })();
    return { directionKey, direction, sampleTracks, pointer: 0, priority, originalIndex: index };
  });

  const finalDirections = {};
  stacks.forEach(stack => {
    const originalSamples = Array.isArray(stack.direction.originalSampleTracks)
      ? stack.direction.originalSampleTracks.map(cloneSampleEntry).filter(Boolean)
      : (Array.isArray(stack.direction.sampleTracks)
          ? stack.direction.sampleTracks.map(cloneSampleEntry).filter(Boolean)
          : []);
    finalDirections[stack.directionKey] = {
      ...stack.direction,
      key: stack.direction?.key || stack.directionKey,
      sampleTracks: [],
      originalSampleTracks: originalSamples
    };
  });

  const sortedStacks = stacks.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.originalIndex - b.originalIndex;
  });

  const usedTrackIds = new Set();
  let totalDealt = 0;

  for (let level = 0; level < maxCardsPerStack; level += 1) {
    let dealtAtLevel = false;
    for (const stack of sortedStacks) {
      while (stack.pointer < stack.sampleTracks.length) {
        const candidate = stack.sampleTracks[stack.pointer++];
        if (!candidate) continue;
        const trackId = candidate.identifier || candidate.track?.identifier;
        if (!trackId || usedTrackIds.has(trackId)) continue;
        const clonedEntry = cloneSampleEntry(candidate);
        if (clonedEntry) {
          finalDirections[stack.directionKey].sampleTracks.push(clonedEntry);
          usedTrackIds.add(trackId);
          totalDealt += 1;
          dealtAtLevel = true;
          break;
        }
      }
    }
    if (!dealtAtLevel) break;
  }

  Object.entries(finalDirections).forEach(([directionKey, direction]) => {
    const sampleCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
    direction.trackCount = sampleCount;
    direction.actualTrackCount = sampleCount;
    if (Number.isFinite(totalNeighborhoodSize) && totalNeighborhoodSize > 0) {
      direction.totalNeighborhoodSize = totalNeighborhoodSize;
      direction.splitRatio = sampleCount / totalNeighborhoodSize;
      direction.diversityScore = calculateDirectionDiversity(sampleCount, totalNeighborhoodSize);
    }
  });

  console.log(`🃏 Breadth-first dealing: ${totalDealt} cards dealt across ${sortedStacks.length} stacks (max ${maxCardsPerStack} per stack)`);

  entries.forEach(([directionKey]) => {
    if (!finalDirections[directionKey]) {
      finalDirections[directionKey] = directions[directionKey];
    }
  });

  return finalDirections;
}

function finalDeduplication(directions) {
  const trackAssignments = new Map();

  Object.entries(directions).forEach(([dirKey, dirData]) => {
    dirData.sampleTracks?.forEach((track, position) => {
      const trackId = track.identifier || track.track?.identifier;
      if (!trackId) return;
      const existing = trackAssignments.get(trackId);
      if (!existing || position < existing.bestPosition) {
        trackAssignments.set(trackId, { bestDirection: dirKey, bestPosition: position, track });
      }
    });
  });

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

function selectTopTrack(directions) {
  const DEFAULT_ALBUM = '/images/albumcover.png';
  const DEFAULT_KEY = '__default__';
  const coverOwners = new Map();

  const orderedDirections = Object.entries(directions)
    .sort((a, b) => {
      const countA = a[1].actualTrackCount ?? (Array.isArray(a[1].sampleTracks) ? a[1].sampleTracks.length : 0);
      const countB = b[1].actualTrackCount ?? (Array.isArray(b[1].sampleTracks) ? b[1].sampleTracks.length : 0);
      if (countA !== countB) return countA - countB;
      return a[0].localeCompare(b[0]);
    });

  orderedDirections.forEach(([directionKey, direction]) => {
    const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.slice() : [];
    if (samples.length === 0) return;

    const actualCount = direction.displayTrackCount ?? direction.actualTrackCount ?? samples.length;

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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getRandomSubset(array, size) {
  if (!Array.isArray(array) || array.length === 0 || size <= 0) return [];
  const copy = array.slice();
  shuffleArray(copy);
  return copy.slice(0, Math.min(size, copy.length));
}

function applyStackBudget(directions, config) {
  if (!directions || typeof directions !== 'object') {
    return { directions, stats: { trimmedSamples: 0, randomInjections: 0, finalSamples: 0 } };
  }

  const total = config.stackTotalCount || 0;
  if (!Number.isFinite(total) || total <= 0) {
    return { directions, stats: { trimmedSamples: 0, randomInjections: 0, finalSamples: 0 } };
  }

  const stats = { trimmedSamples: 0, randomInjections: 0, finalSamples: 0 };
  const randomCount = Math.min(config.stackRandomCount || 0, total);
  const deterministicLimit = Math.max(total - randomCount, 0);
  const usedIds = new Set();

  Object.entries(directions).forEach(([directionKey, direction]) => {
    const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
    let trimmed;
    const originalLength = samples.length;

    if (deterministicLimit === 0) {
      trimmed = [];
    } else {
      trimmed = samples.slice(0, Math.min(samples.length, deterministicLimit));
    }

    if (originalLength > trimmed.length) {
      stats.trimmedSamples += (originalLength - trimmed.length);
    }

    direction.sampleTracks = trimmed;
    direction.displayTrackCount = trimmed.length;
    trimmed.forEach(sample => {
      const track = sample.track || sample;
      const id = track?.identifier;
      if (id) usedIds.add(id);
    });
  });

  Object.entries(directions).forEach(([directionKey, direction]) => {
    if (!Array.isArray(direction.sampleTracks)) direction.sampleTracks = [];

    const currentTracks = direction.sampleTracks;
    const existingIds = new Set(currentTracks.map(sample => (sample.track || sample)?.identifier).filter(Boolean));
    const needed = total - currentTracks.length;

    if (needed <= 0) return;

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

    const picks = getRandomSubset(available, needed);

    picks.forEach(sample => {
      const clone = { ...sample, features: sample.features ? { ...sample.features } : sample.features };
      const track = clone.track || clone;
      const id = track?.identifier;
      if (id) {
        usedIds.add(id);
        existingIds.add(id);
      }
      currentTracks.push(clone);
    });
    stats.randomInjections += picks.length;

    direction.sampleTracks = currentTracks;
    const finalCount = currentTracks.length;
    direction.displayTrackCount = finalCount;
    direction.actualTrackCount = finalCount;
    direction.trackCount = finalCount;
    stats.finalSamples += finalCount;
  });

  return { directions, stats };
}

function sanitizeDirectionalStacks(directions) {
  if (!directions || typeof directions !== 'object') {
    return { directions, stats: { initialDirections: 0, totalSamples: 0, uniqueTracks: 0, duplicatesRemoved: 0, missingIdentifiers: 0 } };
  }

  const stats = {
    initialDirections: Object.keys(directions).length,
    totalSamples: 0, uniqueTracks: 0, duplicatesRemoved: 0, missingIdentifiers: 0
  };

  const globalAssignments = new Map();

  const normalizeStack = (directionKey, direction, location = 'primary') => {
    if (!direction || !Array.isArray(direction.sampleTracks)) return;

    const localSeen = new Set();
    const sanitized = [];

    direction.sampleTracks.forEach((entry, index) => {
      stats.totalSamples += 1;
      const trackId = entry?.identifier || entry?.track?.identifier;

      if (!trackId) {
        stats.missingIdentifiers += 1;
        return;
      }

      if (localSeen.has(trackId)) {
        stats.duplicatesRemoved += 1;
        return;
      }

      const existing = globalAssignments.get(trackId);
      if (existing) {
        stats.duplicatesRemoved += 1;
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

  stats.uniqueTracks = globalAssignments.size;

  const summaryParts = [
    `${stats.uniqueTracks} unique tracks retained`,
    `processed ${stats.totalSamples} samples`
  ];
  if (stats.duplicatesRemoved > 0) summaryParts.push(`removed ${stats.duplicatesRemoved} duplicates`);
  if (stats.missingIdentifiers > 0) summaryParts.push(`dropped ${stats.missingIdentifiers} missing-id entries`);
  console.log(`🧼 STACK SANITIZE: ${summaryParts.join(', ')}`);

  return { directions, stats };
}

function removeEmptyDirections(directions) {
  if (!directions || typeof directions !== 'object') {
    return { directions, stats: { removedDirections: 0, promotedOpposites: 0, droppedOpposites: 0 } };
  }

  const cleaned = {};
  const stats = { removedDirections: 0, promotedOpposites: 0, droppedOpposites: 0 };

  Object.entries(directions).forEach(([directionKey, direction]) => {
    const primaryTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
    const hasPrimaryTracks = primaryTracks.length > 0;
    const opposite = direction.oppositeDirection;
    const oppositeTracks = Array.isArray(opposite?.sampleTracks) ? opposite.sampleTracks : [];
    const hasOppositeTracks = oppositeTracks.length > 0;

    if (hasPrimaryTracks) {
      if (opposite && !hasOppositeTracks) {
        direction.hasOpposite = false;
        delete direction.oppositeDirection;
        stats.droppedOpposites += 1;
      }
      cleaned[directionKey] = direction;
      return;
    }

    if (hasOppositeTracks) {
      const promotedKey = opposite.key || `${directionKey}_opposite`;
      cleaned[promotedKey] = { ...opposite, hasOpposite: false };
      stats.promotedOpposites += 1;
      return;
    }

    stats.removedDirections += 1;
  });

  return { directions: cleaned, stats };
}

function prioritizeBidirectionalDirections(directions) {
  const pairs = new Map();
  const processedKeys = new Set();
  const finalDirections = {};

  const parseCount = (direction) => {
    const raw = direction?.trackCount;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return direction?.sampleTracks?.length || 0;
    }
    return numeric;
  };

  const processPair = (primaryData, oppositeData, primaryKey, oppositeKey) => {
    const primarySamples = primaryData.sampleTracks?.length || 0;
    const oppositeSamples = oppositeData.sampleTracks?.length || 0;
    const primaryCount = parseCount(primaryData);
    const oppositeCount = parseCount(oppositeData);

    let primary, opposite, pKey, oKey;

    if (primarySamples > oppositeSamples || (primarySamples === oppositeSamples && primaryCount >= oppositeCount)) {
      primary = primaryData; opposite = oppositeData; pKey = primaryKey; oKey = oppositeKey;
    } else {
      primary = oppositeData; opposite = primaryData; pKey = oppositeKey; oKey = primaryKey;
    }

    finalDirections[pKey] = {
      ...primary,
      hasOpposite: true,
      oppositeDirection: { ...opposite, key: oKey, hasOpposite: true }
    };

    processedKeys.add(primaryKey);
    processedKeys.add(oppositeKey);
  };

  Object.entries(directions).forEach(([directionKey, directionData]) => {
    if (processedKeys.has(directionKey)) return;

    const positiveMatch = directionKey.match(/^(.+)_positive$/);
    const negativeMatch = directionKey.match(/^(.+)_negative$/);

    if (positiveMatch) {
      const baseKey = positiveMatch[1];
      const negativeKey = `${baseKey}_negative`;
      const negativeData = directions[negativeKey] || directionData.oppositeDirection;

      if (negativeData) {
        processPair(directionData, negativeData, directionKey, negativeKey);
      } else {
        finalDirections[directionKey] = {
          ...directionData,
          hasOpposite: directionData.oppositeDirection ? true : directionData.hasOpposite
        };
        processedKeys.add(directionKey);
      }
    } else if (negativeMatch) {
      const baseKey = negativeMatch[1];
      const positiveKey = `${baseKey}_positive`;

      if (directions[positiveKey]) return; // Will be processed from positive side

      const positiveData = directionData.oppositeDirection || directions[positiveKey];
      if (positiveData) {
        processPair(positiveData, directionData, positiveKey, directionKey);
      } else {
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

  return finalDirections;
}

// limitToTopDimensions is async because of event-loop yields
async function limitToTopDimensions(directions, maxDimensions = 12) {
  const coreIndices = [
    'bpm', 'danceability', 'onset_rate', 'beat_punch', 'tonal_clarity',
    'spectral_centroid', 'spectral_energy', 'sub_drive', 'air_sizzle',
    'chord_strength', 'tuning_purity', 'fifths_strength'
  ];

  const categorizeDomain = (domainValue) => {
    if (!domainValue) return null;
    if (domainValue === 'vae') return 'vae';
    if (domainValue.startsWith('tonal')) return 'tonal';
    if (domainValue.startsWith('rhythmic')) return 'rhythmic';
    if (domainValue.startsWith('spectral')) return 'spectral';
    return null;
  };

  const dimensionMap = new Map();
  const coreMap = new Map();
  const pcaMap = new Map();
  const vaeMap = new Map();
  const availableCategories = new Set();

  const directionEntries = Object.entries(directions);
  for (let idx = 0; idx < directionEntries.length; idx++) {
    const [key, directionInfo] = directionEntries[idx];
    let dimensionName = key;

    const suffixes = ['_positive', '_negative', '_pc1', '_pc2', '_pc3'];
    for (const suffix of suffixes) {
      if (dimensionName.endsWith(suffix)) {
        dimensionName = dimensionName.replace(suffix, '');
        break;
      }
    }

    const directionObj = { key, ...directionInfo };
    const trackCount = directionObj.trackCount ?? (
      Array.isArray(directionObj.sampleTracks) ? directionObj.sampleTracks.length : 0
    );
    directionObj.trackCount = trackCount;
    if (directionObj.vae && !directionObj.domain) directionObj.domain = 'vae';

    const domain = directionObj.domain || null;
    const isCore = coreIndices.includes(dimensionName);

    let targetMap;
    if (isCore) {
      targetMap = coreMap;
    } else if (domain === 'vae') {
      targetMap = vaeMap;
    } else {
      targetMap = pcaMap;
    }

    if (!targetMap.has(dimensionName)) targetMap.set(dimensionName, []);
    targetMap.get(dimensionName).push(directionObj);

    if (!dimensionMap.has(dimensionName)) dimensionMap.set(dimensionName, []);
    dimensionMap.get(dimensionName).push(directionObj);

    const categoryKey = categorizeDomain(domain);
    if (categoryKey && trackCount > 0 && directionObj.isOutlier !== true) {
      availableCategories.add(categoryKey);
    }

    // Yield to event loop periodically
    if ((idx + 1) % 5 === 0) {
      await setImmediatePromise();
    }
  }

  const selectedDirections = {};

  const coreQuota = Math.min(Math.ceil(maxDimensions / 3), coreMap.size);
  const pcaQuota = Math.min(Math.ceil(maxDimensions / 3), pcaMap.size);
  const vaeQuota = Math.max(maxDimensions - coreQuota - pcaQuota, 0);

  const scoreDimension = (dimensionDirs) => {
    if (!dimensionDirs || dimensionDirs.length === 0) return -1;
    const validDirs = dimensionDirs.filter(d => d.trackCount > 0 && !d.isOutlier);
    if (validDirs.length === 0) return -1;
    const avgDiversity = validDirs.reduce((sum, d) => sum + (d.diversityScore || 0), 0) / validDirs.length;
    return avgDiversity * Math.sqrt(validDirs.length);
  };

  const selectFromMap = (map, quota) => {
    const scored = Array.from(map.entries())
      .map(([name, dirs]) => ({ name, dirs, score: scoreDimension(dirs) }))
      .filter(d => d.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, quota);
  };

  const coreSelected = selectFromMap(coreMap, coreQuota);
  const pcaSelected = selectFromMap(pcaMap, pcaQuota);
  const vaeSelected = selectFromMap(vaeMap, vaeQuota);

  // If any quota is unfilled, let others take the slots
  const allSelected = [...coreSelected, ...pcaSelected, ...vaeSelected]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDimensions);

  for (const { name, dirs } of allSelected) {
    for (const dir of dirs) {
      if (dir.key) {
        selectedDirections[dir.key] = directions[dir.key];
      }
    }
  }

  console.log(`📊 limitToTopDimensions: ${Object.keys(directions).length} → ${Object.keys(selectedDirections).length} (core: ${coreSelected.length}, pca: ${pcaSelected.length}, vae: ${vaeSelected.length})`);
  return selectedDirections;
}

function calculateExplorerDiversityMetrics(directions) {
  const directionEntries = Object.entries(directions);
  const validDirections = directionEntries.filter(([_, dir]) => dir.trackCount > 0);

  return {
    totalDirections: directionEntries.length,
    validDirections: validDirections.length,
    averageDiversityScore: validDirections.length > 0
      ? validDirections.reduce((sum, [_, dir]) => sum + dir.diversityScore, 0) / validDirections.length
      : 0,
    highestDiversityDirection: validDirections.length > 0
      ? validDirections.reduce((best, [key, dir]) =>
          dir.diversityScore > best[1].diversityScore ? [key, dir] : best
        )[0]
      : null,
    totalAvailableTracks: directionEntries.reduce((sum, [_, dir]) => sum + dir.trackCount, 0)
  };
}

function selectNextTrackFromExplorer(explorerData, sessionContext) {
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
    const anyDirection = Object.values(explorerData.directions)
      .find(dir => dir.sampleTracks.length > 0);
    if (anyDirection) {
      return {
        ...anyDirection.sampleTracks[0],
        direction: anyDirection.direction,
        transitionReason: 'autopilot',
        diversityScore: anyDirection.diversityScore,
        directionKey: Object.keys(explorerData.directions).find(key =>
          explorerData.directions[key] === anyDirection
        )
      };
    }
    return null;
  }

  const playedTrackIds = new Set(sessionContext.sessionHistoryIds || []);
  if (sessionContext.currentTrackId) {
    playedTrackIds.add(sessionContext.currentTrackId);
  }

  const failedTrackIds = new Set(sessionContext.failedTrackIds || []);

  let selectedDirectionKey = null;
  let selectedDirection = null;
  let selectedTrack = null;
  let skippedCandidates = 0;

  for (const [directionKey, directionData] of validDirections) {
    if (!Array.isArray(directionData.sampleTracks) || directionData.sampleTracks.length === 0) continue;

    const candidateIndex = directionData.sampleTracks.findIndex(candidate => {
      const candidateId = candidate?.identifier || candidate?.track?.identifier;
      if (!candidateId || playedTrackIds.has(candidateId)) return false;
      if (failedTrackIds.has(candidateId)) return false;
      return true;
    });

    if (candidateIndex === -1) {
      skippedCandidates += directionData.sampleTracks.length;
      continue;
    }

    selectedDirectionKey = directionKey;
    selectedDirection = directionData;
    selectedTrack = directionData.sampleTracks[candidateIndex];
    if (candidateIndex > 0) skippedCandidates += candidateIndex;
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

  if (skippedCandidates > 0) {
    console.log(`🎯 Skipped ${skippedCandidates} previously played candidates before selecting '${selectedTrack?.title || selectedTrackId}'`);
  }

  return {
    ...selectedTrack,
    direction: selectedDirection.direction,
    transitionReason: 'explorer',
    diversityScore: selectedDirection.diversityScore,
    weightedDiversityScore: selectedDirection.weightedDiversityScore,
    domain: selectedDirection.domain,
    directionKey: selectedDirectionKey,
    directionDescription: selectedDirection.description
  };
}

// ─── Radius adjustment (needs dynamicRadiusState — passed in and mutated) ───

function evaluateRadiusAdjustment(directionStats, retryDepth, dynamicRadiusState, config) {
  const MAX_RETRIES = 2;
  if (!directionStats) return { action: null, retry: false };

  const radiusState = dynamicRadiusState || {
    currentRadius: null, minRadius: 0.05, maxRadius: 2.0, starvationStreak: 0, abundanceStreak: 0
  };

  const totalDirections = directionStats.finalCount ?? 0;
  const trimmedSamples = directionStats.trimmedSamples ?? 0;
  const starvationThreshold = 2;
  const abundanceThreshold = 2;
  const desiredDirections = Math.min(config.stackTotalCount || 12, 12);

  if (totalDirections === 0) {
    radiusState.starvationStreak = (radiusState.starvationStreak || 0) + 1;
  } else {
    radiusState.starvationStreak = 0;
  }

  if (trimmedSamples > desiredDirections && totalDirections >= desiredDirections) {
    radiusState.abundanceStreak = (radiusState.abundanceStreak || 0) + 1;
  } else {
    radiusState.abundanceStreak = 0;
  }

  const now = Date.now();
  const safeRadius = Number.isFinite(radiusState.currentRadius) ? radiusState.currentRadius : 0.25;
  const minRadius = radiusState.minRadius ?? 0.05;
  const maxRadius = radiusState.maxRadius ?? 2.0;

  if (radiusState.starvationStreak >= starvationThreshold) {
    const current = safeRadius;
    const expanded = Math.min((current || 0.25) * 1.3 + 0.02, maxRadius);
    if (expanded > current + 0.0001) {
      radiusState.currentRadius = expanded;
      radiusState.starvationStreak = 0;
      radiusState.lastAdjustment = now;
      return {
        action: { action: 'expand', reason: 'starvation', from: current, to: expanded, timestamp: now, retry: retryDepth < MAX_RETRIES },
        retry: retryDepth < MAX_RETRIES
      };
    }
  }

  if (radiusState.abundanceStreak >= abundanceThreshold && Number.isFinite(safeRadius)) {
    const current = safeRadius;
    const shrunk = Math.max(current * 0.85, minRadius);
    if (shrunk < current - 0.0001) {
      radiusState.currentRadius = shrunk;
      radiusState.abundanceStreak = 0;
      radiusState.lastAdjustment = now;
      return {
        action: { action: 'shrink', reason: 'abundance', from: current, to: shrunk, timestamp: now, retry: retryDepth < MAX_RETRIES },
        retry: retryDepth < MAX_RETRIES
      };
    }
  }

  return { action: null, retry: false };
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

const ORIGINAL_FEATURES = [
  { name: 'bpm', positive: 'faster', negative: 'slower', description: 'Tempo' },
  { name: 'danceability', positive: 'more_danceable', negative: 'less_danceable', description: 'Jiggy' },
  { name: 'onset_rate', positive: 'busier_onsets', negative: 'sparser_onsets', description: 'Rhythmic density' },
  { name: 'beat_punch', positive: 'punchier_beats', negative: 'smoother_beats', description: 'Beat character' },
  { name: 'tonal_clarity', positive: 'more_tonal', negative: 'more_atonal', description: 'Tonality' },
  { name: 'tuning_purity', positive: 'purer_tuning', negative: 'looser_tuning', description: 'Tuning precision' },
  { name: 'fifths_strength', positive: 'stronger_fifths', negative: 'weaker_fifths', description: 'Harmonic strength' },
  { name: 'chord_strength', positive: 'stronger_chords', negative: 'weaker_chords', description: 'Chord definition' },
  { name: 'chord_change_rate', positive: 'faster_changes', negative: 'slower_changes', description: 'Harmonic movement' },
  { name: 'crest', positive: 'more_punchy', negative: 'smoother', description: 'Dynamic punch' },
  { name: 'entropy', positive: 'more_complex', negative: 'simpler', description: 'Complexity' },
  { name: 'spectral_centroid', positive: 'brighter', negative: 'darker', description: 'Brightness' },
  { name: 'spectral_rolloff', positive: 'fuller_spectrum', negative: 'narrower_spectrum', description: 'Spectral fullness' },
  { name: 'spectral_kurtosis', positive: 'peakier_spectrum', negative: 'flatter_spectrum', description: 'Spectral shape' },
  { name: 'spectral_energy', positive: 'more_energetic', negative: 'calmer', description: 'Energy level' },
  { name: 'spectral_flatness', positive: 'noisier', negative: 'more_tonal_spectrum', description: 'Spectral character' },
  { name: 'sub_drive', positive: 'more_bass', negative: 'less_bass', description: 'Low-end presence' },
  { name: 'air_sizzle', positive: 'more_air', negative: 'less_air', description: 'High-end sparkle' }
];

/**
 * Run the full explorer computation.
 *
 * @param {object} radialSearch - A RadialSearchService instance (with its own KD-tree)
 * @param {string} trackId - Track MD5 identifier to explore from
 * @param {object} sessionContext - Serialized session state
 * @param {object} config - Explorer configuration
 * @returns {object} { explorerData, radiusUsed, neighborhoodSize, dynamicRadiusState }
 */
async function runExplorerComputation(radialSearch, trackId, sessionContext, config) {
  const startTime = Date.now();

  const currentTrackData = radialSearch.kdTree.getTrack(trackId);
  if (!currentTrackData || !currentTrackData.pca) {
    return { explorerData: null, error: 'no_pca_data' };
  }

  const explorerData = { directions: {}, nextTrack: null, diversityMetrics: {} };
  const targetTrack = currentTrackData;

  // Reconstruct dynamicRadiusState from config hints
  const dynamicRadiusState = {
    currentRadius: config.dynamicRadiusHint ?? null,
    minRadius: 0.05,
    maxRadius: 2.0,
    starvationStreak: 0,
    abundanceStreak: 0
  };

  const retryDepth = config.retryDepth || 0;

  // ─── Neighborhood search ────────────────────────────────────────────
  let totalNeighborhood = [];
  let totalNeighborhoodSize = 0;
  let adaptiveRadiusResult = null;

  try {
    const adaptiveResult = await radialSearch.getAdaptiveNeighborhood(trackId, {
      targetMin: 350, targetMax: 450,
      initialRadius: config.dynamicRadiusHint
        ?? (config.cachedRadius != null ? config.cachedRadius : null),
      limit: 1500
    });

    if (adaptiveResult && Array.isArray(adaptiveResult.neighbors) && adaptiveResult.neighbors.length > 0) {
      totalNeighborhood = adaptiveResult.neighbors;
      totalNeighborhoodSize = totalNeighborhood.length;
      adaptiveRadiusResult = {
        radius: adaptiveResult.radius,
        count: adaptiveResult.count,
        iterations: adaptiveResult.iterations,
        withinTarget: adaptiveResult.withinTarget,
        scale: adaptiveResult.scale,
        targetMin: 350, targetMax: 450,
        cachedRadiusReused: Boolean(config.cachedRadius)
      };
      if (Number.isFinite(adaptiveResult.radius)) {
        dynamicRadiusState.currentRadius = adaptiveResult.radius;
      }
      console.log(`📊 Adaptive PCA radius tuned to ${adaptiveResult.radius?.toFixed(4) || 'n/a'}, neighbors=${totalNeighborhoodSize}`);
    } else {
      throw new Error('Adaptive PCA neighborhood empty');
    }
  } catch (adaptiveError) {
    console.warn('⚠️ Adaptive PCA search failed, falling back:', adaptiveError.message || adaptiveError);
    try {
      totalNeighborhood = radialSearch.kdTree.pcaRadiusSearch(currentTrackData, 'magnifying_glass', 'primary_d', 1000);
      totalNeighborhoodSize = totalNeighborhood.length;
      console.log(`📊 Calibrated PCA fallback returned: ${totalNeighborhoodSize} tracks`);
    } catch (pcaError) {
      console.error('📊 PCA radius search failed:', pcaError);
      const fallbackRadius = (config.cachedRadius != null && config.cachedRadius > 0) ? config.cachedRadius : 0.25;
      totalNeighborhood = radialSearch.kdTree.radiusSearch(currentTrackData, fallbackRadius, null, 1000);
      totalNeighborhoodSize = totalNeighborhood.length;
      console.log(`📊 Legacy radius search returned: ${totalNeighborhoodSize} tracks`);
    }
  }

  const neighborhoodSnapshot = Array.isArray(totalNeighborhood) && totalNeighborhood.length > 0
    ? totalNeighborhood.slice()
    : null;

  const neighborhoodStats = computeNeighborhoodStats(totalNeighborhood);

  if (totalNeighborhoodSize === 0) {
    console.warn('⚠️ Explorer neighborhood empty after all attempts; downstream stacks may be sparse');
  }

  explorerData.neighborhood = {
    size: totalNeighborhoodSize,
    radius: adaptiveRadiusResult ? adaptiveRadiusResult.radius : null,
    iterations: adaptiveRadiusResult ? adaptiveRadiusResult.iterations : 0,
    targetMin: 350, targetMax: 450,
    cachedRadiusReused: Boolean(config.cachedRadius),
    distanceStats: neighborhoodStats
  };

  const directionDiagnostics = {
    initialCount: 0, sanitizedCount: 0, finalCount: 0,
    duplicatesRemoved: 0, missingIdentifiers: 0, uniqueTracks: 0,
    removedDirections: 0, promotedOpposites: 0, droppedOpposites: 0,
    trimmedSamples: 0, randomInjections: 0, totalSamples: 0, finalSamples: 0
  };

  // ─── Search state for direction exploration ─────────────────────────
  const searchState = {
    explorerResolution: config.explorerResolution || 'adaptive',
    adaptiveRadius: adaptiveRadiusResult && Number.isFinite(adaptiveRadiusResult.radius)
      ? adaptiveRadiusResult.radius : null,
    neighborhoodSnapshot
  };

  // ─── PCA directions ─────────────────────────────────────────────────
  const pcaDirections = radialSearch.getPCADirections();
  let pcaPairCount = 0;
  for (const [domain, domainInfo] of Object.entries(pcaDirections)) {
    if (domain === 'primary_d') {
      console.log('📊 Skipping primary_d directions (internal use only)');
      continue;
    }
    for (const [component, componentInfo] of Object.entries(domainInfo)) {
      await exploreDirection(explorerData, radialSearch, domain, component,
        componentInfo.positive, componentInfo.description, 'positive',
        totalNeighborhoodSize, targetTrack, searchState);
      await exploreDirection(explorerData, radialSearch, domain, component,
        componentInfo.negative, componentInfo.description, 'negative',
        totalNeighborhoodSize, targetTrack, searchState);
      pcaPairCount++;
      if (pcaPairCount % 2 === 0) await setImmediatePromise();
    }
  }

  // ─── Original features ──────────────────────────────────────────────
  const sessionFilterContext = {
    sessionHistoryCount: sessionContext.sessionHistoryIds?.length || 0,
    noArtist: sessionContext.noArtist,
    noAlbum: sessionContext.noAlbum,
    seenArtists: sessionContext.seenArtists || [],
    seenAlbums: sessionContext.seenAlbums || [],
    currentTrackId: sessionContext.currentTrackId
  };

  for (let featureIdx = 0; featureIdx < ORIGINAL_FEATURES.length; featureIdx++) {
    const feature = ORIGINAL_FEATURES[featureIdx];
    await exploreOriginalFeatureDirection(explorerData, radialSearch, feature, 'positive',
      totalNeighborhoodSize, targetTrack, sessionFilterContext);
    await exploreOriginalFeatureDirection(explorerData, radialSearch, feature, 'negative',
      totalNeighborhoodSize, targetTrack, sessionFilterContext);
    if ((featureIdx + 1) % 3 === 0) await setImmediatePromise();
  }

  // ─── VAE directions ─────────────────────────────────────────────────
  if (currentTrackData.vae?.latent && Array.isArray(currentTrackData.vae.latent)) {
    console.log(`🧠 Exploring VAE latent directions (${currentTrackData.vae.latent.length} axes)`);
    await exploreVaeDirections(explorerData, radialSearch, targetTrack, searchState.explorerResolution);
  }

  // ─── Post-processing pipeline ───────────────────────────────────────
  explorerData.directions = await limitToTopDimensions(explorerData.directions, 12);

  explorerData.directions = deduplicateTracksStrategically(explorerData.directions, {
    maxCardsPerStack: 12,
    totalNeighborhoodSize
  });

  explorerData.directions = finalDeduplication(explorerData.directions);

  // Recalculate diversity metrics
  Object.entries(explorerData.directions).forEach(([directionKey, direction]) => {
    const actualCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
    direction.actualTrackCount = actualCount;
    direction.isOutlier = actualCount < 3;
    direction.totalNeighborhoodSize = totalNeighborhoodSize;
    const optionsBonus = Math.min(actualCount / 10, 2.0);
    const baseScore = totalNeighborhoodSize > 0
      ? calculateDirectionDiversity(actualCount, totalNeighborhoodSize)
      : calculateDirectionDiversity(actualCount, actualCount || 1);
    direction.diversityScore = baseScore;
    direction.trackCount = actualCount;
    direction.adjustedDiversityScore = baseScore * optionsBonus;
  });

  explorerData.directions = prioritizeBidirectionalDirections(explorerData.directions);

  const initialDirectionCount = Object.keys(explorerData.directions || {}).length;
  directionDiagnostics.initialCount = initialDirectionCount;

  const sanitizeResult = sanitizeDirectionalStacks(explorerData.directions);
  explorerData.directions = sanitizeResult.directions;
  directionDiagnostics.sanitizedCount = Object.keys(explorerData.directions || {}).length;
  directionDiagnostics.duplicatesRemoved = sanitizeResult.stats.duplicatesRemoved;
  directionDiagnostics.missingIdentifiers = sanitizeResult.stats.missingIdentifiers;
  directionDiagnostics.uniqueTracks = sanitizeResult.stats.uniqueTracks;
  directionDiagnostics.totalSamples = sanitizeResult.stats.totalSamples;

  const removalResult = removeEmptyDirections(explorerData.directions);
  explorerData.directions = removalResult.directions;
  directionDiagnostics.removedDirections = removalResult.stats.removedDirections;
  directionDiagnostics.promotedOpposites = removalResult.stats.promotedOpposites;
  directionDiagnostics.droppedOpposites = removalResult.stats.droppedOpposites;

  const stackBudgetResult = applyStackBudget(explorerData.directions, config);
  explorerData.directions = stackBudgetResult.directions;
  directionDiagnostics.trimmedSamples = stackBudgetResult.stats.trimmedSamples;
  directionDiagnostics.randomInjections = stackBudgetResult.stats.randomInjections;
  directionDiagnostics.finalSamples = stackBudgetResult.stats.finalSamples;
  explorerData.directions = selectTopTrack(explorerData.directions);
  directionDiagnostics.finalCount = Object.keys(explorerData.directions || {}).length;

  // ─── Radius adjustment ──────────────────────────────────────────────
  const radiusDiagnostics = adaptiveRadiusResult
    ? { mode: 'adaptive', ...adaptiveRadiusResult }
    : { mode: 'fallback', radius: config.cachedRadius ?? null, cachedRadiusReused: Boolean(config.cachedRadius) };

  const radiusFeedback = evaluateRadiusAdjustment(directionDiagnostics, retryDepth, dynamicRadiusState, config);
  if (radiusFeedback.action) radiusDiagnostics.adjustment = radiusFeedback.action;

  explorerData.diagnostics = {
    timestamp: Date.now(),
    currentTrackId: trackId,
    radius: radiusDiagnostics,
    neighborhood: { total: totalNeighborhoodSize, distanceStats: neighborhoodStats },
    directionStats: directionDiagnostics,
    radiusRetryDepth: retryDepth
  };

  // Handle retry
  if (radiusFeedback.retry) {
    console.warn(`🔁 Explorer starvation detected (depth ${retryDepth}); expanding radius to ${dynamicRadiusState.currentRadius?.toFixed(4) || 'n/a'} and retrying`);
    return await runExplorerComputation(radialSearch, trackId, sessionContext, {
      ...config,
      dynamicRadiusHint: dynamicRadiusState.currentRadius,
      retryDepth: retryDepth + 1
    });
  }

  // ─── Diversity & next track ─────────────────────────────────────────
  explorerData.diversityMetrics = calculateExplorerDiversityMetrics(explorerData.directions);
  explorerData.nextTrack = selectNextTrackFromExplorer(explorerData, sessionContext);
  explorerData.resolution = config.explorerResolution || 'adaptive';

  const computeTimeMs = Date.now() - startTime;

  return {
    explorerData,
    radiusUsed: adaptiveRadiusResult?.radius ?? null,
    neighborhoodSize: totalNeighborhoodSize,
    dynamicRadiusState,
    computeTimeMs
  };
}


module.exports = {
  runExplorerComputation,
  // Exported for testing
  computeNeighborhoodStats,
  calculateDirectionDiversity,
  selectStrategicSamples,
  filterSessionRepeats,
  deduplicateTracksStrategically,
  finalDeduplication,
  selectTopTrack,
  applyStackBudget,
  sanitizeDirectionalStacks,
  removeEmptyDirections,
  prioritizeBidirectionalDirections,
  limitToTopDimensions,
  calculateExplorerDiversityMetrics,
  selectNextTrackFromExplorer,
  evaluateRadiusAdjustment
};
