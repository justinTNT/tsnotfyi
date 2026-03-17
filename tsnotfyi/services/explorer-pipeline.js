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
  'slower',
  'less_danceable',
  'more_atonal',
  'simpler',
  'smoother',
  'sparser_onsets',
  'looser_tuning',
  'weaker_fifths',
  'weaker_chords',
  'slower_changes',
  'less_bass',
  'less_air',
  'calmer',
  'darker'
]);

function isNegativeDirectionKey(directionKey) {
  if (!directionKey || typeof directionKey !== 'string') {
    return false;
  }
  if (directionKey.includes('_negative')) {
    return true;
  }
  return NEGATIVE_DIRECTION_KEYS.has(directionKey);
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

function computeNeighborhoodStats(neighborhoodEntries) {
  if (!Array.isArray(neighborhoodEntries) || neighborhoodEntries.length === 0) {
    return {
      count: 0,
      distanceCount: 0,
      min: null,
      max: null,
      median: null,
      average: null,
      p95: null
    };
  }

  const distances = neighborhoodEntries
    .map(entry => {
      if (!entry) return null;
      const dist = Number(entry.distance);
      if (Number.isFinite(dist)) {
        return dist;
      }
      const similarity = Number(entry.similarity);
      return Number.isFinite(similarity) ? similarity : null;
    })
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);

  const stats = {
    count: neighborhoodEntries.length,
    distanceCount: distances.length,
    min: null,
    max: null,
    median: null,
    average: null,
    p95: null
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
      if (distances.length % 2 === 0) {
        stats.median = (distances[mid - 1] + distances[mid]) / 2;
      } else {
        stats.median = distances[mid];
      }
      const p95Index = Math.min(distances.length - 1, Math.floor(distances.length * 0.95));
      stats.p95 = distances[p95Index];
    }
  }

  return stats;
}

// Calculate diversity score based on neighborhood splitting
// Optimal discriminator creates 75/25 split (clear direction + meaningful alternative)
// 50/50 is acceptable, 95/5 or 5/95 is poor (no clear direction or no alternative)
function calculateDirectionDiversity(trackCount, totalNeighborhoodSize) {
  if (trackCount === 0 || totalNeighborhoodSize === 0) return 0;

  const ratio = trackCount / totalNeighborhoodSize;

  // Reward ratios that give us both direction and alternative
  // Peak scoring at 75/25 (0.75) and 25/75 (0.25)
  let score;

  if (ratio >= 0.70 && ratio <= 0.80) {
    // 70-80% range: ideal discriminator (clear majority + meaningful minority)
    score = 100 - Math.abs(ratio - 0.75) * 200; // Peak at 0.75
  } else if (ratio >= 0.20 && ratio <= 0.30) {
    // 20-30% range: good minority direction (meaningful alternative)
    score = 100 - Math.abs(ratio - 0.25) * 200; // Peak at 0.25
  } else if (ratio >= 0.45 && ratio <= 0.55) {
    // 45-55% range: balanced split (acceptable but less directional pull)
    score = 80 - Math.abs(ratio - 0.50) * 100; // Peak at 0.50, max 80 points
  } else if (ratio >= 0.30 && ratio <= 0.70) {
    // 30-70% range: decent discriminators
    const distanceFrom50 = Math.abs(ratio - 0.50);
    const distanceFrom75 = Math.min(Math.abs(ratio - 0.75), Math.abs(ratio - 0.25));
    score = 60 + (distanceFrom50 * 40) - (distanceFrom75 * 20);
  } else {
    // < 20% or > 80%: poor discriminators (too extreme)
    const extremeness = ratio < 0.20 ? (0.20 - ratio) : (ratio - 0.80);
    score = Math.max(0, 40 - (extremeness * 200));
  }

  return Math.max(0, Math.min(100, score));
}

function calculateVariance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
}

// Calculate overall explorer diversity metrics
function calculateExplorerDiversityMetrics(directions) {
  const directionEntries = Object.entries(directions);
  const validDirections = directionEntries.filter(([_, dir]) => dir.trackCount > 0);

  return {
    totalDirections: directionEntries.length,
    validDirections: validDirections.length,
    averageDiversityScore: validDirections.length > 0 ?
      validDirections.reduce((sum, [_, dir]) => sum + dir.diversityScore, 0) / validDirections.length : 0,
    highestDiversityDirection: validDirections.length > 0 ?
      validDirections.reduce((best, [key, dir]) =>
        dir.diversityScore > best[1].diversityScore ? [key, dir] : best
      )[0] : null,
    totalAvailableTracks: directionEntries.reduce((sum, [_, dir]) => sum + dir.trackCount, 0)
  };
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getRandomSubset(array, size) {
  if (!Array.isArray(array) || array.length === 0 || size <= 0) {
    return [];
  }

  const copy = array.slice();
  shuffleArray(copy);
  return copy.slice(0, Math.min(size, copy.length));
}

// Helper: Extract dimensional value for a track given a direction key
function getTrackDimensionValue(track, directionKey) {
  // Handle PCA directions (e.g., 'spectral_pc1_positive', 'tonal_pc2_negative')
  const pcaMatch = directionKey.match(/^(tonal|spectral|rhythmic)_pc(\d+)_(positive|negative)$/);
  if (pcaMatch) {
    const [, domain, componentNum, polarity] = pcaMatch;
    const componentIndex = parseInt(componentNum) - 1; // pc1 -> 0, pc2 -> 1, pc3 -> 2

    if (track.pca && track.pca[domain]) {
      return track.pca[domain][componentIndex];
    }
    return null;
  }

  // Handle primary_d direction
  if (directionKey === 'primary_d_positive' || directionKey === 'primary_d_negative') {
    if (track.pca && track.pca.primary_d !== undefined) {
      return track.pca.primary_d;
    }
    return null;
  }

  // Handle traditional feature directions (faster/slower, brighter/darker, etc.)
  const featureMap = {
    'faster': 'bpm', 'slower': 'bpm',
    'brighter': 'spectral_centroid', 'darker': 'spectral_centroid',
    'more_energetic': 'energy', 'calmer': 'energy',
    'more_danceable': 'danceability', 'less_danceable': 'danceability',
    'more_tonal': 'harmony', 'more_atonal': 'harmony',
    'more_complex': 'spectral_complexity', 'simpler': 'spectral_complexity',
    'more_punchy': 'spectral_rolloff', 'smoother': 'spectral_rolloff',
    'denser_onsets': 'tempo', 'sparser_onsets': 'tempo'
  };

  const featureName = featureMap[directionKey];
  if (featureName && track.features && track.features[featureName] !== undefined) {
    return track.features[featureName];
  }

  return null; // Unknown dimension
}

function getOppositeDirection(directionKey) {
  // Handle PCA directions
  if (directionKey.includes('_positive')) {
    return directionKey.replace('_positive', '_negative');
  }
  if (directionKey.includes('_negative')) {
    return directionKey.replace('_negative', '_positive');
  }

  // Handle traditional directions
  const oppositeDirections = {
    'faster': 'slower',
    'slower': 'faster',
    'brighter': 'darker',
    'darker': 'brighter',
    'more_energetic': 'calmer',
    'calmer': 'more_energetic',
    'more_danceable': 'less_danceable',
    'less_danceable': 'more_danceable',
    'more_tonal': 'more_atonal',
    'more_atonal': 'more_tonal',
    'more_complex': 'simpler',
    'simpler': 'more_complex',
    'more_punchy': 'smoother',
    'smoother': 'more_punchy'
  };
  return oppositeDirections[directionKey];
}

function selectStrategicSamples(candidates, targetTrack, maxSamples) {
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length === 1) return candidates;

  const withMetrics = candidates.map(c => ({
    ...c,
    track: c.track || c,
    dirDist: c.distance || c.similarity || 0,
    priDist: Math.abs((c.track || c).pca?.primary_d || 0)
  }));

  // Two sorted arrays: by direction distance and by primary distance
  const byDir = [...withMetrics].sort((a, b) => a.dirDist - b.dirDist);
  const byPri = [...withMetrics].sort((a, b) => a.priDist - b.priDist);

  const dealt = new Set();
  const result = [];

  const currentIdentifier = targetTrack?.identifier || null;

  const tryDeal = (arr, idx) => {
    if (idx < 0 || idx >= arr.length) return false;
    const c = arr[idx];
    const id = c.track?.identifier || c.identifier;
    if (!id) return false;
    if (currentIdentifier && id === currentIdentifier) return false; // Never surface the current track in suggestion stacks
    if (dealt.has(id)) return false;
    dealt.add(id);
    result.push(c);
    return true;
  };

  // Interleave: front of byDir, back of byDir, front of byPri, back of byPri
  for (let i = 0; result.length < candidates.length && i < Math.max(byDir.length, byPri.length); i++) {
    tryDeal(byDir, i);                    // Closest by direction
    tryDeal(byDir, byDir.length - 1 - i); // Furthest by direction
    tryDeal(byPri, i);                    // Closest by primary
    tryDeal(byPri, byPri.length - 1 - i); // Furthest by primary
  }

  return result;
}

