// HTML Helpers: page independent, some explorer state.
//  *) utils
//  *) card details
//  *) createTrackDetailCard
//  *) updateCardWithTrackDetails
//  *) createDirectionCard

import { state, DEBUG_FLAGS, getCardBackgroundColor } from './globals.js';
import { getDirectionType, formatDirectionName, isNegativeDirection, getOppositeDirection, getDirectionColor, variantFromDirectionType } from './tools.js';
import { findTrackInExplorer, hydrateTrackDetails } from './explorer-utils.js';
import { setCardVariant } from './deck-render.js';
import { collectBeetsChips } from './beets-ui.js';

const HELPERS_DEBUG = {
  colors: false,
  duplicates: false
};

function helpersColorLog(...args) {
  if (HELPERS_DEBUG.colors) {
    console.log(...args);
  }
}

function helpersDuplicateLog(...args) {
  if (HELPERS_DEBUG.duplicates) {
    console.log(...args);
  }
}

  // create all the styling for album covers
  const albumCoverBackground = (albumCover) =>
    `url('${albumCover}')`

  const photoStyle = (albumCover) =>
    `background: ${albumCoverBackground(albumCover)}; background-size: 120%; background-position-x: 45%`

  function decodeHexEncodedPath(candidate) {
      if (!candidate || typeof candidate !== 'string') {
          return candidate;
      }
      if (!candidate.startsWith('\\x') || candidate.length <= 2) {
          return candidate;
      }
      const hexPart = candidate.slice(2);
      if (hexPart.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hexPart)) {
          return candidate;
      }
      try {
          const byteLength = hexPart.length / 2;
          const bytes = new Uint8Array(byteLength);
          for (let i = 0; i < byteLength; i += 1) {
              const byte = parseInt(hexPart.substr(i * 2, 2), 16);
              if (Number.isNaN(byte)) {
                  return candidate;
              }
              bytes[i] = byte;
          }
          const decoder = new TextDecoder('utf-8');
          return decoder.decode(bytes);
      } catch (error) {
          return candidate;
      }
  }

  function extractFileStem(candidate) {
      if (!candidate || typeof candidate !== 'string') return null;

      const normalized = decodeHexEncodedPath(candidate);

      const trimmed = normalized.trim();
      if (!trimmed) return null;

      const segments = trimmed.split(/[/\\]/);
      const filename = segments[segments.length - 1];
      if (!filename) return null;

      const dotIndex = filename.lastIndexOf('.');
      const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
      const cleaned = stem.trim();
      return cleaned || null;
  }

  function getDisplayTitle(track) {
      if (!track) return 'Unknown Track';

      const directTitle = typeof track.title === 'string' ? track.title.trim() : '';
      if (directTitle) return directTitle;

      const beetsTitle = typeof track.beetsMeta?.title === 'string'
          ? track.beetsMeta.title.trim()
          : typeof track.beets?.title === 'string'
              ? track.beets.title.trim()
              : '';
      if (beetsTitle) return beetsTitle;

      const metadataTitle = typeof track.metadata?.title === 'string' ? track.metadata.title.trim() : '';
      if (metadataTitle) return metadataTitle;

      const fallbackPaths = [
          track.fileName,
          track.filename,
          track.file,
          track.filepath,
          track.filePath,
          track.path,
          track.relativePath,
          track.sourceFile,
          track.source_path,
          track.sourcePath,
          track.beetsMeta?.path,
          track.beets?.path,
          track.beetsMeta?.item?.path,
          track.beets?.item?.path,
          track.item?.path,
          track.item?.file,
          track.libraryItem?.path,
          track.libraryItem?.file
      ];

      if (typeof window !== 'undefined' && track.identifier) {
          const cacheEntry = state?.trackMetadataCache?.[track.identifier];
          if (cacheEntry && typeof cacheEntry === 'object') {
              const candidatePayloads = [];
              if (cacheEntry.details && typeof cacheEntry.details === 'object') {
                  candidatePayloads.push(cacheEntry.details);
              }
              if (cacheEntry.meta && typeof cacheEntry.meta === 'object') {
                  candidatePayloads.push(cacheEntry.meta);
              }

              for (const payload of candidatePayloads) {
                  const payloadTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
                  if (payloadTitle) {
                      return payloadTitle;
                  }

                  fallbackPaths.push(
                      payload.path,
                      payload.file,
                      payload.filename,
                      payload.item?.path,
                      payload.item?.file,
                      payload.libraryItem?.path,
                      payload.libraryItem?.file
                  );
              }
          }
      }

      for (const candidate of fallbackPaths) {
          const stem = extractFileStem(candidate);
          if (stem) return stem;
      }

      if (track.identifier) {
          return `Track ${track.identifier.substring(0, 8)}...`;
      }

      return 'Unknown Track';
  }

  // findTrackInExplorer imported from explorer-utils.js


  function resolveOppositeDirectionKey(direction) {
      if (!direction) return null;

      const stateRef = state;
      const directions = stateRef.latestExplorerData?.directions || {};

      const directOpposite = direction.oppositeDirection;
      if (directOpposite) {
          if (directOpposite.key) return directOpposite.key;
          if (directOpposite.direction) return directOpposite.direction;
      }

      const directionKey = direction.key || direction.direction || null;
      if (!directionKey) {
          return null;
      }

      const derived = getOppositeDirection(directionKey);
      if (derived) {
          return derived;
      }

      if (directions[directionKey]?.oppositeDirection) {
          const alt = directions[directionKey].oppositeDirection;
          if (alt.key) return alt.key;
          if (alt.direction) return alt.direction;
      }

      for (const [key, dirData] of Object.entries(directions)) {
          const opposite = dirData.oppositeDirection;
          if (!opposite) continue;
          if (opposite.key === directionKey || opposite.direction === directionKey) {
              return dirData.key || key;
          }
      }

      return null;
  }

  function resolveOppositeBorderColor(direction, fallbackColor = '#ffffff') {
      if (!direction) return fallbackColor;

      const tryColorForKey = (key) => {
          if (!key) return null;
          const directionType = getDirectionType(key);
          const colors = getDirectionColor(directionType, key);
          return colors && colors.border ? colors.border : null;
      };

      const oppositeKey = resolveOppositeDirectionKey(direction);
      const directColor = tryColorForKey(oppositeKey);
      if (directColor) {
          return directColor;
      }

      const derivedKey = getOppositeDirection(direction.key || direction.direction || null);
      const derivedColor = tryColorForKey(derivedKey);
      if (derivedColor) {
          return derivedColor;
      }

      return direction.borderColor || fallbackColor;
  }

  const UNO_REVERSE_SVG = `
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0" y="0" viewBox="0 0 512 512" aria-hidden="true">
          <g>
              <path class="reverse-arrow-top" d="M270.129,28.332c57.441-0.156,114.883-1.758,172.32-2.156c-9.199,57.117-18.961,114.238-27.598,171.516c-15.203-16.238-29.922-32.879-44.883-49.277c-51.52,44.879-104.32,88.32-156.238,132.801c-20-25.84-36.879-60.082-21.922-92.641c22.402-51.359,76.48-76.32,116.402-112.082C295.012,60.813,282.449,44.652,270.129,28.332z"/>
              <path class="reverse-arrow-bottom" d="M310.129,226.254c6.32-4.563,12.082-11.281,20.32-12.16c20.719,25.441,34.801,61.52,18.48,92.965c-23.039,49.438-76,73.117-114.48,108.719c12.801,16.156,25.68,32.234,38.641,48.313c-57.84,0.406-115.68,1.359-173.52,1.523c9.84-57.039,18.961-114.164,28-171.281c14.961,15.922,29.199,32.563,43.281,49.359C217.969,305.371,263.891,265.613,310.129,226.254z"/>
              <path class="reverse-backdrop" d="M244.727,24.222c15.869-8.79,11.562-11.329,34.203-12.368c39.84-3.68,79.922-0.563,119.922-2.164c17.277,0.801,36.477-2.797,52.078,6.641c11.199,11.523,2.961,27.441,1.922,41.121c-9.441,47.602-12.801,96.559-26,143.281c-2.914,15.937-9.946,20.593-33.136,41.035c-11.166,9.842-10.221-4.209-45.027-36.017c30.663,48.91,28.48,79.306,13.761,109.142c-21.52,45.758-67.281,71.914-103.359,104.961c9.602,14.797,42.711,46.116,34.746,56.864c-21.165,28.561-28.042,23.108-92.495,26.652c-47.346,2.603-72.412,2.805-131.533,0.242c-17.117-8.805-5.65-36.809-1.304-78.852c0,0,9.955-68.556,22.178-120.067c3.063-12.906,28.478-27.794,28.478-27.794c17.697-9.408,18.502-1.391,51.679,34.782c-10.879-29.602-44.298-50.308-26.208-99.235c18.961-49.52,71.099-85.636,109.658-118.757c-26.891-43.033-42.011-51.323-19.386-63.112M270.129,28.332c12.32,16.32,24.883,32.48,38.082,48.16c-39.922,35.762-94,60.723-116.402,112.082c-14.957,32.559,1.922,66.801,21.922,92.641c51.918-44.48,104.719-87.922,156.238-132.801c14.961,16.398,29.68,33.039,44.883,49.277c8.637-57.277,18.398-114.398,27.598-171.516C385.012,26.574,327.57,28.176,270.129,28.332M310.129,226.254c-46.238,39.359-92.16,79.117-139.277,117.438c-14.082-16.797-28.32-33.438-43.281-49.359c-9.039,57.117-18.16,114.242-28,171.281c57.84-0.164,115.68-1.117,173.52-1.523c-12.961-16.078-25.84-32.156-38.641-48.313c38.344-35.818,93.298-59.394,112.282-111.595c16.32-31.445,2.238-67.523-18.48-92.965c-8.239,0.879-14.001,7.597-20.32,12.16Z"/>
          </g>
      </svg>
  `.trim();

  function renderReverseIcon({ interactive = false, topColor = null, bottomColor = null, highlight = null, extraClasses = '' } = {}) {
      const classes = ['uno-reverse'];
      if (interactive) {
          classes.push('next-track-reverse');
      } else {
          classes.push('direction-reverse');
      }
      if (highlight === 'top') {
          classes.push('highlight-top');
      } else if (highlight === 'bottom') {
          classes.push('highlight-bottom');
      }
      if (extraClasses) {
          classes.push(extraClasses);
      }

      const tag = interactive ? 'button' : 'div';
      const attr = interactive
          ? 'type="button" aria-label="Swap opposite direction"'
          : 'aria-hidden="true"';
      const styleParts = [];
      if (topColor) {
          styleParts.push(`--reverse-top-color: ${topColor}`);
      }
      if (bottomColor) {
          styleParts.push(`--reverse-bottom-color: ${bottomColor}`);
      }
      const styleAttr = styleParts.length ? ` style="${styleParts.join('; ')}"` : '';

      return `<${tag} class="${classes.join(' ')}" ${attr}${styleAttr}><div class="symbol">${UNO_REVERSE_SVG}</div></${tag}>`;
  }

  function resolveDirectionKeyForCard(direction, card, track = null, fallbackKey = null) {
      const candidates = [];
      if (direction?.key) candidates.push(direction.key);
      if (card?.dataset?.directionKey) candidates.push(card.dataset.directionKey);
      if (direction?.direction) candidates.push(direction.direction);
      if (track?.directionKey) candidates.push(track.directionKey);
      if (track?.direction) candidates.push(track.direction);
      if (fallbackKey) candidates.push(fallbackKey);

      for (const key of candidates) {
          if (key) {
              if (direction) {
                  direction.key = key;
              }
              return key;
          }
      }
      return null;
  }

  function getDirectionVisualContext({ direction, card, track = null, fallbackKey = null }) {
      const resolvedKey = resolveDirectionKeyForCard(direction, card, track, fallbackKey);
      if (!resolvedKey) {
          return null;
      }

      const directionType = getDirectionType(resolvedKey);
      const directionColors = getDirectionColor(directionType, resolvedKey);
      const isNegative = isNegativeDirection(resolvedKey);

      return { resolvedKey, directionType, directionColors, isNegative };
  }

  function hasOppositeForDirection(direction, resolvedKey) {
      const explorerDirections = state.latestExplorerData?.directions || {};
      const oppositeKey = getOppositeDirection(resolvedKey);
      return (
          direction?.hasOpposite === true ||
          !!direction?.oppositeDirection ||
          (oppositeKey ? !!explorerDirections[oppositeKey] : false) ||
          Object.values(explorerDirections).some(dir => dir?.oppositeDirection?.key === resolvedKey)
      );
  }

  function extractSampleIdentifiers(sampleList) {
      if (!Array.isArray(sampleList)) {
          return [];
      }
      return sampleList
          .map(sample => {
              const track = sample && typeof sample === 'object' && sample.track ? sample.track : sample;
              if (!track || typeof track !== 'object') {
                  return null;
              }
              return track.identifier || track.trackMd5 || track.md5 || null;
          })
          .filter(Boolean);
  }

  function hasActualOpposite(direction, resolvedKey) {
      const stateRef = state;
      const directionsMap = stateRef.latestExplorerData?.directions || {};
      const inlineOpposite = direction?.oppositeDirection;
      const inlineSamples = Array.isArray(inlineOpposite?.sampleTracks)
          ? inlineOpposite.sampleTracks
          : [];
      const oppositeKey = resolveOppositeDirectionKey(direction) || getOppositeDirection(resolvedKey);
      const externalDirection = oppositeKey ? directionsMap[oppositeKey] : null;
      const externalSamples = Array.isArray(externalDirection?.sampleTracks)
          ? externalDirection.sampleTracks
          : [];

      const inlineIds = extractSampleIdentifiers(inlineSamples);
      const externalIds = extractSampleIdentifiers(externalSamples);
      const oppositeIds = [...new Set([...inlineIds, ...externalIds])];
      if (oppositeIds.length === 0) {
          return false;
      }

      const primaryIds = new Set(extractSampleIdentifiers(direction?.sampleTracks || []));
      let hasDistinctOpposite = false;
      if (primaryIds.size === 0) {
          hasDistinctOpposite = true;
      } else {
          hasDistinctOpposite = oppositeIds.some(id => !primaryIds.has(id));
      }

      const inlineValid = inlineIds.length > 0 && inlineOpposite?.isSynthetic !== true;
      const externalValid = externalIds.length > 0 && externalDirection?.isSynthetic !== true;
      return hasDistinctOpposite && (inlineValid || externalValid);
  }

  function applyReverseBadge(card, direction, context, { interactive = false, extraClasses = '', highlightOverride = null } = {}) {
      const panel = card.querySelector('.panel');
      const existing = card.querySelector('.uno-reverse');
      if (existing) {
          existing.remove();
      }

      const oppositeKey = resolveOppositeDirectionKey(direction) || getOppositeDirection(context.resolvedKey);
      const hasOppositeStack = hasActualOpposite(direction, context.resolvedKey);

      if (!hasOppositeStack || !panel) {
          delete card.dataset.oppositeBorderColor;
          delete card.dataset.oppositeDirectionKey;
          if (direction && direction.oppositeDirection && !Array.isArray(direction.oppositeDirection.sampleTracks)) {
              delete direction.oppositeDirection;
          }
          if (direction) {
              direction.hasOpposite = false;
          }
          return;
      }

      const baseBorder = card.dataset.borderColor || context.directionColors.border;
      const baseGlow = card.dataset.glowColor || context.directionColors.glow;

      const oppositeDirectionKey = oppositeKey || getOppositeDirection(context.resolvedKey);
      card.dataset.oppositeDirectionKey = oppositeDirectionKey || '';

      const reverseColor = resolveOppositeBorderColor(direction, baseBorder);
      card.dataset.oppositeBorderColor = reverseColor || baseBorder;

      const topColor = context.isNegative ? (reverseColor || baseBorder) : baseBorder;
      const bottomColor = context.isNegative ? baseBorder : (reverseColor || baseBorder);
      const enableInteraction = interactive && hasOppositeStack;
      const highlight = enableInteraction ? (highlightOverride || (context.isNegative ? 'top' : 'bottom')) : null;

      direction.hasOpposite = true;

      const classSet = new Set();
      classSet.add('has-opposite');
      if (enableInteraction) {
          classSet.add('enabled');
      } else {
          classSet.add('disabled');
      }
      if (extraClasses) {
          extraClasses.split(/\s+/).filter(Boolean).forEach(cls => classSet.add(cls));
      }
      const combinedExtra = Array.from(classSet).join(' ');

      const badgeHtml = renderReverseIcon({
          interactive: enableInteraction,
          topColor,
          bottomColor,
          highlight,
          extraClasses: combinedExtra
      });

      panel.insertAdjacentHTML('beforeend', badgeHtml);
  }



  const DIRECTION_FEATURE_ALIAS = {
      'purer_tuning': 'tuning_purity',
      'impurer_tuning': 'tuning_purity',
      'stronger_chords': 'chord_strength',
      'weaker_chords': 'chord_strength',
      'stronger_fifths': 'fifths_strength',
      'weaker_fifths': 'fifths_strength',
      'more_air_sizzle': 'air_sizzle',
      'less_air_sizzle': 'air_sizzle',
      'more_air': 'air_sizzle',
      'less_air': 'air_sizzle',
      'more_energetic': 'spectral_energy',
      'calmer': 'spectral_energy',
      'higher_energy': 'spectral_energy',
      'lower_energy': 'spectral_energy',
      'more_danceable': 'danceable',
      'less_danceable': 'danceable',
      'busier_onsets': 'onset_rate',
      'denser_onsets': 'onset_rate',
      'sparser_onsets': 'onset_rate',
      'punchier_beats': 'beat_punch',
      'smoother_beats': 'beat_punch',
      'more_punchy': 'crest',
      'less_punchy': 'crest',
      'smoother': 'crest',
      'more_complex': 'entropy',
      'simpler': 'entropy',
      'more_tonal': 'tonal_clarity',
      'more_atonal': 'tonal_clarity',
      'brighter': 'spectral_centroid',
      'darker': 'spectral_centroid',
      'fuller_spectrum': 'spectral_rolloff',
      'narrower_spectrum': 'spectral_rolloff',
      'peakier_spectrum': 'spectral_kurtosis',
      'flatter_spectrum': 'spectral_kurtosis',
      'noisier': 'spectral_flatness',
      'more_tonal_spectrum': 'spectral_flatness',
      'more_bass': 'sub_drive',
      'less_bass': 'sub_drive',
      'faster': 'bpm',
      'slower': 'bpm'
  };

  function getDirectionMetricDescriptor(directionKey, direction) {
      const candidateKey = directionKey || direction?.key;
      if (!candidateKey) return null;

      const domain = direction?.domain;
      const component = direction?.component;

      // PCA-based direction (e.g., spectral pc1)
      if (domain && component && /^pc\d+$/i.test(component)) {
          const index = parseInt(component.replace(/pc/i, ''), 10) - 1;
          if (!Number.isNaN(index)) {
              return { type: 'pca', domain, index };
          }
      }

      const featureKeyFromDirection = direction?.featureKey;
      if (featureKeyFromDirection) {
          return { type: 'feature', key: featureKeyFromDirection };
      }

      if (component && !/^pc\d+$/i.test(component)) {
          return { type: 'feature', key: component };
      }

      let base = candidateKey.replace(/_(positive|negative)$/i, '');
      if (DIRECTION_FEATURE_ALIAS[base]) {
          base = DIRECTION_FEATURE_ALIAS[base];
      }

      if (base) {
          return { type: 'feature', key: base };
      }

      return null;
  }

  function extractMetricValue(descriptor, track) {
      if (!descriptor || !track) return undefined;

      if (descriptor.type === 'feature') {
          return track.features ? track.features[descriptor.key] : undefined;
      }

      if (descriptor.type === 'pca') {
          const domainValues = track.pca ? track.pca[descriptor.domain] : null;
          if (!domainValues) return undefined;
          const value = domainValues[descriptor.index];
          return value;
      }

      return undefined;
  }

  const CONSISTENCY_CHECK_TOLERANCE = 1e-3;
  const CONSISTENCY_DYNAMIC_MIN_TOLERANCE = 0.02;
  const CONSISTENCY_DYNAMIC_RELATIVE = 0.12;
  const CONSISTENCY_MIN_SPREAD = 0.05;
  const CONSISTENCY_MAX_INCONSISTENT_RATIO = 0.34;

  function resolveMetricValueForConsistency(descriptor, rawTrack, direction) {
      if (!descriptor || !rawTrack) {
          return undefined;
      }

      const track = rawTrack.track || rawTrack;
      if (!track) {
          return undefined;
      }

      let value = extractMetricValue(descriptor, track);

      if (value === undefined && track.identifier && state?.latestExplorerData) {
          const explorerData = state.latestExplorerData;
          let fallback = null;
          if (direction?.key) {
              fallback = findTrackInExplorer(direction.key, explorerData, track.identifier);
          }
          if (!fallback) {
              fallback = findTrackInExplorer(null, explorerData, track.identifier);
          }
          if (fallback) {
              value = extractMetricValue(descriptor, fallback);
          }
      }

      if (value === undefined) {
          return undefined;
      }

      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
  }

  function resolvePrimaryDForConsistency(rawTrack, direction) {
      const track = rawTrack?.track || rawTrack;
      if (!track) {
          return undefined;
      }

      let value = track?.pca?.primary_d;

      if (!Number.isFinite(Number(value)) && track?.identifier && state?.latestExplorerData) {
          const explorerData = state.latestExplorerData;
          let fallback = null;
          if (direction?.key) {
              fallback = findTrackInExplorer(direction.key, explorerData, track.identifier);
          }
          if (!fallback) {
              fallback = findTrackInExplorer(null, explorerData, track.identifier);
          }

          if (fallback?.pca?.primary_d !== undefined) {
              value = fallback.pca.primary_d;
          }
      }

      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
  }

  function evaluateDirectionConsistency(direction, { card = null, sampleTracks = [], currentTrack = null } = {}) {
      if (!direction) {
          return;
      }

      if (direction.skipConsistencyCheck) {
          helpersColorLog(`🧮 Skipping consistency check for ${direction.key} (flagged synthetic)`);
          return;
      }

      const stateRef = state;
      const activeCurrentTrack = currentTrack || stateRef.latestCurrentTrack;
      const descriptor = getDirectionMetricDescriptor(direction.key, direction);

      const samples = Array.isArray(sampleTracks) && sampleTracks.length
          ? sampleTracks
          : (Array.isArray(direction.sampleTracks) ? direction.sampleTracks : []);

      const polarity = isNegativeDirection(direction.key) ? -1 : 1;
      const descriptorKey = descriptor
          ? (descriptor.type === 'feature'
              ? descriptor.key
              : `${descriptor.domain}_pc${descriptor.index + 1}`)
          : null;

      const issues = [];
      const diffEntries = [];

      const currentMetric = descriptor
          ? resolveMetricValueForConsistency(descriptor, activeCurrentTrack, direction)
          : undefined;

      if (descriptor && Number.isFinite(currentMetric)) {
          samples.forEach(sample => {
              const metric = resolveMetricValueForConsistency(descriptor, sample, direction);
              if (Number.isFinite(metric)) {
                  const track = sample?.track || sample;
                  const trackId = track?.identifier || track?.trackMd5 || null;
                  diffEntries.push({
                      id: trackId,
                      title: getDisplayTitle(track),
                      diff: metric - currentMetric
                  });
              }
          });

          if (diffEntries.length > 0) {
              const metricSpread = diffEntries.reduce((max, entry) => Math.max(max, Math.abs(entry.diff)), 0);
              const tolerance = resolveConsistencyTolerance(currentMetric, metricSpread);

              if (metricSpread >= Math.max(tolerance, CONSISTENCY_MIN_SPREAD)) {
                  const inconsistent = diffEntries.filter(entry => (entry.diff * polarity) < -tolerance);
                  const supporting = diffEntries.filter(entry => (entry.diff * polarity) > tolerance);
                  if (supporting.length === 0 && inconsistent.length > 0) {
                      issues.push(`${descriptorKey} diffs oppose implied polarity (${inconsistent.length}/${diffEntries.length})`);
                  } else if (inconsistent.length > 0 && inconsistent.length / diffEntries.length > CONSISTENCY_MAX_INCONSISTENT_RATIO) {
                      issues.push(`${descriptorKey} diffs contradict implied polarity for ${inconsistent.length}/${diffEntries.length} samples`);
                  }
              } else {
                  helpersColorLog(`🧮 Skipping ${descriptorKey} metric diff check due to low spread: ${metricSpread.toFixed(3)} < tolerance ${tolerance.toFixed(3)}`);
              }
          }
      }

      const skipPrimaryDeltaCheck = /_pc\d+/i.test(direction.key || '');
      const primaryDeltas = [];
      const currentPrimaryD = skipPrimaryDeltaCheck ? undefined : resolvePrimaryDForConsistency(activeCurrentTrack, direction);

      let baselinePrimaryValue = Number.isFinite(currentPrimaryD) ? currentPrimaryD : undefined;
      let baselinePrimaryId = Number.isFinite(currentPrimaryD)
          ? (activeCurrentTrack?.identifier || activeCurrentTrack?.trackMd5 || null)
          : null;

      if (!Number.isFinite(baselinePrimaryValue)) {
          for (const sample of samples) {
              const candidatePrimary = resolvePrimaryDForConsistency(sample, direction);
              if (Number.isFinite(candidatePrimary)) {
                  const track = sample?.track || sample;
                  baselinePrimaryValue = candidatePrimary;
                  baselinePrimaryId = track?.identifier || track?.trackMd5 || null;
                  break;
              }
          }
      }

      if (!skipPrimaryDeltaCheck && Number.isFinite(baselinePrimaryValue)) {
          samples.forEach(sample => {
              const candidatePrimary = resolvePrimaryDForConsistency(sample, direction);
              if (!Number.isFinite(candidatePrimary)) {
                  return;
              }
              const track = sample?.track || sample;
              const trackId = track?.identifier || track?.trackMd5 || null;
              if (trackId && baselinePrimaryId && trackId === baselinePrimaryId) {
                  return;
              }
              primaryDeltas.push({
                  id: trackId,
                  title: getDisplayTitle(track),
                  value: candidatePrimary,
                  delta: candidatePrimary - baselinePrimaryValue
              });
          });

          if (primaryDeltas.length >= 2) {
              const primarySpread = primaryDeltas.reduce((max, entry) => Math.max(max, Math.abs(entry.delta)), 0);
              const primaryTolerance = resolveConsistencyTolerance(baselinePrimaryValue, primarySpread);

              if (primarySpread >= Math.max(primaryTolerance, CONSISTENCY_MIN_SPREAD)) {
                  const supporting = primaryDeltas.filter(entry => (entry.delta * polarity) > primaryTolerance).length;
                  const contradicting = primaryDeltas.filter(entry => (entry.delta * polarity) < -primaryTolerance).length;

                  const netDelta = primaryDeltas.reduce((sum, entry) => sum + entry.delta * polarity, 0);
                  const averageSigned = netDelta / primaryDeltas.length;

                  if (Math.abs(averageSigned) <= primaryTolerance) {
                      helpersColorLog(`🧮 Skipping primary_d polarity check (mean delta ${averageSigned.toFixed(3)} within tolerance ${primaryTolerance.toFixed(3)})`);
                  } else if (supporting === 0 && contradicting > 0) {
                      issues.push(`primary_d deltas oppose implied polarity (contradicting=${contradicting})`);
                  } else if (contradicting > 0 && contradicting / primaryDeltas.length > CONSISTENCY_MAX_INCONSISTENT_RATIO) {
                      issues.push(`primary_d deltas mixed beyond tolerance (contra=${contradicting}/${primaryDeltas.length})`);
                  }
              } else {
                  helpersColorLog(`🧮 Skipping primary_d check due to low spread: ${primarySpread.toFixed(3)} < tolerance ${primaryTolerance.toFixed(3)}`);
              }
          }
      }

      const status = issues.length ? 'warn' : 'ok';

      const cardElement = card instanceof Element ? card : null;
      const signature = issues.join(' | ') || 'ok';
      const previousSignature = cardElement ? cardElement.dataset.consistencySignature || null : null;

      if (cardElement) {
          cardElement.dataset.consistencyStatus = status;
          cardElement.dataset.consistencySignature = signature;
          if (issues.length) {
              cardElement.dataset.consistencyIssues = signature;
              cardElement.classList.add('consistency-issue');
          } else {
              delete cardElement.dataset.consistencyIssues;
              cardElement.classList.remove('consistency-issue');
          }
      }

      if (signature !== previousSignature) {
          if (issues.length) {
              console.warn(`⚠️ Consistency check failed for ${direction.key}`, {
                  issues,
                  descriptor: descriptorKey,
                  metricDiffs: diffEntries,
                  primaryDeltas
              });
          } else if (DEBUG_FLAGS?.consistency && (diffEntries.length || primaryDeltas.length)) {
              console.debug(`✅ Consistency check passed for ${direction.key}`, {
                  descriptor: descriptorKey,
                  sampleCount: samples.length,
                  metricDiffs: diffEntries,
                  primaryDeltas
              });
          }
      }
  }

  // Update the stack visualization with remaining track count
  function updateStackSizeIndicator(direction, cardForContext, overrideIndex) {
      const nextTrackCard = cardForContext
          || document.querySelector('.dimension-card.next-track.selected')
          || document.querySelector('.dimension-card.next-track');
      if (!nextTrackCard) return;

      const isNextTrackCard = nextTrackCard.classList.contains('next-track');

      // Remove any existing stack indicator
      const existingIndicator = nextTrackCard.querySelector('.stack-line-visual');
      if (existingIndicator) {
          existingIndicator.remove();
      }

      // Count tracks from the direction object that was actually passed in
      // This direction object already represents the correct track pool (original or opposite)
      const tracksToCount = direction.sampleTracks || [];

      const md5 = nextTrackCard.dataset.trackMd5;
      const directionKey = nextTrackCard.dataset.directionKey;
      const totalTracksFromDataset = Number(nextTrackCard.dataset.totalTracks);
      const currentTrack = state?.latestCurrentTrack;
      const sampleTracks = direction.sampleTracks || [];
      const activeIdentifier = state?.selectedIdentifier || md5;
      const matchedTrack = sampleTracks.find(sample => {
          const track = sample.track || sample;
          return track.identifier === activeIdentifier;
      }) || sampleTracks.find(sample => {
          const track = sample.track || sample;
          return track.identifier === md5;
      }) || sampleTracks[0];
      const nextTrackPayload = state?.latestExplorerData?.nextTrack?.track || state?.latestExplorerData?.nextTrack || {};
      const candidateTrack = matchedTrack || nextTrackPayload;

      const getIndexFromTracks = (identifier) => {
          if (!identifier) return -1;
          return sampleTracks.findIndex(sample => {
              const track = sample.track || sample;
              return track.identifier === identifier;
          });
      };

      const numericOverride = overrideIndex !== undefined ? Number(overrideIndex) : NaN;
      let matchedIndex = Number.isFinite(numericOverride) ? numericOverride : -1;

      if (matchedIndex < 0) {
          matchedIndex = getIndexFromTracks(activeIdentifier);
      }

      if (matchedIndex < 0) {
          matchedIndex = getIndexFromTracks(matchedTrack?.identifier || md5);
      }

      if (matchedIndex < 0) {
          matchedIndex = Number.isFinite(Number(nextTrackCard.dataset.trackIndex))
              ? Number(nextTrackCard.dataset.trackIndex)
              : -1;
      }
      if (matchedIndex < 0 && typeof state?.stackIndex === 'number') {
          matchedIndex = state.stackIndex;
      }
      if (matchedIndex < 0) {
          matchedIndex = 0;
      }

      const totalTracks = Number.isFinite(totalTracksFromDataset) && totalTracksFromDataset > 0
          ? totalTracksFromDataset
          : (sampleTracks.length || tracksToCount.length || 0);

      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }

      let remainingCount;
      if (Number.isFinite(matchedIndex)) {
          remainingCount = Math.max(0, totalTracks - matchedIndex - 1);
      } else if (state.remainingCounts.hasOwnProperty(directionKey)) {
          remainingCount = Math.max(0, Number(state.remainingCounts[directionKey]));
      } else if (state.stackIndex && directionKey === state.latestExplorerData?.nextTrack?.directionKey) {
          const idx = Number(state.stackIndex);
          remainingCount = Math.max(0, totalTracks - idx - 1);
      } else {
          remainingCount = Math.max(0, totalTracks - 1);
      }

      state.remainingCounts[directionKey] = remainingCount;

      if (!Number.isFinite(matchedIndex)) {
          const stored = state?.remainingCounts ? state.remainingCounts[directionKey] : undefined;
          if (stored !== undefined && stored !== null) {
              remainingCount = Math.max(0, Number(stored));
          }
      }

      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }
      state.remainingCounts[directionKey] = remainingCount;
      const fallbackIndex = Math.max(0, totalTracks - remainingCount - 1);
      nextTrackCard.dataset.trackIndex = String(Number.isFinite(matchedIndex) ? matchedIndex : fallbackIndex);
      nextTrackCard.dataset.totalTracks = String(totalTracks);

      console.log(`💿 Stack indicator: ${direction.key}, tracks=${tracksToCount.length}, remaining=${remainingCount}`);

      const existingMetrics = nextTrackCard.querySelector('.track-metrics');
      if (existingMetrics) {
          existingMetrics.remove();
      }

      if (!isNextTrackCard && remainingCount > 0) {
          const stackLineContainer = document.createElement('div');
          stackLineContainer.className = 'stack-line-visual';

          const computedStyle = window.getComputedStyle(nextTrackCard);
          const lineColor = (computedStyle.getPropertyValue('--border-color') || computedStyle.borderColor || direction.borderColor || '#ffffff').trim() || '#ffffff';

          const rect = nextTrackCard.getBoundingClientRect();
          const cardHeight = rect?.height || nextTrackCard.offsetHeight || 0;
          const baseHeight = cardHeight ? Math.max(2, Math.round(cardHeight * 0.66)) : 40;

          let currentHeight = baseHeight;
          for (let i = 0; i < remainingCount; i += 1) {
              const line = document.createElement('div');
              line.className = 'stack-line';
              line.style.height = `${Math.max(2, Math.round(currentHeight))}px`;
              line.style.backgroundColor = lineColor;
              stackLineContainer.appendChild(line);
              currentHeight = currentHeight * 0.85;
          }

          stackLineContainer.addEventListener('click', (e) => {
              e.stopPropagation();
              console.log(`💿 Stack lines clicked - cycling deck`);
              nextTrackCard.click();
          });

          nextTrackCard.appendChild(stackLineContainer);
      }

      const metricsContainer = document.createElement('div');
      metricsContainer.className = 'track-metrics';

      const hasHttpWord = (text) => {
          if (!text) return false;
          const parts = text.split(/\s+/);
          return parts.some(part => /^https?:/i.test(part));
      };

      const shouldDisplayMetric = (label, value) => {
          if (label === null || label === undefined) {
              return false;
          }
          const text = String(label).trim();
          if (!text) {
              return false;
          }
          if (hasHttpWord(text)) {
              return false;
          }
          if (value !== undefined && value !== null) {
              const valueText = String(value).trim();
              if (hasHttpWord(valueText)) {
                  return false;
              }
          }
          return true;
      };

      const createMetric = (label, value) => {
          if (!shouldDisplayMetric(label, value)) {
              return null;
          }
          const container = document.createElement('div');
          container.className = 'metric-chip';
          const labelText = String(label).trim();
          container.innerHTML = `<span class="metric-label">${labelText}</span><span class="metric-value">${value}</span>`;
          return container;
      };

      const formatMetric = (value) => {
          if (value === null || value === undefined) {
              return '--';
          }
          const num = Number(value);
          if (!Number.isFinite(num)) {
              return '--';
          }
          return num.toFixed(3);
      };

      const formatDelta = (value) => {
          if (value === null || value === undefined) {
              return '--';
          }
          const num = Number(value);
          if (!Number.isFinite(num)) {
              return '--';
          }
          const formatted = num.toFixed(3);
          if (num > 0) return `+${formatted}`;
          return formatted;
      };

      const formatRatio = (value) => {
          if (value === null || value === undefined) {
              return '--';
          }
          const num = Number(value);
          if (!Number.isFinite(num)) {
              return '--';
          }
          return num.toFixed(3);
      };

      const findFeaturesLookup = (identifier) => {
          if (!identifier || !state?.latestExplorerData) return null;
          const directions = state.latestExplorerData.directions || {};
          for (const direction of Object.values(directions)) {
              const samples = direction.sampleTracks || [];
              for (const sample of samples) {
                  const track = sample.track || sample;
                  if (track?.identifier === identifier && track?.features) {
                      return track.features;
                  }
              }
          }
          return null;
      };

      const findPcaLookup = (identifier) => {
          if (!identifier || !state?.latestExplorerData) return null;
          const directions = state.latestExplorerData.directions || {};
          for (const direction of Object.values(directions)) {
              const samples = direction.sampleTracks || [];
              for (const sample of samples) {
                  const track = sample.track || sample;
                  if (track?.identifier === identifier && track?.pca) {
                      return track.pca;
                  }
              }
          }
          return null;
      };

      const descriptor = getDirectionMetricDescriptor(directionKey, direction);
      let candidateValue = descriptor ? extractMetricValue(descriptor, candidateTrack) : undefined;
      let currentValue = descriptor ? extractMetricValue(descriptor, currentTrack) : undefined;
      if (descriptor && (candidateValue === undefined || currentValue === undefined)) {
          const fallback = findTrackInExplorer(directionKey, state.latestExplorerData, state.latestCurrentTrack?.identifier);
          if (fallback) {
              if (candidateValue === undefined) {
                  candidateValue = extractMetricValue(descriptor, fallback);
              }
              if (currentValue === undefined) {
                  currentValue = extractMetricValue(descriptor, fallback);
              }
          }
      }
      window.debugNextTrackMetrics = window.debugNextTrackMetrics || {
          stack: true,
          candidate: true,
          current: true,
          delta: true,
          others: true
      };

      if (window.debugNextTrackMetrics.candidate) {
          const metric = createMetric('next', formatMetric(candidateValue));
          if (metric) {
              metricsContainer.appendChild(metric);
          }
      }

      if (window.debugNextTrackMetrics.current) {
          const metric = createMetric('curr', formatMetric(currentValue));
          if (metric) {
              metricsContainer.appendChild(metric);
          }
      }

      if (window.debugNextTrackMetrics.delta) {
          const diff = (candidateValue !== undefined && currentValue !== undefined)
              ? Number(candidateValue) - Number(currentValue)
              : undefined;
          const metric = createMetric(' Δ ', formatDelta(diff));
          if (metric) {
              metricsContainer.appendChild(metric);
          }
      }

      if (window.debugNextTrackMetrics.others) {
          const candidateSlices = candidateTrack?.distanceSlices
              || candidateTrack?.featureDistanceSlices
              || candidateTrack?.pcaDistanceSlices
              || candidateTrack?.track?.distanceSlices
              || candidateTrack?.track?.featureDistanceSlices
              || candidateTrack?.track?.pcaDistanceSlices;

          const slices = Array.isArray(candidateSlices?.slices) ? candidateSlices.slices.slice() : [];

          if (slices.length > 0) {
              const referenceKey = candidateSlices?.reference?.key || candidateSlices?.referenceKey || null;

              slices.sort((a, b) => {
                  const aIsRef = referenceKey && a.key === referenceKey ? 1 : 0;
                  const bIsRef = referenceKey && b.key === referenceKey ? 1 : 0;
                  if (aIsRef !== bIsRef) {
                      return bIsRef - aIsRef;
                  }
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
              });

              slices.slice(0, 10).forEach(slice => {
                  const isReference = referenceKey && slice.key === referenceKey;
                  const label = isReference ? `${slice.key}★` : slice.key;
                  const deltaText = formatDelta(slice.delta);
                  const relativeTextRaw = formatRatio(slice.relative);
                  const relativeText = relativeTextRaw !== '--' ? `${relativeTextRaw}×` : relativeTextRaw;
                  const fractionText = formatRatio(slice.fraction);
                  const valueText = `${deltaText} ${relativeText} ${fractionText}`;
                  const metric = createMetric(label, valueText);
                  if (metric) {
                      metricsContainer.appendChild(metric);
                  }
              });
          } else {
              const otherDiffs = [];
              const featureSource = candidateTrack?.features || findFeaturesLookup(candidateTrack?.identifier);
              const currentFeatures = currentTrack?.features || findFeaturesLookup(currentTrack?.identifier);
              if (featureSource && currentFeatures) {
                  Object.keys(featureSource).forEach(key => {
                      if (descriptor?.type === 'feature' && key === descriptor.key) return;
                      const candVal = Number(featureSource[key]);
                      const currVal = Number(currentFeatures[key]);
                      if (!Number.isFinite(candVal) || !Number.isFinite(currVal)) return;
                      const delta = candVal - currVal;
                      otherDiffs.push({ key, delta });
                  });
              }

              const pcaCandidate = candidateTrack?.pca || findPcaLookup(candidateTrack?.identifier);
              const pcaCurrent = currentTrack?.pca || findPcaLookup(currentTrack?.identifier);
              if (pcaCandidate && pcaCurrent) {
                  Object.keys(pcaCandidate).forEach(domain => {
                      if (!Array.isArray(pcaCandidate[domain])) return;
                      const candDomain = pcaCandidate[domain];
                      const currDomain = Array.isArray(pcaCurrent[domain]) ? pcaCurrent[domain] : null;
                      if (!currDomain) return;
                      candDomain.forEach((value, idx) => {
                          const candVal = Number(value);
                          const currVal = Number(currDomain[idx]);
                          if (!Number.isFinite(candVal) || !Number.isFinite(currVal)) return;
                          const delta = candVal - currVal;
                          const label = `${domain}_pc${idx + 1}`;
                          if (descriptor?.type === 'pca' && descriptor.domain === domain && descriptor.index === idx) return;
                          otherDiffs.push({ key: label, delta });
                      });
                  });
              }

              otherDiffs
                  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                  .slice(0, 10)
                  .forEach(({ key, delta }) => {
                      const metric = createMetric(key, formatDelta(delta));
                      if (metric) {
                          metricsContainer.appendChild(metric);
                      }
                  });
          }
      }

      metricsContainer.querySelectorAll('.metric-value').forEach(el => {
          if (el.textContent === '--') {
              el.parentElement.classList.add('metric-empty');
          }
      });

      const revealTargets = [];

      metricsContainer.classList.add('hidden');
      nextTrackCard.appendChild(metricsContainer);
      revealTargets.push(metricsContainer);

      if (collectBeetsChips) {
          const trackData = candidateTrack && (candidateTrack.track || candidateTrack);
          if (trackData) {
              const beetsMeta = trackData.beetsMeta || trackData.beets || null;
              const beetsChips = Array.isArray(beetsMeta)
                  ? beetsMeta
                  : (beetsMeta ? collectBeetsChips(beetsMeta) : []);

              const chipsArray = Array.isArray(beetsChips) ? beetsChips.slice(0, 12) : [];

              if (chipsArray.length > 0) {
              const beetsContainer = document.createElement('div');
              beetsContainer.className = 'track-beets hidden';

                  const escapeHtml = (val) => String(val)
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&#39;');

                  chipsArray.forEach(({ key, value }) => {
                      if (!key && !value) {
                          return;
                      }
                      const chip = document.createElement('div');
                      chip.className = 'beets-chip';
                      const safeKey = escapeHtml(key || 'segment');
                      const safeValue = escapeHtml(value !== undefined && value !== null ? value : '');
                      chip.innerHTML = `
                          <span class="chip-bracket">[</span>
                          <span class="chip-value">${safeValue}</span>
                          <span class="chip-separator">:</span>
                          <span class="chip-key">${safeKey}</span>
                          <span class="chip-bracket">]</span>
                      `;
                      beetsContainer.appendChild(chip);
                  });

                  if (beetsContainer.children.length > 0) {
                  nextTrackCard.appendChild(beetsContainer);
                  revealTargets.push(beetsContainer);
                  }
              }
          }
      }

      if (revealTargets.length > 0) {
          const show = () => revealTargets.forEach(el => {
              el.classList.remove('hidden');
          });
          const hide = () => revealTargets.forEach(el => {
              el.classList.add('hidden');
          });

          if (nextTrackCard.__chipShowHandler) {
              nextTrackCard.removeEventListener('mouseenter', nextTrackCard.__chipShowHandler);
              nextTrackCard.removeEventListener('focus', nextTrackCard.__chipShowHandler);
          }

          if (nextTrackCard.__chipHideHandler) {
              nextTrackCard.removeEventListener('mouseleave', nextTrackCard.__chipHideHandler);
              nextTrackCard.removeEventListener('blur', nextTrackCard.__chipHideHandler);
          }

          nextTrackCard.__chipShowHandler = show;
          nextTrackCard.__chipHideHandler = hide;

          nextTrackCard.addEventListener('mouseenter', show);
          nextTrackCard.addEventListener('mouseleave', hide);
          nextTrackCard.addEventListener('focus', show);
          nextTrackCard.addEventListener('blur', hide);
      }
  }

  // Hide stack size indicators - defaults to next-track cards unless a target is provided
  function hideStackSizeIndicator(target) {
      let cards;
      if (!target) {
          cards = Array.from(document.querySelectorAll('.dimension-card.next-track, .dimension-card.track-detail-card'));
      } else if (target instanceof Element) {
          cards = [target];
      } else if (typeof NodeList !== 'undefined' && target instanceof NodeList) {
          cards = Array.from(target).filter(Boolean);
      } else if (Array.isArray(target)) {
          cards = target.filter(Boolean);
      } else {
          cards = target ? [target] : [];
      }

      cards.forEach(card => {
          if (!card) return;
          const indicator = card.querySelector('.stack-line-visual');
          if (indicator) {
              indicator.remove();
          }
          const metrics = card.querySelector('.track-metrics');
          if (metrics) {
              metrics.remove();
          }
      });
  }

  // Apply stack size visuals to direction cards so we can see stack depth at a glance
  function applyDirectionStackIndicator(direction, card, options = {}) {
      if (!direction || !card) return;
      if (card.classList.contains('next-track')) return;

      const existingIndicator = card.querySelector('.stack-line-visual');
      if (existingIndicator) {
          existingIndicator.remove();
      }

      const sampleTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
      const reportedCount = Number(direction.trackCount);
      const totalTracks = Number.isFinite(reportedCount) && reportedCount > 0
          ? Math.max(reportedCount, sampleTracks.length)
          : sampleTracks.length;
      const includeActive = options.includeActive === true;
      const lineCount = includeActive ? totalTracks : Math.max(0, totalTracks - 1);

      if (lineCount <= 0) {
          return;
      }

      const stackLineContainer = document.createElement('div');
      stackLineContainer.className = 'stack-line-visual';

      const computedStyle = window.getComputedStyle(card);
      const fallbackColor = direction.borderColor || '#ffffff';
      const lineColor = (computedStyle.getPropertyValue('--border-color') || computedStyle.borderColor || fallbackColor).trim() || fallbackColor;

      let cardHeight = card.offsetHeight || 0;
      if (!cardHeight) {
          const rect = card.getBoundingClientRect();
          cardHeight = rect?.height || 0;
      }
      const baseHeight = cardHeight ? Math.max(2, Math.round(cardHeight * 0.66)) : 40;

      let currentHeight = baseHeight;
      for (let i = 0; i < lineCount; i += 1) {
          const line = document.createElement('div');
          line.className = 'stack-line';
          line.style.height = `${Math.max(2, Math.round(currentHeight))}px`;
          line.style.backgroundColor = lineColor;
          stackLineContainer.appendChild(line);
          currentHeight *= 0.75;
      }

      stackLineContainer.addEventListener('click', (e) => {
          e.stopPropagation();
          card.click();
      });

      card.appendChild(stackLineContainer);
  }

  // Comprehensive duplicate detection system

  function performDuplicateAnalysis(explorerData, context = "unknown") {
      if (!HELPERS_DEBUG.duplicates) {
          return;
      }

      helpersDuplicateLog(`🃏 === DUPLICATE ANALYSIS START (${context}) ===`);

      const allTracks = new Map(); // identifier -> {track, locations: [{direction, index}]}
      const directionDuplicates = new Map(); // direction -> duplicate info
      const globalDuplicates = new Map(); // identifier -> locations array

      // Collect all tracks with their locations
      Object.entries(explorerData.directions).forEach(([directionKey, direction]) => {
          const sampleTracks = direction.sampleTracks || [];
          const directionTrackIds = new Set();
          const directionLocalDups = [];

          sampleTracks.forEach((trackObj, index) => {
              const track = trackObj.track || trackObj;
              const id = track.identifier;
              const location = { direction: directionKey, index };

              // Check for duplicates within this direction (VERY BAD)
              if (directionTrackIds.has(id)) {
                  directionLocalDups.push({
                      id, title: track.title, artist: track.artist,
                      indices: [directionLocalDups.find(d => d.id === id)?.indices || [], index].flat()
                  });
                  console.error(`🃏 VERY BAD: Duplicate in same direction ${directionKey}:`, {
                      id, title: track.title, artist: track.artist, index
                  });
              }
              directionTrackIds.add(id);

              // Track for global analysis
              if (!allTracks.has(id)) {
                  allTracks.set(id, { track, locations: [] });
              }
              allTracks.get(id).locations.push(location);
          });

          // Store direction-level duplicate info
          if (directionLocalDups.length > 0) {
              directionDuplicates.set(directionKey, directionLocalDups);
          }
      });

      // Analyze for cross-direction and cross-dimension duplicates
      let crossDirectionCount = 0;
      let crossDimensionCount = 0;

      allTracks.forEach(({ track, locations }, id) => {
          if (locations.length > 1) {
              globalDuplicates.set(id, locations);

              // Check if duplicates span different dimensions
              const dimensions = new Set(locations.map(loc => {
                  // Extract base dimension (remove _positive/_negative)
                  return loc.direction.replace(/_(?:positive|negative)$/, '');
              }));

              if (dimensions.size > 1) {
                  crossDimensionCount++;
                  console.warn(`🃏 WORSE: Cross-dimension duplicate:`, {
                      id, title: track.title, artist: track.artist,
                      dimensions: Array.from(dimensions),
                      locations: locations.map(l => `${l.direction}[${l.index}]`)
                  });
              } else {
                  crossDirectionCount++;
                  helpersDuplicateLog(`🃏 INTERESTING: Cross-direction duplicate:`, {
                      id, title: track.title, artist: track.artist,
                      directions: locations.map(l => l.direction),
                      locations: locations.map(l => `${l.direction}[${l.index}]`)
                  });
              }
          }
      });

      // Summary report
      helpersDuplicateLog(`🃏 === DUPLICATE ANALYSIS SUMMARY (${context}) ===`);
      helpersDuplicateLog(`🃏 Direction-level duplicates (VERY BAD): ${directionDuplicates.size} directions affected`);
      helpersDuplicateLog(`🃏 Cross-dimension duplicates (WORSE): ${crossDimensionCount} tracks`);
      helpersDuplicateLog(`🃏 Cross-direction duplicates (INTERESTING): ${crossDirectionCount} tracks`);
      helpersDuplicateLog(`🃏 Total duplicate tracks: ${globalDuplicates.size}`);
      helpersDuplicateLog(`🃏 === DUPLICATE ANALYSIS END ===`);

      return {
          directionDuplicates,
          crossDimensionCount,
          crossDirectionCount,
          globalDuplicates,
          totalDuplicates: globalDuplicates.size
      };
  }


  // Cycle through stack contents for back card clicks
  function cycleStackContents(directionKey, currentTrackIndex) {
      const stack = state.latestExplorerData.directions[directionKey];
      if (!stack) return;

      const sampleTracks = stack.sampleTracks || [];
      if (sampleTracks.length <= 1) return;

      // 🃏 FOCUSED DEBUG: Check this specific stack during cycling
      console.log(`🃏 CYCLE: Checking ${directionKey} stack during cycling...`);
      const stackAnalysis = { directions: { [directionKey]: { sampleTracks } } };
      performDuplicateAnalysis(stackAnalysis, `cycling-${directionKey}`);

      // Move to next track in stack, wrapping around
      const nextIndex = (currentTrackIndex + 1) % sampleTracks.length;
      const nextTrack = sampleTracks[nextIndex].track || sampleTracks[nextIndex];

      console.log(`🔄 Cycling stack: from index ${currentTrackIndex} to ${nextIndex}, track: ${nextTrack.title}`);

      // Update global track index
      state.stackIndex = nextIndex;

      // Update selection
      state.selectedIdentifier = nextTrack.identifier;
      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }
      state.remainingCounts[directionKey] = Math.max(0, sampleTracks.length - nextIndex - 1);

      const centerCard = document.querySelector('.dimension-card.next-track.selected')
          || document.querySelector('.dimension-card.next-track');
      if (centerCard) {
          centerCard.dataset.trackMd5 = nextTrack.identifier;
          centerCard.dataset.trackIndex = nextIndex;
          centerCard.dataset.totalTracks = String(sampleTracks.length);

          const directionData = state.latestExplorerData?.directions?.[directionKey];
          if (directionData) {
              const directionForUpdate = {
                  ...directionData,
                  key: directionKey,
                  sampleTracks: directionData.sampleTracks || sampleTracks
              };

              updateCardWithTrackDetails(centerCard, nextTrack, directionForUpdate, true, swapStackContents);

              if (typeof updateStackSizeIndicator === 'function') {
                  updateStackSizeIndicator(directionData, centerCard, nextIndex);
              }
          }
      }

      if (typeof window.updateNextTrackMetadata === 'function') {
          window.updateNextTrackMetadata(nextTrack);
      }

      // Update server
      sendNextTrack(nextTrack.identifier, directionKey, 'user');

      // Refresh UI
      refreshCardsWithNewSelection();
  }
  function createTrackDetailCard(direction, track, positionIndex, totalDimensions, isSelected, trackIndex, totalTracks, swapStackContents) {
      const swapFn = typeof swapStackContents === 'function' ? swapStackContents : (a, b) => {};
      const card = document.createElement('div');

      let cardClasses = 'dimension-card track-detail-card next-track';
      if (totalTracks > 1) {
          cardClasses += ' stacked';
      }
      if (totalTracks >= 3) {
          cardClasses += ' heavily-stacked';
      }
      if (direction.isOutlier) {
          cardClasses += ' outlier';
      }
      card.className = cardClasses;

      card.dataset.trackMd5 = track.identifier;
      card.dataset.trackIndex = trackIndex;
      card.dataset.totalTracks = totalTracks;
      card.dataset.trackTitle = getDisplayTitle(track) || '';
      card.dataset.trackArtist = track.artist || '';
      card.dataset.trackAlbum = track.album || '';
      if (track.albumCover) {
          card.dataset.trackAlbumCover = track.albumCover;
      } else {
          delete card.dataset.trackAlbumCover;
      }
      if (track.albumCover) {
          card.dataset.trackAlbumCover = track.albumCover;
      } else {
          delete card.dataset.trackAlbumCover;
      }
      card.dataset.trackAlbumCover = track.albumCover || '';

      const context = getDirectionVisualContext({ direction, card, track });
      if (!context) {
          console.warn(`⚠️ Unable to resolve direction context for track detail card (${direction?.key || 'unknown'})`);
          return card;
      }

      const { resolvedKey, directionType, directionColors, isNegative } = context;
      const colorVariant = variantFromDirectionType(directionType);

      card.dataset.directionKey = resolvedKey;
      if (!card.dataset.originalDirectionKey) {
          card.dataset.originalDirectionKey = resolvedKey;
      }

      // Position next track cards at CENTER of screen
      const centerX = 50;
      const centerY = 45;
      const angle = (positionIndex / totalDimensions) * Math.PI * 2 - Math.PI / 2;
      const radiusX = 8;
      const radiusY = 5;
      const baseX = centerX + radiusX * Math.cos(angle);
      const baseY = centerY + radiusY * Math.sin(angle);

      const offsetX = isSelected ? 0 : trackIndex * 2;
      const offsetY = isSelected ? 0 : -10;
      const offsetZ = isSelected ? -1000 : -2500 - (trackIndex * 250);
      const scale = isSelected ? 0.85 : 0.3;
      const zIndex = isSelected ? 100 : (200 - trackIndex);

      card.style.left = `${baseX + offsetX}%`;
      card.style.top = `${baseY + offsetY}%`;
      card.style.transform = `translate(-50%, -50%) scale(${scale})`;
      card.style.zIndex = zIndex;
      card.style.position = 'absolute';
      card.style.willChange = 'transform, opacity';

      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      const numericDuration = Number(track.duration ?? track.length);
      if (Number.isFinite(numericDuration)) {
          card.dataset.trackDurationSeconds = String(numericDuration);
      }
      card.dataset.trackDurationDisplay = duration;

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(resolvedKey);

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <span class="rim"></span>
              <div class="label">
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${track.album || ''}</h5>
                  <p>${duration} · FLAC</p>
              </div>
          </div>
      `;

      card.style.setProperty('--border-color', directionColors.border);
      card.style.setProperty('--glow-color', directionColors.glow);
      card.classList.toggle('negative-direction', isNegative);

      const rimEl = card.querySelector('.rim');
      if (rimEl) {
          const rimStyle = isNegative
              ? `conic-gradient(from 180deg, ${directionColors.glow}, ${directionColors.border}, ${directionColors.glow})`
              : `conic-gradient(${directionColors.border}, ${directionColors.glow}, ${directionColors.border})`;
          rimEl.style.background = rimStyle;
      }

      applyReverseBadge(card, direction, context, {
          interactive: isSelected,
          extraClasses: isSelected ? 'enabled' : 'has-opposite'
      });

      card.addEventListener('click', (e) => {
          if (e.target.closest('.uno-reverse')) {
              console.log(`🔄 Clicked on reverse icon, ignoring card click`);
              return;
          }

          console.log(`🔄 Cycling stack for dimension: ${resolvedKey} from track index ${state.stackIndex}`);
          cycleStackContents(resolvedKey, state.stackIndex);
      });

      const reverseButton = card.querySelector('.uno-reverse.next-track-reverse');
      if (reverseButton) {
          reverseButton.addEventListener('click', (e) => {
              e.stopPropagation();
              const interactionState = typeof window !== 'undefined' ? (window.__deckInteractionState || {}) : {};
              if (interactionState.cardsLocked) {
                  console.warn('🔒 Reverse toggle ignored while cards are locked');
                  return;
              }
              console.log(`🔄 Swapping stack contents from ${resolvedKey} to opposite`);

              const currentDirection = state.latestExplorerData.directions[resolvedKey];
              if (currentDirection && currentDirection.oppositeDirection) {
                  const oppositeKey = getOppositeDirection(resolvedKey);
                  if (oppositeKey) {
                      state.latestExplorerData.directions[oppositeKey] = {
                          ...currentDirection.oppositeDirection,
                          hasOpposite: true,
                          key: oppositeKey
                      };

                      swapFn(resolvedKey, oppositeKey);
                  }
              } else {
                  console.warn(`Opposite direction not available for ${resolvedKey}`);
              }
          });
      }

      return card;
  }

  function ensureStackedPreviewLayer() {
      const container = document.getElementById('dimensionCards');
      if (!container) return null;
      let layer = container.querySelector('.stacked-preview-layer');
      if (!layer) {
          layer = document.createElement('div');
          layer.className = 'stacked-preview-layer';
          container.appendChild(layer);
      }
      return layer;
  }

  function clearStackedPreviewLayer() {
      const container = document.getElementById('dimensionCards');
      if (!container) return;
      const layer = container.querySelector('.stacked-preview-layer');
      if (layer) {
          layer.innerHTML = '';
      }
  }

  function renderStackedPreviews(card, direction, selectedIndex) {
      const container = document.getElementById('dimensionCards');
      if (!container) return;

      const layer = ensureStackedPreviewLayer();
      if (!layer) return;

      if (!card || !card.classList.contains('next-track')) {
          clearStackedPreviewLayer();
          return;
      }

      const samples = Array.isArray(direction?.sampleTracks)
          ? direction.sampleTracks.map(entry => entry?.track || entry).filter(Boolean)
          : [];

      console.debug('🃏 STACK PREVIEW INPUT', {
          directionKey: direction?.key || card?.dataset?.directionKey || null,
          sampleCount: samples.length,
          providedSelectedIndex: selectedIndex,
          cardTrackId: card.dataset?.trackMd5 || null
      });

      const currentId = card.dataset.trackMd5 || null;
      let activeIndex = samples.findIndex(sample => sample?.identifier === currentId);
      if (activeIndex < 0 && Number.isFinite(selectedIndex)) {
          activeIndex = selectedIndex;
      }

      if (samples.length > 0) {
          if (activeIndex < 0) {
              const fallbackIndex = Number.isFinite(selectedIndex) ? selectedIndex : 0;
              activeIndex = Math.min(Math.max(fallbackIndex, 0), samples.length - 1);
          } else {
              activeIndex = activeIndex % samples.length;
          }
      }

      const remaining = [];
      if (samples.length > 1) {
          for (let i = 1; i < samples.length; i++) {
              const nextIndex = (activeIndex + i) % samples.length;
              const candidate = samples[nextIndex];
              if (candidate) {
                  remaining.push(candidate);
              }
          }
      }

      console.debug('🃏 STACK PREVIEW REMAINING', {
          activeIndex,
          remainingCount: remaining.length,
          remainingIds: remaining.map(sample => sample?.identifier).filter(Boolean)
      });

      if (!remaining.length) {
          clearStackedPreviewLayer();
          return;
      }

      const containerRect = container.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const baseWidth = cardRect.width || 200;
      const baseHeight = cardRect.height || baseWidth * (5 / 3);
      const originX = cardRect.left - containerRect.left;
      const originY = cardRect.top - containerRect.top;

      layer.innerHTML = '';

      const maxItems = 4;
      const previews = remaining.slice(0, maxItems);
      previews.forEach((sample, index) => {
          const scale = Math.pow(0.9, index + 1);
          let offsetX = originX + baseWidth * 0.1 + 30 * (index - 1);
          const offsetY = originY + 16 * index;

          const preview = document.createElement('div');
          preview.className = 'stacked-preview-layer-card';
          preview.style.width = `${baseWidth}px`;
          preview.style.height = `${baseHeight}px`;
          preview.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
          const zIndex = previews.length - index;
          preview.style.zIndex = `${zIndex}`;

          const panel = document.createElement('div');
          panel.className = 'preview-panel';

          const photo = document.createElement('div');
          photo.className = 'preview-photo';
          if (sample.albumCover) {
              photo.style.backgroundImage = `url("${sample.albumCover}")`;
          }

          const rim = document.createElement('span');
          rim.className = 'preview-rim';

          const label = document.createElement('div');
          label.className = 'preview-label';
          label.innerHTML = `
              <h4>${formatDirectionName(direction.key || direction.direction || '')}</h4>
              <h5>${getDisplayTitle(sample)}</h5>
          `;

          panel.appendChild(photo);
          panel.appendChild(rim);
          panel.appendChild(label);
          preview.appendChild(panel);
          layer.appendChild(preview);
      });
  }

  function redrawDimensionCardsWithNewNext(newNextDirectionKey) {
      if (!state.latestExplorerData) return;

      const targetDimension = state.latestExplorerData.directions?.[newNextDirectionKey];
      if (!targetDimension) {
          console.warn(`🔄 redrawDimensionCardsWithNewNext: direction ${newNextDirectionKey} not found`);
          return;
      }

      const normalizeSample = (sample) => {
          if (!sample) return null;
          if (sample.track) return sample.track;
          return sample;
      };

      const sampleTracks = (targetDimension.sampleTracks || [])
          .map(normalizeSample)
          .filter(track => track && track.identifier);

      if (!sampleTracks.length) {
          console.warn(`🔄 redrawDimensionCardsWithNewNext: no sample tracks for ${newNextDirectionKey}`);
          return;
      }

      const selectedTrackIndex = state.selectedIdentifier
          ? sampleTracks.findIndex(track => track.identifier === state.selectedIdentifier)
          : 0;
      const finalSelectedIndex = selectedTrackIndex >= 0 ? selectedTrackIndex : 0;
      const selectedTrack = sampleTracks[finalSelectedIndex] || sampleTracks[0];

      state.stackIndex = finalSelectedIndex;
      state.selectedIdentifier = selectedTrack?.identifier || state.selectedIdentifier;
      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }
      state.remainingCounts[newNextDirectionKey] = Math.max(0, sampleTracks.length - finalSelectedIndex - 1);

      state.latestExplorerData.nextTrack = {
          directionKey: newNextDirectionKey,
          direction: targetDimension.direction,
          track: selectedTrack
      };

      const currentNextCard = document.querySelector('.dimension-card.next-track');
      let demoteDelay = 0;
      if (currentNextCard) {
          const currentKey = currentNextCard.dataset.baseDirectionKey
              || currentNextCard.dataset.originalDirectionKey
              || currentNextCard.dataset.directionKey
              || null;
          if (currentKey && currentKey !== newNextDirectionKey && typeof rotateCenterCardToNextPosition === 'function') {
              const demoted = rotateCenterCardToNextPosition(currentKey)
                  || rotateCenterCardToNextPosition(currentNextCard.dataset.directionKey || currentKey);
              if (demoted) {
                  demoteDelay = 820; // match animation duration in rotateCenterCardToNextPosition
              }
          }
      }

      const promote = () => {
          if (typeof animateDirectionToCenter === 'function') {
              animateDirectionToCenter(newNextDirectionKey);
          } else {
              // Fallback: directly convert card without animation
              const targetCard = document.querySelector(`[data-direction-key="${newNextDirectionKey}"]`);
              if (!targetCard) {
                  console.warn(`🔄 redrawDimensionCardsWithNewNext: no card found for ${newNextDirectionKey}`);
                  return;
              }
              updateCardWithTrackDetails(targetCard, selectedTrack, {
                  ...targetDimension,
                  key: newNextDirectionKey,
                  sampleTracks: sampleTracks.map(track => ({ track }))
              }, true, swapStackContents);
              targetCard.classList.add('next-track', 'track-detail-card');
          }
      };

      if (demoteDelay > 0) {
          setTimeout(promote, demoteDelay);
      } else {
          promote();
      }
  }

  function createNextTrackCardStack(direction, index, total, nextTrackData, container) {
      // Get all sample tracks for this direction
      direction.sampleTracks = (direction.sampleTracks || []).map(entry => entry.track || entry);
      const sampleTracks = direction.sampleTracks;
      // Use global selection state, default to first track if none selected
      const selectedTrackIndex = state.selectedIdentifier
          ? sampleTracks.findIndex(trackObj => {
              const track = trackObj.track || trackObj;
              return track.identifier === state.selectedIdentifier;
            })
          : 0;
      const finalSelectedTrackIndex = selectedTrackIndex >= 0 ? selectedTrackIndex : 0;

      const directionKey = direction.key || nextTrackData?.directionKey || direction.directionKey || `direction_${index}`;
      if (!state.remainingCounts) {
          state.remainingCounts = {};
      }
      state.remainingCounts[directionKey] = Math.max(0, sampleTracks.length - finalSelectedTrackIndex - 1);

      // Create selected card (front, fully visible)
      const selectedTrack = sampleTracks[finalSelectedTrackIndex];
      const swapFn = typeof swapStackContents === 'function' ? swapStackContents : () => {};
      const selectedCard = createTrackDetailCard(direction, selectedTrack.track || selectedTrack, index, total, true, 0, sampleTracks.length, swapFn);
      container.appendChild(selectedCard);
      selectedCard.dataset.trackIndex = String(finalSelectedTrackIndex);
      selectedCard.dataset.totalTracks = String(sampleTracks.length);

      // Stack depth indication is now handled via CSS pseudo-elements on the main card

      // Stagger animation for selected card
      setTimeout(() => {
          selectedCard.classList.add('visible');
      }, index * 150 + 1000);
  }



  // Hide the direction key overlay
  function hideDirectionKeyOverlay() {
      const overlay = document.getElementById('directionKeyOverlay');
      if (overlay) {
          overlay.classList.add('hidden');
      }
  }

  // Update the JSON metadata overlay with full next track data
  function updateDirectionKeyOverlay(direction, trackData) {
      helpersColorLog(`🎨 JSON 1`);
      const overlay = document.getElementById('directionKeyOverlay');
      const text1 = document.getElementById('dkt1');
      const text2 = document.getElementById('dkt2');

      if (!overlay || !text1 || !text2) return;
      helpersColorLog(`🎨 JSON 2`);

      const trackPayload = trackData || state.latestExplorerData?.nextTrack?.track || state.latestExplorerData?.nextTrack || state.latestCurrentTrack;
      const metadata2 = {
          direction: {
              key: direction.key,
              name: direction.name || formatDirectionName(direction.key),
              description: direction.description,
              trackCount: direction.trackCount,
              diversityScore: direction.diversityScore,
              sampleTracks: direction.sampleTracks?.length || 0
          },
          nextTrack: trackPayload ? {
              identifier: trackPayload.identifier,
              title: getDisplayTitle(trackPayload),
              artist: trackPayload.artist || 'Unknown Artist',
              album: trackPayload.album || null,
              duration: trackPayload.duration,
              distance: trackPayload.distance,
              features: trackPayload.features,
              beetsMeta: trackPayload.beetsMeta || trackPayload.beets || null
          } : null,
      };

      // Format as readable JSON with proper indentation
      helpersColorLog(`🎨 JSON 3`);
      const sanitizedTrackPayload = sanitizeMetadataValue(trackPayload) ?? null;
      text1.textContent = JSON.stringify(sanitizedTrackPayload, null, 2);
      console.dir({got: text1.textContent, from: trackPayload});
      const sanitizedMetadata = sanitizeMetadataValue(metadata2) ?? null;
      text2.textContent = JSON.stringify(sanitizedMetadata, null, 2);
      console.dir({got: text2.textContent, from: metadata2});

      helpersColorLog(`🎨 JSON metadata overlay updated for: ${direction.key}`);
  }


  // Update card content with track details
  function updateCardWithTrackDetails(card, track, direction, preserveColors = false, swapStackContents) {
      const swapFn = typeof swapStackContents === 'function' ? swapStackContents : (a, b) => {};
      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      if (track && typeof window !== 'undefined' && typeof hydrateTrackDetails === 'function') {
          try {
              hydrateTrackDetails(track, { reason: 'card-update' }).catch(() => {});
          } catch (err) {
              // Swallow hydration errors - cards can render with partial metadata
          }
      }

      const context = getDirectionVisualContext({
          direction,
          card,
          track,
          fallbackKey: card.dataset.originalDirectionKey
      });

      if (!context) {
          console.warn(`⚠️ Unable to resolve direction context when updating card (${direction?.key || 'unknown'})`);
          return;
      }

      const { resolvedKey, directionType, directionColors, isNegative } = context;
      direction.key = resolvedKey;

      if (!card.dataset.originalDirectionKey) {
          card.dataset.originalDirectionKey = resolvedKey;
      }

      const variantClass = variantFromDirectionType(directionType);

      if (typeof window !== 'undefined' && typeof setCardVariant === 'function') {
          setCardVariant(card, variantFromDirectionType(directionType));
      }

      const baseDirectionKeyForCard = card.dataset.baseDirectionKey
          || state.baseDirectionKey
          || resolvedKey;

      const declaredOpposite = direction?.hasOpposite === true
          || !!resolveOppositeDirectionKey(direction)
          || hasOppositeForDirection(direction, resolvedKey);
      const oppositeAvailable = hasActualOpposite(direction, resolvedKey);

      if (state.usingOppositeDirection && oppositeAvailable) {
          card.dataset.baseDirectionKey = baseDirectionKeyForCard;
          const reversedTargetKey = baseDirectionKeyForCard && baseDirectionKeyForCard !== resolvedKey
              ? baseDirectionKeyForCard
              : (state.currentOppositeDirectionKey && state.currentOppositeDirectionKey !== resolvedKey
                  ? state.currentOppositeDirectionKey
                  : getOppositeDirection(resolvedKey) || baseDirectionKeyForCard);

          if (reversedTargetKey && reversedTargetKey !== resolvedKey) {
              card.dataset.oppositeDirectionKey = reversedTargetKey;
          } else {
              delete card.dataset.oppositeDirectionKey;
          }
      } else {
          card.dataset.baseDirectionKey = resolvedKey;
          const forwardTargetKey = (oppositeAvailable || declaredOpposite)
              ? (state.currentOppositeDirectionKey && state.currentOppositeDirectionKey !== resolvedKey
                  ? state.currentOppositeDirectionKey
                  : getOppositeDirection(resolvedKey))
              : null;

          if (forwardTargetKey && forwardTargetKey !== resolvedKey) {
              card.dataset.oppositeDirectionKey = forwardTargetKey;
          } else {
              delete card.dataset.oppositeDirectionKey;
          }
      }

      if (oppositeAvailable && card.dataset.oppositeDirectionKey) {
          direction.hasOpposite = true;
          direction.oppositeDirection = {
              ...(direction.oppositeDirection || {}),
              key: direction.oppositeDirection?.key || card.dataset.oppositeDirectionKey,
              direction: direction.oppositeDirection?.direction || card.dataset.oppositeDirectionKey
          };
      } else if (declaredOpposite) {
          direction.hasOpposite = true;
          if (!direction.oppositeDirection && card.dataset.oppositeDirectionKey) {
              direction.oppositeDirection = { key: card.dataset.oppositeDirectionKey };
          }
      } else {
          direction.hasOpposite = false;
          if (direction.oppositeDirection && !Array.isArray(direction.oppositeDirection.sampleTracks)) {
              delete direction.oppositeDirection;
          }
      }

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(resolvedKey);
      const hasOpposite = declaredOpposite || oppositeAvailable;
      const wantsInteractiveReverse = oppositeAvailable && (card.classList.contains('next-track') || card.classList.contains('track-detail-card'));
      card.dataset.directionType = directionType;
      let maskIsNegative = isNegative;

      const sampleTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
      const currentIndex = sampleTracks.findIndex(sample => {
          const candidate = sample?.track || sample;
          return candidate?.identifier === track.identifier;
      });

      if (track.identifier) {
          card.dataset.trackMd5 = track.identifier;
      }
      card.dataset.trackIndex = currentIndex >= 0 ? currentIndex : 0;
      card.dataset.directionKey = resolvedKey;

      // Persist core track metadata so later refreshes can fall back to the latest details
      card.dataset.trackTitle = getDisplayTitle(track) || '';
      card.dataset.trackArtist = track.artist || '';
      card.dataset.trackAlbum = track.album || '';

      const numericDuration = Number(track.duration ?? track.length);
      if (Number.isFinite(numericDuration)) {
          card.dataset.trackDurationSeconds = String(numericDuration);
      } else {
          delete card.dataset.trackDurationSeconds;
      }
      card.dataset.trackDurationDisplay = duration;

      let borderColor, glowColor;

      if (preserveColors) {
          // When preserving colors (e.g., card promotion to center), use existing CSS custom properties
          helpersColorLog(`🎨 PRESERVE: Keeping existing colors for ${resolvedKey}`);
          const computedStyle = getComputedStyle(card);
          borderColor = computedStyle.getPropertyValue('--border-color').trim() ||
                       card.style.getPropertyValue('--border-color').trim();
          glowColor = computedStyle.getPropertyValue('--glow-color').trim() ||
                     card.style.getPropertyValue('--glow-color').trim();

          // Fallback: if no existing colors, calculate fresh ones
          if (!borderColor || !glowColor) {
              helpersColorLog(`🎨 PRESERVE FALLBACK: No existing colors found, calculating fresh ones`);
              const freshColors = getDirectionColor(directionType, resolvedKey);
              borderColor = borderColor || freshColors.border;
              glowColor = glowColor || freshColors.glow;
          }
      } else {
          // Always respect the intrinsic palette of the resolved direction
          if (state.usingOppositeDirection) {
              helpersColorLog(`🎨 OPPOSITE: Using intrinsic colors for ${resolvedKey} (${directionType})`);
          } else {
              helpersColorLog(`🎨 NORMAL: Using intrinsic colors for ${resolvedKey} (${directionType})`);
          }
          borderColor = directionColors.border;
          glowColor = directionColors.glow;
      }

      borderColor = borderColor || directionColors.border;
      glowColor = glowColor || directionColors.glow;

      // Apply the final colors
      card.style.setProperty('--border-color', borderColor);
      card.style.setProperty('--glow-color', glowColor);
      card.style.setProperty('--card-border-color', borderColor);
      if (typeof window !== 'undefined' && typeof getCardBackgroundColor === 'function') {
          card.style.setProperty('--card-background-color', getCardBackgroundColor(directionType));
      }

      // ALSO update the data attributes to match
      card.dataset.borderColor = borderColor;
      card.dataset.glowColor = glowColor;

      const applyNegativeMask = (mask) => {
          card.classList.toggle('negative-direction', mask);
          const rimEl = card.querySelector('.rim');
          if (!rimEl) return;
          const rimBorder = card.dataset.borderColor || borderColor;
          const rimGlow = card.dataset.glowColor || glowColor;
          const rimStyle = mask
              ? `conic-gradient(from 180deg, ${rimGlow}, ${rimBorder}, ${rimGlow})`
              : `conic-gradient(${rimBorder}, ${rimGlow}, ${rimBorder})`;
          rimEl.style.background = rimStyle;
      };

      // Preserve existing panel classes (color variants)
      const existingPanel = card.querySelector('.panel');
      let panelClasses = 'panel';
      if (existingPanel) {
          panelClasses = existingPanel.className;
      } else {
          panelClasses = `panel ${variantClass}`;
      }

      const newHTML = `
          <div class="${panelClasses}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <div class="rim"></div>
              <div class="label">
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${track.album || ''}</h5>
                  <p>${duration} · FLAC</p>
              </div>
          </div>
      `;

      card.innerHTML = newHTML;
      card.dataset.directionKey = resolvedKey;

      applyNegativeMask(maskIsNegative);

      maskIsNegative = isNegativeDirection(card.dataset.directionKey || resolvedKey);
      applyNegativeMask(maskIsNegative);
      context.isNegative = maskIsNegative;

      if (wantsInteractiveReverse) {
          const highlight = maskIsNegative ? 'top' : 'bottom';
          applyReverseBadge(card, direction, context, {
              interactive: true,
              highlightOverride: highlight,
              extraClasses: 'enabled'
          });
      } else {
          applyReverseBadge(card, direction, context, {
              interactive: false,
              extraClasses: 'has-opposite'
          });
      }

      const reverseButton = card.querySelector('.uno-reverse.next-track-reverse');
      if (reverseButton) {
          reverseButton.classList.toggle('reversed', state.usingOppositeDirection);
          reverseButton.addEventListener('click', (e) => {
              e.stopPropagation();
              console.log(`🔄 Reverse icon clicked for ${resolvedKey}`);

              const oppositeKey = getOppositeDirection(resolvedKey);
              console.log(`🔄 Opposite key found: ${oppositeKey}`);
              if (oppositeKey) {
                  console.log(`🔄 About to call swapStackContents(${resolvedKey}, ${oppositeKey})`);
                  swapFn(resolvedKey, oppositeKey);
              } else {
                  console.warn(`No opposite direction found for ${resolvedKey}`);
              }
          });
      }

      const stackIndex = Array.isArray(direction.sampleTracks)
          ? direction.sampleTracks.findIndex(sample => {
              const candidate = sample?.track || sample;
              return candidate?.identifier === track.identifier;
          })
          : -1;
      if (stackIndex >= 0) {
          card.dataset.trackIndex = stackIndex;
      }

      // Update stack size indicator for next track stacks
      if (card.classList.contains('next-track')) {
          const sampleCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
          card.style.marginLeft = sampleCount > 1 ? '-40px' : '0px';

          updateStackSizeIndicator(direction, card, stackIndex >= 0 ? stackIndex : undefined);
          updateDirectionKeyOverlay(direction, track);
          const numericIndex = Number(card.dataset.trackIndex ?? stackIndex ?? 0);
          const resolvedIndex = Number.isFinite(numericIndex) ? numericIndex : 0;
          // TODO(deck-orchestration): Replace double rAF with orchestrated render once deck render pipeline is centralised.
          requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                  renderStackedPreviews(card, direction, resolvedIndex);
              });
          });
      } else {
          card.style.marginLeft = '0px';
          if (typeof applyDirectionStackIndicator === 'function') {
              applyDirectionStackIndicator(direction, card);
          } else {
              hideStackSizeIndicator(card);
          }
          hideDirectionKeyOverlay();
          clearStackedPreviewLayer();
      }

      if (typeof evaluateDirectionConsistency === 'function') {
          const samplesForCheck = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
          evaluateDirectionConsistency(direction, {
              card,
              sampleTracks: samplesForCheck,
              currentTrack: state?.latestCurrentTrack
          });
      }
  }
  function resolveConsistencyTolerance(referenceValue = 0, spreadValue = 0) {
      const magnitude = Math.max(Math.abs(referenceValue || 0), Math.abs(spreadValue || 0));
      const relativeComponent = magnitude * CONSISTENCY_DYNAMIC_RELATIVE;
      return Math.max(CONSISTENCY_CHECK_TOLERANCE, CONSISTENCY_DYNAMIC_MIN_TOLERANCE, relativeComponent);
  }
  function sanitizeMetadataValue(value) {
      if (value === null || value === undefined) {
          return value;
      }
      if (typeof value === 'string') {
          return value.trim() === '' ? undefined : value;
      }
      if (Array.isArray(value)) {
          const mapped = value
              .map(item => sanitizeMetadataValue(item))
              .filter(item => item !== undefined);
          return mapped;
      }
      if (typeof value === 'object') {
          const result = {};
          let hasValue = false;
          Object.entries(value).forEach(([key, val]) => {
              const sanitized = sanitizeMetadataValue(val);
              if (sanitized !== undefined) {
                  result[key] = sanitized;
                  hasValue = true;
              }
          });
          return hasValue ? result : undefined;
      }
      return value;
  }

// ES module exports
export {
    getDisplayTitle,
    photoStyle,
    albumCoverBackground,
    renderReverseIcon,
    updateCardWithTrackDetails,
    cycleStackContents,
    applyDirectionStackIndicator,
    resolveOppositeBorderColor,
    createNextTrackCardStack,
    hideStackSizeIndicator,
    applyReverseBadge,
    ensureStackedPreviewLayer,
    clearStackedPreviewLayer,
    renderStackedPreviews,
    redrawDimensionCardsWithNewNext,
    hideDirectionKeyOverlay,
    updateDirectionKeyOverlay,
    decodeHexEncodedPath,
    extractFileStem
};

// Keep window.* for console debugging
if (typeof window !== 'undefined') {
    window.getDisplayTitle = getDisplayTitle;
    window.photoStyle = photoStyle;
    window.updateCardWithTrackDetails = updateCardWithTrackDetails;
}