// Filter tracks based on session-level noArtist/noAlbum flags
// sessionContext = { seenArtists, seenAlbums, noArtist, noAlbum, currentTrack, sessionHistory }
function filterSessionRepeats(tracks, sessionContext) {
  const originalCount = tracks.length;

  // Disable session filtering for the first few tracks to prevent core direction starvation
  const trackCount = sessionContext.sessionHistory ? sessionContext.sessionHistory.length : 0;
  if (trackCount <= 3) {
    console.log(`🔓 Session filtering DISABLED - only ${trackCount} tracks played, allowing all ${originalCount} candidates`);
    return tracks;
  }

  const filtered = tracks.filter(trackObj => {
    // Handle both direct track objects and wrapped candidate objects
    const track = trackObj.track || trackObj;

    // ALWAYS exclude current track to prevent duplicates
    if (sessionContext.currentTrack && track.identifier === sessionContext.currentTrack.identifier) {
      return false;
    }

    // Filter out seen artists if noArtist is enabled
    if (sessionContext.noArtist && track.artist && sessionContext.seenArtists.has(track.artist)) {
      return false;
    }

    // Filter out seen albums if noAlbum is enabled
    if (sessionContext.noAlbum && track.album && sessionContext.seenAlbums.has(track.album)) {
      return false;
    }

    return true;
  });

  if (filtered.length < originalCount) {
    console.log(`🚫 Session filtering: ${originalCount - filtered.length} tracks removed (${filtered.length} remaining)`);
  }

  // If filtering removed ALL candidates, fallback to unfiltered for core directions
  if (filtered.length === 0 && originalCount > 0) {
    console.log(`🚨 Session filtering removed ALL candidates! Falling back to unfiltered list for core directions`);
    return tracks;
  }

  return filtered;
}

// Smart filtering: exclude played tracks, deprioritize seen tracks and their artists/albums
// sessionContext = { currentTrack, sessionHistory, seenTracks, seenTrackArtists, seenTrackAlbums }
function filterAndDeprioritizeCandidates(tracks, sessionContext) {
  if (!tracks || tracks.length === 0) return [];

  const scored = tracks.map((trackObj, index) => {
    const track = trackObj.track || trackObj;
    // Start with existing sort order priority (higher index = lower priority)
    let priority = 1.0 - (index / tracks.length); // 1.0 for first track, approaching 0 for last

    // HARD EXCLUSION: Already played tracks
    if (sessionContext.currentTrack && track.identifier === sessionContext.currentTrack.identifier) {
      return null; // Will be filtered out
    }

    // Check if track was actually played this session
    const wasPlayed = sessionContext.sessionHistory.some(({identifier}) =>
      identifier === track.identifier
    );
    if (wasPlayed) {
      return null; // HARD EXCLUDE: No track repeats ever
    }

    // AGGRESSIVE DEPRIORITIZATION: Tracks that were SEEN (top of stack or selected as next)
    if (sessionContext.seenTracks.has(track.identifier)) {
      priority *= 0.05; // 95% penalty for seen tracks
    }

    // GENTLE DEPRIORITIZATION: Artists from seen tracks
    if (track.artist && sessionContext.seenTrackArtists.has(track.artist)) {
      priority *= 0.5; // 50% penalty for artists from seen tracks
    }

    // GENTLE DEPRIORITIZATION: Albums from seen tracks
    if (track.album && sessionContext.seenTrackAlbums.has(track.album)) {
      priority *= 0.2; // 80% penalty for albums from seen tracks
    }

    return {
      ...trackObj,
      _priority: priority,
      _originalIndex: index
    };
  }).filter(item => item !== null); // Remove hard exclusions

  // Sort by priority (high to low), with small randomization for diversity
  return scored.sort((a, b) => {
    // Add small random factor to prevent deterministic ordering
    const randomA = a._priority * (0.95 + Math.random() * 0.1);
    const randomB = b._priority * (0.95 + Math.random() * 0.1);
    return randomB - randomA;
  });
}

// Strategic deduplication using breadth-first dealing with domain-aware priority
function deduplicateTracksStrategically(directions, options = {}) {
  if (!directions || typeof directions !== 'object') {
    return directions;
  }

  const entries = Object.entries(directions);
  if (entries.length === 0) {
    return directions;
  }

  const maxCardsPerStack = Math.max(1, Number.isFinite(options.maxCardsPerStack) ? options.maxCardsPerStack : 12);
  const totalNeighborhoodSize = Number.isFinite(options.totalNeighborhoodSize) ? options.totalNeighborhoodSize : null;

  const cloneSampleEntry = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    if (entry.track && typeof entry.track === 'object') {
      return {
        ...entry,
        track: { ...entry.track }
      };
    }

    const clonedTrack = { ...entry };
    return { track: clonedTrack };
  };

  const stacks = entries.map(([directionKey, direction], index) => {
    const sampleTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.slice() : [];
    const domain = direction?.domain || '';
    const priority = (() => {
      // Priority: core features first, then PCA, then VAE
      if (domain === 'original') return 0;  // Core features highest priority
      if (domain === 'vae') return 2;       // VAE lowest priority
      return 1;                              // PCA (tonal, spectral, rhythmic) middle
    })();
    return {
      directionKey,
      direction,
      sampleTracks,
      pointer: 0,
      priority,
      originalIndex: index
    };
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
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.originalIndex - b.originalIndex;
  });

  const usedTrackIds = new Set();
  let totalDealt = 0;

  for (let level = 0; level < maxCardsPerStack; level += 1) {
    let dealtAtLevel = false;

    for (const stack of sortedStacks) {
      while (stack.pointer < stack.sampleTracks.length) {
        const candidate = stack.sampleTracks[stack.pointer++];
        if (!candidate) {
          continue;
        }

        const trackId = candidate.identifier || candidate.track?.identifier;
        if (!trackId || usedTrackIds.has(trackId)) {
          continue;
        }

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

    if (!dealtAtLevel) {
      break;
    }
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

// Ensure each stack reports unique tracks (within the stack and across all stacks)
function sanitizeDirectionalStacks(directions) {
  if (!directions || typeof directions !== 'object') {
    return {
      directions,
      stats: {
        initialDirections: 0,
        totalSamples: 0,
        uniqueTracks: 0,
        duplicatesRemoved: 0,
        missingIdentifiers: 0
      }
    };
  }

  const stats = {
    initialDirections: Object.keys(directions).length,
    totalSamples: 0,
    uniqueTracks: 0,
    duplicatesRemoved: 0,
    missingIdentifiers: 0
  };

  const globalAssignments = new Map(); // trackId -> { directionKey, location }

  const normalizeStack = (directionKey, direction, location = 'primary') => {
    if (!direction || !Array.isArray(direction.sampleTracks)) {
      return;
    }

    const localSeen = new Set();
    const sanitized = [];

    direction.sampleTracks.forEach((entry, index) => {
      stats.totalSamples += 1;
      const trackId = entry?.identifier || entry?.track?.identifier;

      if (!trackId) {
        stats.missingIdentifiers += 1;
        console.warn(`🧼 STACK SANITIZE: Dropping track without identifier from ${directionKey}/${location} (index ${index})`);
        return;
      }

      if (localSeen.has(trackId)) {
        stats.duplicatesRemoved += 1;
        console.warn(`🧼 STACK SANITIZE: Removed local duplicate ${trackId} from ${directionKey}/${location} (index ${index})`);
        return;
      }

      const existing = globalAssignments.get(trackId);
      if (existing) {
        stats.duplicatesRemoved += 1;
        const title = entry?.title || entry?.track?.title || trackId;
        console.warn(`🧼 STACK SANITIZE: Removed ${title} (${trackId}) from ${directionKey}/${location}; already assigned to ${existing.directionKey}/${existing.location}`);
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
  if (stats.duplicatesRemoved > 0) {
    summaryParts.push(`removed ${stats.duplicatesRemoved} duplicates`);
  }
  if (stats.missingIdentifiers > 0) {
    summaryParts.push(`dropped ${stats.missingIdentifiers} missing-id entries`);
  }
  console.log(`🧼 STACK SANITIZE: ${summaryParts.join(', ')}`);

  return { directions, stats };
}

// Remove directions that lost all candidates after sanitization
function removeEmptyDirections(directions) {
  if (!directions || typeof directions !== 'object') {
    return {
      directions,
      stats: {
        removedDirections: 0,
        promotedOpposites: 0,
        droppedOpposites: 0
      }
    };
  }

  const cleaned = {};
  const stats = {
    removedDirections: 0,
    promotedOpposites: 0,
    droppedOpposites: 0
  };

  Object.entries(directions).forEach(([directionKey, direction]) => {
    const primaryTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
    const hasPrimaryTracks = primaryTracks.length > 0;

    const opposite = direction.oppositeDirection;
    const oppositeTracks = Array.isArray(opposite?.sampleTracks) ? opposite.sampleTracks : [];
    const hasOppositeTracks = oppositeTracks.length > 0;

    if (hasPrimaryTracks) {
      if (opposite && !hasOppositeTracks) {
        console.warn(`🧼 STACK SANITIZE: Dropping empty opposite stack for ${directionKey}`);
        direction.hasOpposite = false;
        delete direction.oppositeDirection;
        stats.droppedOpposites += 1;
      }
      cleaned[directionKey] = direction;
      return;
    }

    if (hasOppositeTracks) {
      const promotedKey = opposite.key || `${directionKey}_opposite`;
      console.warn(`🧼 STACK SANITIZE: Promoting opposite stack ${promotedKey} after ${directionKey} lost all candidates`);
      cleaned[promotedKey] = {
        ...opposite,
        hasOpposite: false
      };
      stats.promotedOpposites += 1;
      return;
    }

    console.warn(`🧼 STACK SANITIZE: Removing ${directionKey} entirely (no candidates remain)`);
    stats.removedDirections += 1;
  });

  return { directions: cleaned, stats };
}

// Prioritize bidirectional directions: larger stack becomes primary, smaller becomes opposite
function prioritizeBidirectionalDirections(directions) {
  explorerLog(`⚖️ PRIORITIZATION START: Processing ${Object.keys(directions).length} directions`);
  explorerLog(`⚖️ Direction keys:`, Object.keys(directions));

  const pairs = new Map(); // baseKey -> {positive: dirData, negative: dirData}
  const processedKeys = new Set();
  const finalDirections = {};

  // Group directions into bidirectional pairs
  Object.entries(directions).forEach(([directionKey, directionData]) => {
    // Skip if already processed as part of a pair
    if (processedKeys.has(directionKey)) return;

    // Check for bidirectional pairs (positive/negative)
    const positiveMatch = directionKey.match(/^(.+)_positive$/);
    const negativeMatch = directionKey.match(/^(.+)_negative$/);

    explorerLog(`⚖️ CHECKING: ${directionKey} -> positive: ${!!positiveMatch}, negative: ${!!negativeMatch}`);

    if (positiveMatch) {
      const baseKey = positiveMatch[1];
      const negativeKey = `${baseKey}_negative`;

      const positiveData = directionData;
      const negativeData = directions[negativeKey] || directionData.oppositeDirection;

      if (negativeData) {
        const parseCount = (direction) => {
          const raw = direction?.trackCount;
          const numeric = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(numeric) || numeric <= 0) {
            return direction?.sampleTracks?.length || 0;
          }
          return numeric;
        };

        const positiveSamples = positiveData.sampleTracks?.length || 0;
        const negativeSamples = negativeData.sampleTracks?.length || 0;
        const positiveCount = parseCount(positiveData);
        const negativeCount = parseCount(negativeData);

        explorerLog(`⚖️ BIDIRECTIONAL PAIR: ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

        let primaryDirection, oppositeDirection, primaryKey, oppositeKey;

        if (positiveSamples > negativeSamples || (positiveSamples === negativeSamples && positiveCount >= negativeCount)) {
          primaryDirection = positiveData;
          oppositeDirection = negativeData;
          primaryKey = directionKey;
          oppositeKey = negativeKey;
        } else if (negativeSamples > positiveSamples || (negativeSamples === positiveSamples && negativeCount > positiveCount)) {
          primaryDirection = negativeData;
          oppositeDirection = positiveData;
          primaryKey = negativeKey;
          oppositeKey = directionKey;
        } else {
          explorerLog(`⚖️ Equal sizes (${positiveSamples} samples), preferring positive for ${baseKey}`);
          primaryDirection = positiveData;
          oppositeDirection = negativeData;
          primaryKey = directionKey;
          oppositeKey = negativeKey;
        }

        finalDirections[primaryKey] = {
          ...primaryDirection,
          hasOpposite: true,
          oppositeDirection: {
            ...oppositeDirection,
            key: oppositeKey,
            hasOpposite: true
          }
        };

        explorerLog(`⚖️ PRIMARY: ${primaryKey} (${primaryDirection.sampleTracks?.length || 0} tracks) with embedded opposite ${oppositeKey} (${oppositeDirection.sampleTracks?.length || 0} tracks)`);

        processedKeys.add(directionKey);
        processedKeys.add(negativeKey);
      } else {
        explorerLog(`⚖️ BIDIRECTIONAL PAIR: nothing found for negative ${negativeKey}`);
        finalDirections[directionKey] = {
          ...directionData,
          hasOpposite: directionData.oppositeDirection ? true : directionData.hasOpposite
        };
        processedKeys.add(directionKey);
      }
    } else if (negativeMatch) {
      const baseKey = negativeMatch[1];
      const positiveKey = `${baseKey}_positive`;

      if (directions[positiveKey]) {
        return;
      }

      const positiveData = directionData.oppositeDirection || directions[positiveKey];
      if (positiveData) {
        explorerLog(`⚖️ NEGATIVE MATCH using embedded positive for ${baseKey}`);

        const parseCount = (direction) => {
          const raw = direction?.trackCount;
          const numeric = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(numeric) || numeric <= 0) {
            return direction?.sampleTracks?.length || 0;
          }
          return numeric;
        };

        const positiveSamples = positiveData.sampleTracks?.length || 0;
        const negativeSamples = directionData.sampleTracks?.length || 0;
        const positiveCount = parseCount(positiveData);
        const negativeCount = parseCount(directionData);

        explorerLog(`⚖️ BIDIRECTIONAL PAIR (negative first): ${baseKey} - positive samples:${positiveSamples}, tracks:${positiveCount} vs negative samples:${negativeSamples}, tracks:${negativeCount}`);

        let primaryDirection, oppositeDirection, primaryKey, oppositeKey;
        if (negativeSamples > positiveSamples || (negativeSamples === positiveSamples && negativeCount >= positiveCount)) {
          primaryDirection = directionData;
          oppositeDirection = positiveData;
          primaryKey = directionKey;
          oppositeKey = positiveKey;
        } else {
          primaryDirection = positiveData;
          oppositeDirection = directionData;
          primaryKey = positiveKey;
          oppositeKey = directionKey;
        }

        finalDirections[primaryKey] = {
          ...primaryDirection,
          hasOpposite: true,
          oppositeDirection: {
            ...oppositeDirection,
            key: oppositeKey,
            hasOpposite: true
          }
        };

        processedKeys.add(directionKey);
        processedKeys.add(positiveKey);
      } else {
        explorerLog(`⚖️ BIDIRECTIONAL PAIR: nothing found for positive ${positiveKey}`);
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

  explorerLog(`⚖️ BIDIRECTIONAL PRIORITIZATION: Processed ${Object.keys(directions).length} dimensions -> ${Object.keys(finalDirections).length} final dimensions`);
  return finalDirections;
}

// Assign tracks exclusively to their best-fitting directions (legacy method)
function deduplicateTracksAcrossDirections(directions) {
  // Collect all track-direction assignments with scores
  const trackAssignments = new Map(); // trackId -> [{directionKey, score}, ...]

  // Collect all candidates from all directions
  Object.entries(directions).forEach(([directionKey, directionInfo]) => {
    if (directionInfo.sampleTracks) {
      directionInfo.sampleTracks.forEach(track => {
        const trackId = track.identifier || track.track?.identifier;
        if (!trackId) return;

        if (!trackAssignments.has(trackId)) {
          trackAssignments.set(trackId, []);
        }

        // Use diversity score or distance as assignment score (higher = better fit)
        const score = track.diversityScore || (1 / (track.distance || 1));
        trackAssignments.get(trackId).push({
          directionKey,
          score,
          track: track.track || track
        });
      });
    }
  });

  // Assign each track to its best-fitting direction
  const exclusiveDirections = {};
  Object.keys(directions).forEach(key => {
    exclusiveDirections[key] = {
      ...directions[key],
      sampleTracks: []
    };
  });

  trackAssignments.forEach((assignments, trackId) => {
    // Find the direction with the highest score for this track
    const bestAssignment = assignments.sort((a, b) => b.score - a.score)[0];

    // Add track only to its best-fitting direction
    exclusiveDirections[bestAssignment.directionKey].sampleTracks.push(bestAssignment.track);
  });

  console.log(`🎯 Deduplication complete: ${trackAssignments.size} unique tracks distributed across ${Object.keys(directions).length} directions`);

  return exclusiveDirections;
}

// Final deduplication: Each card appears in only one stack (highest position wins)
function finalDeduplication(directions) {
  const trackAssignments = new Map(); // trackId -> {bestDirection, bestPosition, track}

  // Find the best position for each track across all directions
  Object.entries(directions).forEach(([dirKey, dirData]) => {
    dirData.sampleTracks?.forEach((track, position) => {
      const trackId = track.identifier || track.track?.identifier;
      if (!trackId) return;

      const existing = trackAssignments.get(trackId);
      if (!existing || position < existing.bestPosition) {
        trackAssignments.set(trackId, {
          bestDirection: dirKey,
          bestPosition: position,
          track: track
        });
      }
    });
  });

  // Remove tracks from all stacks except their best position
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

// Pick the most suitable top track for each direction (prefer unique album covers and real art)
function selectTopTrack(directions) {
  const DEFAULT_ALBUM = '/images/albumcover.png';
  const DEFAULT_KEY = '__default__';
  const coverOwners = new Map(); // coverKey -> { directionKey, count }

  const orderedDirections = Object.entries(directions)
    .sort((a, b) => {
      const countA = a[1].actualTrackCount ?? (Array.isArray(a[1].sampleTracks) ? a[1].sampleTracks.length : 0);
      const countB = b[1].actualTrackCount ?? (Array.isArray(b[1].sampleTracks) ? b[1].sampleTracks.length : 0);
      if (countA !== countB) return countA - countB;
      return a[0].localeCompare(b[0]);
    });

  orderedDirections.forEach(([directionKey, direction]) => {
    const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.slice() : [];
    if (samples.length === 0) {
      return;
    }

    const actualCount = direction.displayTrackCount
      ?? direction.actualTrackCount
      ?? samples.length;

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

// Debug: Check for duplicate cards across all stacks and validate dimension values
function debugDuplicateCards(directions) {
  const trackPositions = new Map(); // trackId -> [{direction, position, distance, value, dimValue}]
  const opposites = new Map(); // direction -> oppositeDirection

  // Build opposite direction mappings
  Object.keys(directions).forEach(dirKey => {
    const opposite = getOppositeDirection(dirKey);
    if (opposite && directions[opposite]) {
      opposites.set(dirKey, opposite);
    }
  });

  // Collect all track positions with dimension values
  Object.entries(directions).forEach(([dirKey, dirData]) => {
    dirData.sampleTracks?.forEach((track, position) => {
      const trackId = track.identifier || track.track?.identifier;
      if (!trackId) return;

      const fullTrack = track.track || track; // Handle nested track structure
      const dimValue = getTrackDimensionValue(fullTrack, dirKey);

      if (!trackPositions.has(trackId)) {
        trackPositions.set(trackId, []);
      }

      trackPositions.get(trackId).push({
        direction: dirKey,
        position: position,
        distance: track.distance,
        dimValue: dimValue,
        title: track.title || track.track?.title || 'Unknown',
        artist: track.artist || track.track?.artist || 'Unknown'
      });
    });
  });

  // Check for duplicates and validate dimension values
  let totalDuplicates = 0;
  let oppositeDuplicates = 0;
  let dimensionViolations = 0;

  trackPositions.forEach((positions, trackId) => {
    if (positions.length > 1) {
      totalDuplicates++;

      // Check if any duplicates are in opposite directions
      const hasOpposites = positions.some(pos1 =>
        positions.some(pos2 =>
          pos1.direction !== pos2.direction &&
          opposites.get(pos1.direction) === pos2.direction
        )
      );

      if (hasOpposites) {
        oppositeDuplicates++;

        // For opposite pairs, validate they differ by expected amount
        positions.forEach(pos1 => {
          const opposite = opposites.get(pos1.direction);
          const pos2 = positions.find(p => p.direction === opposite);

          if (pos2 && pos1.dimValue !== null && pos2.dimValue !== null) {
            const isNegativeDir = isNegativeDirectionKey(pos1.direction);
            const expectedDifference = isNegativeDir ?
              pos2.dimValue - pos1.dimValue : // negative direction should have lower value
              pos1.dimValue - pos2.dimValue;  // positive direction should have higher value

            if (expectedDifference <= 0) {
              dimensionViolations++;
              console.error(`🎯❌ DIMENSION VIOLATION: "${pos1.title}" in ${pos1.direction} has value ${pos1.dimValue?.toFixed(3)}, in ${pos2.direction} has ${pos2.dimValue?.toFixed(3)} - expected separation!`);
            } else {
              console.log(`🎯✅ Dimension validated: "${pos1.title}" ${pos1.direction}=${pos1.dimValue?.toFixed(3)} vs ${pos2.direction}=${pos2.dimValue?.toFixed(3)} (diff: ${expectedDifference.toFixed(3)})`);
            }
          }
        });

        console.error(`🃏❌ OPPOSITE DUPLICATE: "${positions[0].title}" appears in opposite directions:`,
          positions.map(p => `${p.direction}[${p.position}] (dist: ${p.distance?.toFixed(3)}, dim: ${p.dimValue?.toFixed(3)})`).join(', ')
        );
      } else {
        console.log(`🃏⚠️  Cross-dimensional duplicate: "${positions[0].title}" in ${positions.length} stacks:`,
          positions.map(p => `${p.direction}[${p.position}] (dim: ${p.dimValue?.toFixed(3)})`).join(', ')
        );
      }
    }
  });

  console.log(`🃏 DUPLICATE SUMMARY: ${totalDuplicates} total duplicates, ${oppositeDuplicates} in opposite directions`);
  console.log(`🎯 DIMENSION SUMMARY: ${dimensionViolations} dimension violations found`);

  if (oppositeDuplicates > 0) {
    console.error(`🃏🚨 CRITICAL: Found ${oppositeDuplicates} tracks in opposite directions - radial search inner radius may be too small!`);
  }

  if (dimensionViolations > 0) {
    console.error(`🎯🚨 CRITICAL: Found ${dimensionViolations} dimension violations - tracks not properly separated by dimensional values!`);
  }
}

// Limit directions to top N dimensions with quota system ensuring 1/3 are core indices
async function limitToTopDimensions(directions, maxDimensions = 12) {
  // Define core indices that should be prioritized
  const coreIndices = [
    'bpm', 'danceability', 'onset_rate', 'beat_punch', 'tonal_clarity',
    'spectral_centroid', 'spectral_energy', 'sub_drive', 'air_sizzle',
    'chord_strength', 'tuning_purity', 'fifths_strength'
  ];
  console.log(`📊 Defined core indices: [${coreIndices.join(', ')}]`);

  const categorizeDomain = (domainValue) => {
    if (!domainValue) return null;
    if (domainValue === 'vae') return 'vae';
    if (domainValue.startsWith('tonal')) return 'tonal';
    if (domainValue.startsWith('rhythmic')) return 'rhythmic';
    if (domainValue.startsWith('spectral')) return 'spectral';
    return null;
  };

  const getCategoryCounts = (dimensions) => {
    const counts = { vae: 0, tonal: 0, rhythmic: 0, spectral: 0 };
    dimensions.forEach(dim => {
      const primary = Array.isArray(dim?.bestDirections) ? dim.bestDirections[0] : null;
      const category = primary ? categorizeDomain(primary.domain) : null;
      if (category) {
        counts[category] += 1;
      }
    });
    return counts;
  };

  const requiredCategories = ['vae', 'tonal', 'rhythmic', 'spectral'];

  const logVaeSummary = (tag, map) => {
    const vaeDimensions = Array.from(map.entries())
      .filter(([_, dirs]) => Array.isArray(dirs) && dirs.some(dir => dir?.domain === 'vae'))
      .map(([name, dirs]) => ({
        name,
        count: dirs.filter(dir => dir?.domain === 'vae').length,
        total: dirs.length
      }));

    if (vaeDimensions.length > 0) {
      console.log(`🧠 VAE visibility (${tag}):`, vaeDimensions);
    } else {
      console.log(`🧠 VAE visibility (${tag}): none`);
    }
  };

  const dimensionMap = new Map();
  const coreMap = new Map();
  const pcaMap = new Map();
  const vaeMap = new Map();
  const availableCategories = new Set();

  // Group directions by their base dimension and classify as core or PCA
  const directionEntries = Object.entries(directions);
  console.log(`🔍 Processing ${directionEntries.length} directions for dimension classification...`);
  for (let idx = 0; idx < directionEntries.length; idx++) {
    const [key, directionInfo] = directionEntries[idx];
    let dimensionName = key;
    console.log(`🔍 Processing direction: ${key}`);

    // Extract base dimension by removing common suffixes
    const suffixes = ['_positive', '_negative', '_pc1', '_pc2', '_pc3'];
    for (const suffix of suffixes) {
      if (dimensionName.endsWith(suffix)) {
        dimensionName = dimensionName.replace(suffix, '');
        console.log(`🔍   Extracted base dimension: ${dimensionName} (removed ${suffix})`);
        break;
      }
    }

    const directionObj = { key, ...directionInfo };
    const trackCount = directionObj.trackCount ?? (
      Array.isArray(directionObj.sampleTracks) ? directionObj.sampleTracks.length : 0
    );
    directionObj.trackCount = trackCount;
    if (directionObj.vae && !directionObj.domain) {
      directionObj.domain = 'vae';
    }

    // Classify as core or PCA dimension
    const domain = directionObj.domain || null;
    const isCore = coreIndices.includes(dimensionName);
    if (domain === 'vae') {
      console.log('🧠 VAE direction candidate detected', {
        key,
        dimensionName,
        trackCount,
        diversityScore: directionObj.diversityScore,
        isOutlier: directionObj.isOutlier
      });
    }
    console.log(`🔍   Is '${dimensionName}' a core index? ${isCore}`);
    if (isCore) {
      console.log(`✅   Adding '${dimensionName}' to CORE map`);
    } else if (domain === 'vae') {
      console.log(`🧠   Adding '${dimensionName}' to VAE map`);
    } else {
      console.log(`🧮   Adding '${dimensionName}' to PCA map`);
    }
    let targetMap;
    if (isCore) {
      targetMap = coreMap;
    } else if (domain === 'vae') {
      targetMap = vaeMap;
    } else {
      targetMap = pcaMap;
    }

    if (!targetMap.has(dimensionName)) {
      targetMap.set(dimensionName, []);
    }
    targetMap.get(dimensionName).push(directionObj);

    // Also add to general map for fallback
    if (!dimensionMap.has(dimensionName)) {
      dimensionMap.set(dimensionName, []);
    }
    dimensionMap.get(dimensionName).push(directionObj);

    const categoryKey = categorizeDomain(domain);
    if (categoryKey && trackCount > 0 && directionObj.isOutlier !== true) {
      availableCategories.add(categoryKey);
    }
    // Yield to the event loop periodically so audio streaming keeps flowing
    if ((idx + 1) % 5 === 0) {
      await setImmediatePromise();
    }
  }

  logVaeSummary('post-grouping', dimensionMap);
  logVaeSummary('core-map', coreMap);
  logVaeSummary('pca-map', pcaMap);
  logVaeSummary('vae-map', vaeMap);

  console.log(`🔍 Classification complete:`);
  console.log(`🔍   Core indices found: [${Array.from(coreMap.keys()).join(', ')}]`);
  console.log(`🔍   PCA indices found: [${Array.from(pcaMap.keys()).join(', ')}]`);
  console.log(`🔍   Total dimensions: [${Array.from(dimensionMap.keys()).join(', ')}]`);

  const selectedDirections = {};

  // Calculate quota: core gets priority, then PCA, VAE fills remaining slots
  const coreQuota = Math.min(Math.ceil(maxDimensions / 3), coreMap.size);  // ~4 core slots
  const pcaQuota = Math.min(Math.ceil(maxDimensions / 3), pcaMap.size);    // ~4 PCA slots
  const vaeQuota = Math.max(maxDimensions - coreQuota - pcaQuota, 0);      // VAE gets remainder
  console.log(`🎯 Dimension quota: ${coreQuota} core, ${pcaQuota} PCA, ${vaeQuota} VAE (max: ${maxDimensions})`);
  console.log(`🎯 Available dimensions: ${coreMap.size} core, ${pcaMap.size} PCA, ${vaeMap.size} VAE groups, ${dimensionMap.size} total`);

  // Helper function to select best directions from dimension list
  // Returns both directions if they form a good discriminator (75/25 split)
  const selectBestDirections = (dirList, dimName = 'unknown') => {
    console.log(`🔍 selectBestDirections for '${dimName}': ${dirList.length} total directions`);
    dirList.forEach((dir, i) => {
      console.log(`🔍   [${i}] ${dir.key}: ${dir.trackCount} tracks, outlier: ${dir.isOutlier}, diversity: ${dir.diversityScore?.toFixed(1) || 'N/A'}`);
    });

    const validDirs = dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier);
    console.log(`🔍   -> ${validDirs.length} valid directions after filtering`);

    if (validDirs.length === 0) {
      console.log(`🚫   -> NO VALID DIRECTIONS for '${dimName}'`);
      return [];
    }

    // Sort by diversity score
    const sortedDirs = validDirs.sort((a, b) => {
      if (Math.abs(a.diversityScore - b.diversityScore) < 0.1) {
        return b.trackCount - a.trackCount; // Prefer larger if diversity is similar
      }
      return b.diversityScore - a.diversityScore; // Higher diversity wins
    });

    // Check if we have a good discriminator (both directions score well)
    const topDirection = sortedDirs[0];

    if (sortedDirs.length >= 2) {
      const isVaeDimension = sortedDirs.some(dir => dir.domain === 'vae');
      if (isVaeDimension) {
        console.log(`✅   -> Keeping all VAE directions for '${dimName}' (${sortedDirs.length} variants)`);
        return sortedDirs;
      }
      const limited = sortedDirs.slice(0, 2);
      console.log(`✅   -> Keeping both polarities for '${dimName}' (primary '${limited[0].key}', secondary '${limited[1].key}')`);
      return limited;
    }

    console.log(`✅   -> Only one usable direction '${topDirection.key}' for '${dimName}' (${topDirection.trackCount} tracks, diversity: ${topDirection.diversityScore?.toFixed(1)})`);
    return [topDirection];
  };

  // Step 1: Select core indices (guaranteed quota)
  console.log(`🎯 Core indices available:`, Array.from(coreMap.keys()));
  console.log(`🎯 Core indices with valid directions:`,
    Array.from(coreMap.entries())
      .map(([dimName, dirList]) => ({
        dimName,
        validDirections: dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier).length,
        totalDirections: dirList.length
      }))
  );

  const coreCandidates = [];
  const coreEntries = Array.from(coreMap.entries());
  for (let idx = 0; idx < coreEntries.length; idx++) {
    const [dimName, dirList] = coreEntries[idx];
    const candidate = {
      dimName,
      bestDirections: selectBestDirections(dirList, dimName),
      isCore: true,
      allDirections: dirList.length,
      validDirections: dirList.filter(dir => dir.trackCount > 0 && !dir.isOutlier).length
    };
    coreCandidates.push(candidate);
    if ((idx + 1) % 3 === 0) {
      await setImmediatePromise();
    }
  }

  const vaeCandidates = Array.from(vaeMap.entries()).map(([dimName, dirList]) => ({
    dimName,
    bestDirections: selectBestDirections(dirList, dimName),
    isCore: false,
    isVae: true
  })).filter(dim => dim.bestDirections.length > 0);

  const sortedCoreDimensions = coreCandidates
    .filter(dim => {
      if (dim.bestDirections.length === 0) {
        console.log(`🚫 Core dimension '${dim.dimName}' has no valid directions (${dim.validDirections}/${dim.allDirections})`);
        return false;
      }
      return true;
    })
    .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
    .slice(0, coreQuota);

  console.log(`🎯 Selected ${sortedCoreDimensions.length}/${coreQuota} core dimensions:`,
    sortedCoreDimensions.map(d => `${d.dimName} (${d.bestDirections.length} directions, primary diversity: ${d.bestDirections[0].diversityScore.toFixed(1)})`));

  // Step 2: Select PCA/other dimensions for remaining slots
  const pcaCandidates = [];
  const pcaEntries = Array.from(pcaMap.entries());
  for (let idx = 0; idx < pcaEntries.length; idx++) {
    const [dimName, dirList] = pcaEntries[idx];
    pcaCandidates.push({
      dimName,
      bestDirections: selectBestDirections(dirList, dimName),
      isCore: false
    });
    if ((idx + 1) % 3 === 0) {
      await setImmediatePromise();
    }
  }

  const sortedPcaDimensions = pcaCandidates
    .filter(dim => dim.bestDirections.length > 0) // Only dimensions with valid directions
    .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
    .slice(0, pcaQuota);

  console.log(`🎯 Selected ${sortedPcaDimensions.length}/${pcaQuota} PCA dimensions:`,
    sortedPcaDimensions.map(d => d.dimName));

  // Step 3: Select VAE dimensions for remaining slots
  const sortedVaeDimensions = vaeCandidates
    .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
    .slice(0, vaeQuota);

  console.log(`🎯 Selected ${sortedVaeDimensions.length}/${vaeQuota} VAE dimensions:`,
    sortedVaeDimensions.map(d => d.dimName));

  // Combine selections: core first, then PCA, then VAE
  const finalDimensions = [...sortedCoreDimensions, ...sortedPcaDimensions, ...sortedVaeDimensions];

  // If we don't have enough dimensions (shouldn't happen), fill from general pool
  if (finalDimensions.length < maxDimensions) {
    const usedDimensions = new Set(finalDimensions.map(d => d.dimName));
    const remainingCandidates = [];
    const dimensionEntries2 = Array.from(dimensionMap.entries())
      .filter(([dimName]) => !usedDimensions.has(dimName));

    for (let idx = 0; idx < dimensionEntries2.length; idx++) {
      const [dimName, dirList] = dimensionEntries2[idx];
      remainingCandidates.push({
        dimName,
        bestDirections: selectBestDirections(dirList, dimName),
        isCore: false
      });
      if ((idx + 1) % 5 === 0) {
        await setImmediatePromise();
      }
    }

    const remainingDimensions = remainingCandidates
      .filter(dim => dim.bestDirections.length > 0)
      .sort((a, b) => b.bestDirections[0].diversityScore - a.bestDirections[0].diversityScore)
      .slice(0, maxDimensions - finalDimensions.length);

    finalDimensions.push(...remainingDimensions);
  }

  const availableCategoryList = requiredCategories.filter(cat => availableCategories.has(cat));
  const usedDimensions = new Set(finalDimensions.map(d => d.dimName));

  const findAdditionalDimension = (category) => {
    const pool = category === 'vae' ? vaeCandidates : pcaCandidates;
    const ranked = pool
      .filter(candidate => !usedDimensions.has(candidate.dimName)
        && candidate.bestDirections.length > 0
        && (category === 'vae'
          ? true
          : categorizeDomain(candidate.bestDirections[0]?.domain) === category))
      .sort((a, b) => (
        (b.bestDirections[0]?.diversityScore ?? 0) - (a.bestDirections[0]?.diversityScore ?? 0)
      ));
    return ranked[0] || null;
  };

  const enforceDomainDiversity = () => {
    if (availableCategoryList.length < 2) {
      console.warn('⚠️ Domain diversity requirement skipped (insufficient categories available)', {
        availableCategories: availableCategoryList
      });
      return;
    }

    let categoryCounts = getCategoryCounts(finalDimensions);
    let presentCategories = requiredCategories.filter(cat => categoryCounts[cat] > 0);

    while (presentCategories.length < 2) {
      const missingOptions = availableCategoryList.filter(cat => !presentCategories.includes(cat));
      if (missingOptions.length === 0) {
        break;
      }
      const targetCategory = missingOptions[0];
      const additionalDimension = findAdditionalDimension(targetCategory);
      if (!additionalDimension) {
        console.warn(`⚠️ No candidates available to cover '${targetCategory}' domain for explorer diversity`);
        const index = availableCategoryList.indexOf(targetCategory);
        if (index !== -1) {
          availableCategoryList.splice(index, 1);
        }
        if (availableCategoryList.length < 2) {
          break;
        }
        continue;
      }
      console.log(`🎯 Domain diversity: injecting '${additionalDimension.dimName}' (${targetCategory})`);
      finalDimensions.push(additionalDimension);
      usedDimensions.add(additionalDimension.dimName);
      categoryCounts = getCategoryCounts(finalDimensions);
      presentCategories = requiredCategories.filter(cat => categoryCounts[cat] > 0);
    }

    while (finalDimensions.length > maxDimensions) {
      const removalOptions = finalDimensions
        .map((dim, idx) => {
          const remaining = finalDimensions.filter((_, i) => i !== idx);
          const countsAfterRemoval = getCategoryCounts(remaining);
          const categoriesAfterRemoval = requiredCategories.filter(cat => countsAfterRemoval[cat] > 0);
          const canRemove = categoriesAfterRemoval.length >= 2 || categoriesAfterRemoval.length === 0;
          return {
            idx,
            canRemove,
            diversity: dim.bestDirections?.[0]?.diversityScore ?? 0
          };
        })
        .filter(option => option.canRemove)
        .sort((a, b) => a.diversity - b.diversity);

      if (removalOptions.length === 0) {
        console.warn('⚠️ Unable to trim explorer dimensions without violating diversity requirement');
        break;
      }

      const removed = finalDimensions.splice(removalOptions[0].idx, 1)[0];
      usedDimensions.delete(removed.dimName);
      categoryCounts = getCategoryCounts(finalDimensions);
      presentCategories = requiredCategories.filter(cat => categoryCounts[cat] > 0);
    }

    categoryCounts = getCategoryCounts(finalDimensions);
    presentCategories = requiredCategories.filter(cat => categoryCounts[cat] > 0);
    if (presentCategories.length < 2) {
      console.warn('⚠️ Domain diversity still below target after adjustments', {
        available: availableCategoryList,
        finalCategories: presentCategories,
        counts: categoryCounts
      });
    } else {
      console.log('✅ Domain diversity satisfied for explorer selection', {
        categories: presentCategories,
        counts: categoryCounts
      });
    }
  };

  enforceDomainDiversity();

  // Build final directions object - send BOTH directions as top-level entries
  // hasOpposite is only true when opposite has at least one distinct track
  finalDimensions.forEach(({ bestDirections }) => {
    const extractIds = (tracks) => new Set(
      (tracks || []).map(s => (s?.track || s)?.identifier).filter(Boolean)
    );

    bestDirections.forEach((direction, idx) => {
      const oppositeDirection = bestDirections[idx === 0 ? 1 : 0] || null;

      // Check if opposite has at least one distinct track
      let hasDistinctOpposite = false;
      if (oppositeDirection) {
        const primaryIds = extractIds(direction.sampleTracks);
        const oppositeIds = extractIds(oppositeDirection.sampleTracks);
        hasDistinctOpposite = [...oppositeIds].some(id => !primaryIds.has(id));
      }

      selectedDirections[direction.key] = {
        direction: direction.direction,
        description: direction.description,
        domain: direction.domain,
        component: direction.component,
        polarity: direction.polarity,
        trackCount: direction.trackCount,
        totalNeighborhoodSize: direction.totalNeighborhoodSize,
        sampleTracks: direction.sampleTracks,
        diversityScore: direction.diversityScore,
        isOutlier: direction.isOutlier,
        splitRatio: direction.splitRatio,
        hasOpposite: hasDistinctOpposite,
        oppositeDirection: hasDistinctOpposite ? {
          key: oppositeDirection.key,
          direction: oppositeDirection.direction,
          sampleTracks: oppositeDirection.sampleTracks
        } : null
      };
    });
  });

  Object.entries(selectedDirections).forEach(([key, dir]) => {
    const samples = Array.isArray(dir.sampleTracks) ? dir.sampleTracks : [];
    const hasValidSample = samples.some(sample => {
      const track = sample?.track || sample;
      return track && track.identifier;
    });
    if (!hasValidSample) {
      explorerLog(`⚠️ Removing direction '${key}' from explorer set (no valid sample tracks)`, {
        trackCount: dir.trackCount,
        domain: dir.domain,
        hasOpposite: dir.hasOpposite
      });
      delete selectedDirections[key];
    }
  });

  console.log(`🎯 Selected ${finalDimensions.length} dimensions producing ${Object.keys(selectedDirections).length} total directions`);
  return selectedDirections;
}

// ─── Near-Pure Functions (require radialSearch and/or session context) ────────

// Explore a specific PCA direction
// searchContext = { resolution, adaptiveRadius, neighborhoodSnapshot }
async function exploreDirection(radialSearch, explorerData, domain, component, directionName, description, polarity, totalNeighborhoodSize, targetTrack, searchContext) {
  const directionKey = polarity ? `${domain}_${component}_${polarity}` : `${domain}_${polarity || component}`;

  try {
    const searchConfig = {
      resolution: (searchContext && searchContext.resolution) || 'adaptive',
      limit: 40,
      adaptiveRadius: searchContext && searchContext.adaptiveRadius && Number.isFinite(searchContext.adaptiveRadius.radius)
        ? searchContext.adaptiveRadius.radius
        : null,
      precomputedNeighbors: searchContext && Array.isArray(searchContext.neighborhoodSnapshot) && searchContext.neighborhoodSnapshot.length > 0
        ? searchContext.neighborhoodSnapshot
        : null
    };

    const candidates = await radialSearch.getPCADirectionalCandidates(
      targetTrack.identifier,
      domain,
      component,
      polarity || component,
      searchConfig
    );

    const trackCount = candidates.totalAvailable || 0;
    // Smart filtering: exclude played tracks, deprioritize actually seen tracks/artists/albums
    // const smartFiltered = filterAndDeprioritizeCandidates(candidates.candidates || []);
    // TODO: later?
    const strategicSamples = selectStrategicSamples(candidates.candidates || [], targetTrack);

    const formattedTracks = strategicSamples.map(sample => {
      const track = sample.track || sample;
      const pcaSlices = radialSearch.kdTree.calculatePcaContributionFractions(
        targetTrack,
        track,
        domain,
        `${directionKey}:${track.identifier}`,
        component
      );
      const distanceSlices = {
        kind: 'pca',
        domain,
        reference: {
          key: pcaSlices.referenceKey,
          distance: pcaSlices.referenceDistance
        },
        total: pcaSlices.total,
        slices: pcaSlices.slices
      };
      return {
        identifier: track.identifier,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumCover: track.albumCover,
        duration: track.length,
        distance: sample.distance,
        pca: track.pca,
        features: track.features,
        distanceSlices,
        pcaDistanceSlices: {
          referenceKey: pcaSlices.referenceKey,
          referenceDistance: pcaSlices.referenceDistance,
          total: pcaSlices.total,
          slices: pcaSlices.slices
        }
      };
    });

    const originalSamples = formattedTracks.map(track => ({
      ...track,
      features: track.features ? { ...track.features } : track.features
    }));

    // Skip directions with 0 tracks (completely ignore them)
    if (trackCount === 0) {
      return;
    }

    // Skip directions that select nearly everything (useless)
    if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
      console.log(`🚫 Ignoring direction ${directionKey}: selects too many tracks (${trackCount}/${totalNeighborhoodSize})`);
      return; // Don't even add to explorerData
    }

    explorerData.directions[directionKey] = {
      direction: directionName,
      description: description,
      domain: domain,
      component: component,
      polarity: polarity,
      trackCount: formattedTracks.length,
      totalNeighborhoodSize: totalNeighborhoodSize,
      diversityScore: calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
      isOutlier: formattedTracks.length < 3,
      splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
      sampleTracks: formattedTracks,
      originalSampleTracks: originalSamples
    };
  } catch (error) {
    console.error(`Failed to explore direction ${directionKey}:`, error);
    explorerData.directions[directionKey] = {
      direction: directionName,
      description: description,
      domain: domain,
      component: component,
      polarity: polarity,
      sampleTracks: [],
      error: error.message
    };
  }
}

// Explore original feature direction using legacy directional search
// sessionContext = { seenArtists, seenAlbums, noArtist, noAlbum, currentTrack, sessionHistory, filterSessionRepeats, selectStrategicSamples }
async function exploreOriginalFeatureDirection(radialSearch, explorerData, feature, polarity, totalNeighborhoodSize, targetTrack, sessionContext) {
  const direction = polarity === 'positive' ? feature.positive : feature.negative;
  const directionKey = `${feature.name}_${polarity}`;

  try {
    if (VERBOSE_EXPLORER) {
      console.log(`🔍 CORE SEARCH: Starting legacy search for '${direction}' (feature: ${feature.name})`);
      console.log(`🔍 CORE SEARCH: Target track identifier: ${targetTrack.identifier}`);
      console.log(`🔍 CORE SEARCH: Calling radialSearch.getDirectionalCandidates('${targetTrack.identifier}', '${direction}')`);
    }

    // Use legacy directional search for original features - get all candidates
    const candidates = await radialSearch.getDirectionalCandidates(
      targetTrack.identifier,
      direction
      // No limit - get all available candidates for strategic sampling
    );

    if (VERBOSE_EXPLORER) {
      console.log(`🔍 CORE SEARCH RESULT: candidates object:`, candidates);
      console.log(`🔍 CORE SEARCH RESULT: candidates.totalAvailable = ${candidates.totalAvailable}`);
      console.log(`🔍 CORE SEARCH RESULT: candidates.candidates.length = ${candidates.candidates?.length || 'undefined'}`);

      if (candidates.candidates && candidates.candidates.length > 0) {
        console.log(`🔍 CORE SEARCH RESULT: First 3 candidates:`, candidates.candidates.slice(0, 3));
      } else {
        console.log(`🚨 CORE SEARCH PROBLEM: No candidates returned for '${direction}' - this should not happen for core features!`);
      }
    }

    const trackCount = candidates.totalAvailable || 0;
    if (VERBOSE_EXPLORER) {
      console.log(`🔍 CORE FILTERING: Before session filtering: ${candidates.candidates?.length || 0} candidates`);
      console.log(`🔍 CORE FILTERING: Session state - seenArtists: ${sessionContext.seenArtists.size}, seenAlbums: ${sessionContext.seenAlbums.size}, noArtist: ${sessionContext.noArtist}, noAlbum: ${sessionContext.noAlbum}`);
    }

    const filteredCandidates = sessionContext.filterSessionRepeats(candidates.candidates || []);
    if (VERBOSE_EXPLORER) {
      console.log(`🔍 CORE FILTERING: After session filtering: ${filteredCandidates.length} candidates`);

      if (candidates.candidates && candidates.candidates.length > 0 && filteredCandidates.length === 0) {
        console.log(`🚨 CORE FILTERING PROBLEM: Session filtering removed ALL candidates for '${direction}'!`);
        console.log(`🚨 This suggests too aggressive artist/album filtering or session history is too large`);
      }
    }

    const strategicSamples = sessionContext.selectStrategicSamples(filteredCandidates, targetTrack, 50);
    if (VERBOSE_EXPLORER) console.log(`🔍 CORE SAMPLING: Selected ${strategicSamples.length} sample tracks from ${filteredCandidates.length} filtered candidates`);

    // Skip directions with 0 tracks (completely ignore them)
    if (trackCount === 0) {
      if (VERBOSE_EXPLORER) {
        console.log(`🚫 CORE REJECTION: ${directionKey} selects ZERO tracks (${trackCount}/${totalNeighborhoodSize}) - [${feature.name}]`);
        console.log(`🔍 CORE DEBUG: candidates.totalAvailable=${candidates.totalAvailable}, candidates.candidates.length=${candidates.candidates?.length || 0}`);
      }
      return;
    }

    // Skip directions that select nearly everything (useless)
    if (totalNeighborhoodSize > 10 && trackCount > totalNeighborhoodSize - 10) {
      if (VERBOSE_EXPLORER) console.log(`🚫 CORE REJECTION: ${directionKey} selects TOO MANY tracks (${trackCount}/${totalNeighborhoodSize}) - [${feature.name}]`);
      return;
    }

    const formattedTracks = strategicSamples.map(sample => {
      const track = sample.track || sample;
      const directionDim = radialSearch.kdTree.getDirectionDimension(direction);
      const activeDimensions = radialSearch.kdTree.dimensions.filter(dim => dim !== directionDim);
      const featureSlices = radialSearch.kdTree.calculateFeatureContributionFractions(
        targetTrack,
        track,
        activeDimensions,
        null,
        `${directionKey}:${track.identifier || track.track?.identifier}`,
        directionDim
      );
      const distanceSlices = {
        kind: 'feature',
        dimensions: activeDimensions,
        reference: {
          key: directionDim,
          distance: featureSlices.referenceDistance
        },
        total: featureSlices.total,
        slices: featureSlices.slices
      };
      return {
        identifier: track.identifier || track.track?.identifier,
        title: track.title || track.track?.title,
        artist: track.artist || track.track?.artist,
        album: track.album || track.track?.album,
        duration: track.length || track.track?.length,
        distance: sample.distance || sample.similarity,
        features: track.features || track.track?.features,
        albumCover: track.albumCover || track.track?.albumCover,
        distanceSlices,
        featureDistanceSlices: {
          referenceKey: directionDim,
          referenceDistance: featureSlices.referenceDistance,
          total: featureSlices.total,
          slices: featureSlices.slices
        }
      };
    });

    const originalSamples = formattedTracks.map(track => ({
      ...track,
      features: track.features ? { ...track.features } : track.features
    }));

    explorerData.directions[directionKey] = {
      direction: direction,
      description: feature.description,
      domain: 'original',
      component: feature.name,
      polarity: polarity,
      trackCount: formattedTracks.length,
      totalNeighborhoodSize: totalNeighborhoodSize,
      diversityScore: calculateDirectionDiversity(formattedTracks.length, totalNeighborhoodSize),
      isOutlier: formattedTracks.length < 3,
      splitRatio: totalNeighborhoodSize > 0 ? (formattedTracks.length / totalNeighborhoodSize) : 0,
      sampleTracks: formattedTracks,
      originalSampleTracks: originalSamples
    };

  } catch (error) {
    console.error(`🚨 CORE SEARCH ERROR: Failed to explore original feature direction ${directionKey}:`, error);
    console.error(`🚨 CORE SEARCH ERROR: Full stack trace:`, error.stack);
    console.error(`🚨 CORE SEARCH ERROR: This suggests the legacy search method is broken or missing`);

    explorerData.directions[directionKey] = {
      direction: direction,
      description: feature.description,
      domain: 'original',
      component: feature.name,
      polarity: polarity,
      trackCount: 0,
      totalNeighborhoodSize: totalNeighborhoodSize,
      sampleTracks: [],
      diversityScore: 0,
      isOutlier: true,
      error: error.message
    };
  }
}

// Explore a VAE latent direction
// options includes targetTrack and resolution
async function exploreVaeDirection(radialSearch, explorerData, latentIndex, polarity, options = {}) {
  const targetTrack = options.targetTrack;
  const directionKey = `vae_latent_${latentIndex}_${polarity}`;
  const baseLabel = VAE_LATENT_LABELS[latentIndex] || `Latent Axis ${latentIndex + 1}`;
  const directionName = baseLabel;
  const orientationDescriptor = polarity === 'positive' ? 'forward flow' : 'mirrored flow';
  const description = `${baseLabel} (${orientationDescriptor})`;

  try {
    const scope = (options && options.resolution) || 'adaptive';
    const resolutionPriority = (() => {
      switch (scope) {
        case 'microscope':
          return ['microscope', 'magnifying_glass', 'binoculars', 'adaptive'];
        case 'binoculars':
          return ['binoculars', 'magnifying_glass', 'adaptive'];
        case 'adaptive':
          return ['magnifying_glass', 'binoculars', 'adaptive'];
        default:
          return ['magnifying_glass', 'binoculars', scope];
      }
    })();

    const limit = options.limit || 24;
    let result = null;
    let candidates = [];
    const attemptedResolutions = [];

    for (const resolutionCandidate of resolutionPriority) {
      attemptedResolutions.push(resolutionCandidate);
      try {
        result = await radialSearch.getVAEDirectionalCandidates(
          targetTrack.identifier,
          latentIndex,
          polarity,
          {
            resolution: resolutionCandidate,
            limit
          }
        );
        candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        if (candidates.length > 0) {
          break;
        }
      } catch (innerError) {
        console.warn(`⚠️ VAE search failed for resolution ${resolutionCandidate}:`, innerError.message || innerError);
      }
    }

    if (candidates.length === 0) {
      console.log(`🚫 VAE direction ${directionKey} returned no candidates (tried ${attemptedResolutions.join(', ')})`);
      return;
    }

    const strategicSamples = selectStrategicSamples(candidates, targetTrack);

    const formattedTracks = strategicSamples.map(candidate => {
      const track = candidate.track || {};
      return {
        identifier: track.identifier,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumCover: track.albumCover,
        duration: track.length,
        distance: candidate.distance,
        latentValue: candidate.latentValue,
        latentDelta: candidate.delta,
        vae: track.vae,
        features: track.features
      };
    });

    const totalAvailable = result.totalAvailable || formattedTracks.length;
    const neighborhoodSize = totalAvailable > 0 ? totalAvailable : formattedTracks.length;

    explorerData.directions[directionKey] = {
      direction: directionName,
      description,
      domain: 'vae',
      component: `latent_${latentIndex}`,
      polarity,
      trackCount: formattedTracks.length,
      totalNeighborhoodSize: neighborhoodSize,
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

// Explore all VAE directions for a target track
async function exploreVaeDirections(radialSearch, explorerData, targetTrack) {
  const latentVector = targetTrack?.vae?.latent;
  if (!Array.isArray(latentVector) || latentVector.length === 0) {
    return;
  }

  for (let index = 0; index < latentVector.length; index += 1) {
    await exploreVaeDirection(radialSearch, explorerData, index, 'positive', { targetTrack });
    await exploreVaeDirection(radialSearch, explorerData, index, 'negative', { targetTrack });
  }
}

// Apply stack budget: trim to deterministicLimit, then backfill with random picks
// budgetConfig = { stackTotalCount, stackRandomCount }
function applyStackBudget(directions, budgetConfig) {
  if (!directions || typeof directions !== 'object') {
    return {
      directions,
      stats: {
        trimmedSamples: 0,
        randomInjections: 0,
        finalSamples: 0
      }
    };
  }

  const total = budgetConfig.stackTotalCount || 0;
  if (!Number.isFinite(total) || total <= 0) {
    return {
      directions,
      stats: {
        trimmedSamples: 0,
        randomInjections: 0,
        finalSamples: 0
      }
    };
  }

  const stats = {
    trimmedSamples: 0,
    randomInjections: 0,
    finalSamples: 0
  };

  const randomCount = Math.min(budgetConfig.stackRandomCount || 0, total);
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
      if (id) {
        usedIds.add(id);
      }
    });
  });

  Object.entries(directions).forEach(([directionKey, direction]) => {
    if (!Array.isArray(direction.sampleTracks)) {
      direction.sampleTracks = [];
    }

    const currentTracks = direction.sampleTracks;
    const existingIds = new Set(currentTracks.map(sample => (sample.track || sample)?.identifier).filter(Boolean));
    const needed = total - currentTracks.length;

    if (needed <= 0) {
      return;
    }

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
      const clone = {
        ...sample,
        features: sample.features ? { ...sample.features } : sample.features
      };
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

// evaluateRadiusAdjustment reads AND writes dynamicRadiusState (mutable object parameter)
function evaluateRadiusAdjustment(directionStats, retryDepth, dynamicRadiusState, stackTotalCount, recordSessionEvent) {
  const MAX_RETRIES = 2;
  if (!directionStats) {
    return { action: null, retry: false };
  }

  const radiusState = dynamicRadiusState || {
    currentRadius: null,
    minRadius: 0.05,
    maxRadius: 2.0,
    starvationStreak: 0,
    abundanceStreak: 0
  };

  const totalDirections = directionStats.finalCount ?? 0;
  const trimmedSamples = directionStats.trimmedSamples ?? 0;
  const starvationThreshold = 2;
  const abundanceThreshold = 2;
  const desiredDirections = Math.min(stackTotalCount || 12, 12);

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
      recordSessionEvent('radius_adjustment', {
        action: 'expand',
        reason: 'starvation',
        from: current,
        to: expanded,
        retryEligible: retryDepth < MAX_RETRIES
      });
      return {
        action: {
          action: 'expand',
          reason: 'starvation',
          from: current,
          to: expanded,
          timestamp: now,
          retry: retryDepth < MAX_RETRIES
        },
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
      recordSessionEvent('radius_adjustment', {
        action: 'shrink',
        reason: 'abundance',
        from: current,
        to: shrunk,
        retryEligible: retryDepth < MAX_RETRIES
      });
      return {
        action: {
          action: 'shrink',
          reason: 'abundance',
          from: current,
          to: shrunk,
          timestamp: now,
          retry: retryDepth < MAX_RETRIES
        },
        retry: retryDepth < MAX_RETRIES
      };
    }
  }

  return { action: null, retry: false };
}

// Record explorer summary for diagnostics
// mixerContext = { currentTrackId, explorerResolution, maxExplorerHistory, currentExplorerSummary, explorerHistory, recordSessionEvent }
// Returns { currentExplorerSummary, explorerHistory }
function recordExplorerSummary(explorerData, radiusDiagnostics, totalNeighborhoodSize, mixerContext) {
  if (!explorerData) {
    return {
      currentExplorerSummary: mixerContext.currentExplorerSummary,
      explorerHistory: mixerContext.explorerHistory
    };
  }
  const directionEntries = Object.entries(explorerData.directions || {});
  const topDirections = directionEntries
    .map(([key, dir]) => ({
      key,
      score: Number((dir.diversityScore ?? 0).toFixed(2)),
      trackCount: dir.trackCount ?? 0,
      domain: dir.domain || null,
      isOutlier: Boolean(dir.isOutlier)
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);

  const summary = {
    timestamp: Date.now(),
    trackId: mixerContext.currentTrackId || null,
    resolution: mixerContext.explorerResolution || 'adaptive',
    neighborhoodSize: totalNeighborhoodSize,
    nextDirection: explorerData.nextTrack?.direction || explorerData.nextTrack?.direction || null,
    diversity: explorerData.diversityMetrics || null,
    topDirections,
    radius: radiusDiagnostics || null,
    directionStats: {
      total: directionEntries.length,
      valid: explorerData.diversityMetrics?.validDirections ?? null
    }
  };

  const currentExplorerSummary = summary;
  const explorerHistory = mixerContext.explorerHistory.slice();
  explorerHistory.push(summary);
  if (explorerHistory.length > mixerContext.maxExplorerHistory) {
    explorerHistory.shift();
  }
  mixerContext.recordSessionEvent('explorer_snapshot', {
    trackId: summary.trackId,
    nextDirection: summary.nextDirection,
    neighborhoodSize: summary.neighborhoodSize,
    diversity: summary.diversity,
    topDirections: summary.topDirections,
    radius: summary.radius
  });

  return { currentExplorerSummary, explorerHistory };
}

// Select next track based on weighted diversity score favoring original features
// sessionContext = { sessionHistory, currentTrackId, failedTrackAttempts, recordSessionEvent }
async function selectNextTrackFromExplorer(explorerData, sessionContext) {
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
    // Fallback to any available track from outliers
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

  // Select from highest diversity direction
  const playedTrackIds = new Set(sessionContext.sessionHistory.map(entry => entry.identifier));
  if (sessionContext.currentTrackId) {
    playedTrackIds.add(sessionContext.currentTrackId);
  }

  // Debug: log session history for filtering
  if (VERBOSE_EXPLORER) {
    console.log(`🔍 Session history for filtering: ${playedTrackIds.size} tracks`,
      [...playedTrackIds].map(id => id.substring(0, 8)).join(', '));
  }

  let selectedDirectionKey = null;
  let selectedDirection = null;
  let selectedTrack = null;
  let skippedCandidates = 0;

  for (const [directionKey, directionData] of validDirections) {
    if (!Array.isArray(directionData.sampleTracks) || directionData.sampleTracks.length === 0) {
      continue;
    }

    const candidateIndex = directionData.sampleTracks.findIndex(candidate => {
      const candidateId = candidate?.identifier || candidate?.track?.identifier;
      if (!candidateId || playedTrackIds.has(candidateId)) return false;
      // Skip tracks that have failed 3+ times this session
      if ((sessionContext.failedTrackAttempts.get(candidateId) || 0) >= 3) return false;
      return true;
    });

    if (candidateIndex === -1) {
      skippedCandidates += directionData.sampleTracks.length;
      continue;
    }

    selectedDirectionKey = directionKey;
    selectedDirection = directionData;
    selectedTrack = directionData.sampleTracks[candidateIndex];

    if (candidateIndex > 0) {
      skippedCandidates += candidateIndex;
    }

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
  const directionLabel = selectedDirection.direction || selectedDirectionKey;
  const domainLabel = selectedDirection.domain === 'original' ? '📊 Original' : '🧮 PCA';
  const componentDetail = selectedDirection.domain !== 'original' ?
    ` [${selectedDirection.domain}_${selectedDirection.component}_${selectedDirection.polarity}]` :
    ` [${selectedDirection.component}_${selectedDirection.polarity}]`;

  if (skippedCandidates > 0) {
    console.log(`🎯 Skipped ${skippedCandidates} previously played candidates before selecting '${selectedTrack?.title || selectedTrackId}'`);
  }

  console.log(`🎯 Next track selected from direction '${directionLabel}'${componentDetail} (${domainLabel}, weighted diversity: ${weightedScore.toFixed(1)})`);

  const distanceSlices = selectedTrack.distanceSlices
    || selectedTrack.featureDistanceSlices
    || selectedTrack.pcaDistanceSlices;
  if (distanceSlices?.slices?.length) {
    const referenceLabel = distanceSlices.reference?.key || distanceSlices.referenceKey || 'n/a';
    const referenceDist = Number(distanceSlices.reference?.distance ?? distanceSlices.referenceDistance ?? 0);
    const topSlices = [...distanceSlices.slices]
      .sort((a, b) => {
        const aRel = a.relative !== null && a.relative !== undefined ? Math.abs(Number(a.relative)) : 0;
        const bRel = b.relative !== null && b.relative !== undefined ? Math.abs(Number(b.relative)) : 0;
        if (aRel !== bRel) {
          return bRel - aRel;
        }
        const aFrac = a.fraction !== null && a.fraction !== undefined ? Math.abs(Number(a.fraction)) : 0;
        const bFrac = b.fraction !== null && b.fraction !== undefined ? Math.abs(Number(b.fraction)) : 0;
        if (aFrac !== bFrac) {
          return bFrac - aFrac;
        }
        return Math.abs(Number(b.delta || 0)) - Math.abs(Number(a.delta || 0));
      })
      .slice(0, 6)
      .map(slice => {
        const rel = slice.relative !== null && slice.relative !== undefined
          ? `${Number(slice.relative).toFixed(3)}×`
          : 'n/a';
        const frac = slice.fraction !== null && slice.fraction !== undefined
          ? Number(slice.fraction).toFixed(3)
          : 'n/a';
        const delta = slice.delta !== null && slice.delta !== undefined
          ? Number(slice.delta).toFixed(3)
          : 'n/a';
        const marker = referenceLabel && slice.key === referenceLabel ? '★' : '';
        return `${slice.key}${marker} Δ=${delta} rel=${rel} frac=${frac}`;
      });
    console.log(`🧭 Contribution breakdown (reference=${referenceLabel}, refDist=${referenceDist.toFixed(4)}): ${topSlices.join(' | ')}`);
  }

  sessionContext.recordSessionEvent('next_track_selected', {
    trackId: selectedTrackId,
    directionKey: selectedDirectionKey,
    directionLabel,
    domain: selectedDirection.domain || null,
    diversityScore: selectedDirection.diversityScore,
    weightedScore: weightedScore,
    skippedCandidates,
    transitionReason: 'explorer'
  });

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

// Legacy explorer data for non-PCA tracks
// Needs radialSearch, currentTrack, and session filtering functions
async function getLegacyExplorerData(radialSearch, currentTrack, sessionFilterFn, strategicSamplesFn) {
  const directions = [
    'brighter', 'darker', 'faster', 'slower', 'more_complex', 'simpler',
    'more_energetic', 'calmer', 'more_danceable', 'less_danceable',
    'more_tonal', 'more_atonal', 'more_punchy', 'less_punchy',
    'denser_onsets', 'sparser_onsets', 'purer_tuning', 'impurer_tuning',
    'stronger_chords', 'weaker_chords', 'more_air_sizzle', 'less_air_sizzle'
  ];

  const explorerData = {
    directions: {},
    nextTrack: null,
    diversityMetrics: { legacy: true }
  };

  // Get candidates for each legacy direction
  for (const direction of directions) {
    try {
      const candidates = await radialSearch.getDirectionalCandidates(
        currentTrack.identifier,
        direction
        // No limit - get all available candidates
      );

      const trackCount = candidates.totalAvailable || 0;
      const filteredCandidates = sessionFilterFn(candidates.candidates || []);
      const sampleTracks = strategicSamplesFn(filteredCandidates, currentTrack);

      // Skip directions with 0 tracks (completely ignore them)
      if (trackCount === 0) {
        continue;
      }

      explorerData.directions[direction] = {
        direction: direction,
        description: `Legacy ${direction} direction`,
        trackCount: trackCount,
        sampleTracks: sampleTracks.map(track => ({
          identifier: track.identifier,
          title: track.title,
          artist: track.artist,
          duration: track.length,
          distance: track.distance || track.similarity
        })),
        diversityScore: Math.random() * 50, // Placeholder diversity
        isOutlier: trackCount < 10
      };

    } catch (error) {
      console.error(`Failed to get legacy candidates for ${direction}:`, error);
      explorerData.directions[direction] = {
        direction: direction,
        trackCount: 0,
        sampleTracks: [],
        diversityScore: 0,
        isOutlier: true
      };
    }
  }

  // Select next track from direction with most candidates
  const directionEntries = Object.entries(explorerData.directions)
    .filter(([key, dir]) => dir.sampleTracks.length > 0)
    .sort(([keyA, dirA], [keyB, dirB]) => dirB.trackCount - dirA.trackCount);

  // Format nextTrack with directionKey and track properties for UI
  if (directionEntries.length > 0) {
    const [bestDirectionKey, bestDirection] = directionEntries[0];
    explorerData.nextTrack = {
      directionKey: bestDirectionKey,
      direction: bestDirection.direction,
      track: bestDirection.sampleTracks[0]
    };
  } else {
    explorerData.nextTrack = null;
  }

  return explorerData;
}

module.exports = {
  // Constants
  VERBOSE_EXPLORER,
  explorerLog,
  VAE_LATENT_LABELS,
  NEGATIVE_DIRECTION_KEYS,
  isNegativeDirectionKey,

  // Pure functions
  computeNeighborhoodStats,
  calculateDirectionDiversity,
  calculateVariance,
  calculateExplorerDiversityMetrics,
  shuffleArray,
  getRandomSubset,
  getTrackDimensionValue,
  getOppositeDirection,
  selectStrategicSamples,
  filterSessionRepeats,
  filterAndDeprioritizeCandidates,
  deduplicateTracksStrategically,
  sanitizeDirectionalStacks,
  removeEmptyDirections,
  prioritizeBidirectionalDirections,
  deduplicateTracksAcrossDirections,
  finalDeduplication,
  selectTopTrack,
  debugDuplicateCards,
  limitToTopDimensions,

  // Near-pure functions (require radialSearch / session context)
  exploreDirection,
  exploreOriginalFeatureDirection,
  exploreVaeDirection,
  exploreVaeDirections,
  applyStackBudget,
  evaluateRadiusAdjustment,
  recordExplorerSummary,
  selectNextTrackFromExplorer,
  getLegacyExplorerData
};
