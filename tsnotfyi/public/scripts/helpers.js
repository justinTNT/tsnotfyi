// HTML Helpers: page independent, some explorer state.
//  *) utils
//  *) card details
//  *) createTrackDetailCard
//  *) updateCardWithTrackDetails
//  *) createDirectionCard

import { state, getCardBackgroundColor } from './globals.js';
import { getDirectionType, formatDirectionName, isNegativeDirection, getOppositeDirection, getDirectionColor, variantFromDirectionType } from './tools.js';
import { findTrackInExplorer, hydrateTrackDetails } from './explorer-utils.js';
import { setCardVariant } from './deck-render.js';
import { playlistHasItems } from './playlist-tray.js';


  // create all the styling for album covers
  const albumCoverBackground = (albumCover) => {
    const escaped = albumCover ? albumCover.replace(/'/g, "\\'") : '';
    return `url('${escaped}')`;
  }

  const photoStyle = (albumCover) =>
    `background: ${albumCoverBackground(albumCover)}; background-size: 120%; background-position-x: 45%`

  // Preload album cover images before rendering
  // Returns a promise that resolves when all critical covers are loaded (or fail)
  function preloadAlbumCovers(explorerData, options = {}) {
    const { timeout = 3000 } = options;
    const covers = new Set();

    // Current track cover (most important)
    if (explorerData?.currentTrack?.albumCover) {
      covers.add(explorerData.currentTrack.albumCover);
    }

    // Next track cover
    const nextTrack = explorerData?.nextTrack?.track || explorerData?.nextTrack;
    if (nextTrack?.albumCover) {
      covers.add(nextTrack.albumCover);
    }

    // First sample from each direction (visible on initial render)
    if (explorerData?.directions) {
      Object.values(explorerData.directions).forEach(dir => {
        const firstSample = dir.sampleTracks?.[0];
        const track = firstSample?.track || firstSample;
        if (track?.albumCover) {
          covers.add(track.albumCover);
        }
      });
    }

    if (covers.size === 0) {
      return Promise.resolve([]);
    }

    console.log(`🖼️ Preloading ${covers.size} album covers...`);

    const loadPromises = Array.from(covers).map(url => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ url, status: 'loaded' });
        img.onerror = () => resolve({ url, status: 'error' });
        img.src = url;
      });
    });

    // Race against timeout - don't block forever on slow/failed images
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), timeout);
    });

    return Promise.race([
      Promise.all(loadPromises).then(results => {
        const loaded = results.filter(r => r.status === 'loaded').length;
        console.log(`🖼️ Preloaded ${loaded}/${covers.size} album covers`);
        return results;
      }),
      timeoutPromise.then(() => {
        console.log(`🖼️ Album cover preload timed out after ${timeout}ms`);
        return [{ status: 'timeout' }];
      })
    ]);
  }

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
      // Check if an opposite direction exists with DISTINCT tracks
      // User expects different music when switching directions
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

      // Check that opposite has at least one track different from primary
      const primaryIds = new Set(extractSampleIdentifiers(direction?.sampleTracks || []));
      if (primaryIds.size === 0) {
          return true; // No primary tracks, any opposite tracks are "distinct"
      }
      return oppositeIds.some(id => !primaryIds.has(id));
  }

  function applyReverseBadge(card, direction, context, { interactive = false, extraClasses = '', highlightOverride = null } = {}) {
      const panel = card.querySelector('.panel');
      const existing = card.querySelector('.uno-reverse');
      if (existing) {
          existing.remove();
      }

      const oppositeKey = resolveOppositeDirectionKey(direction) || getOppositeDirection(context.resolvedKey);
      // Only show reverse icon if there are actual distinct tracks in the opposite direction
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

  // Cycle through stack contents for back card clicks
  function cycleStackContents(directionKey, currentTrackIndex) {
      const stack = state.latestExplorerData.directions[directionKey];
      if (!stack) return;

      const sampleTracks = stack.sampleTracks || [];
      if (sampleTracks.length <= 1) return;

      // Move to next track in stack, wrapping around
      const nextIndex = (currentTrackIndex + 1) % sampleTracks.length;
      const nextTrack = sampleTracks[nextIndex].track || sampleTracks[nextIndex];

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


      // Update server (only if playlist is empty — playlist takes priority)
      if (!playlistHasItems()) {
          sendNextTrack(nextTrack.identifier, directionKey, 'user');
      }

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
      card.dataset.trackAlbum = track.album || track.beetsMeta?.album?.album || track.beetsMeta?.item?.album || '';
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

      const albumName = track.album
          || track.beetsMeta?.album?.album
          || track.beetsMeta?.item?.album
          || card.dataset.trackAlbum
          || '';

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <span class="rim"></span>
              <div class="label">
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${albumName}</h5>
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
              return;
          }
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

  /**
   * Animate stacked preview cards to pack behind the center card
   * @returns {Promise} Resolves when animation completes
   */
  function packUpStackCards() {
      return new Promise((resolve) => {
          const container = document.getElementById('dimensionCards');
          if (!container) {
              resolve();
              return;
          }

          const layer = container.querySelector('.stacked-preview-layer');
          if (!layer) {
              resolve();
              return;
          }

          const previewCards = layer.querySelectorAll('.stacked-preview-layer-card');
          if (previewCards.length === 0) {
              resolve();
              return;
          }

          // Get center card position
          const centerCard = document.querySelector('.dimension-card.next-track');
          if (!centerCard) {
              clearStackedPreviewLayer();
              resolve();
              return;
          }

          const containerRect = container.getBoundingClientRect();
          const cardRect = centerCard.getBoundingClientRect();
          const targetX = cardRect.left - containerRect.left;
          const targetY = cardRect.top - containerRect.top;

          // Animate each preview card to stack directly behind center card
          previewCards.forEach((preview, index) => {
              preview.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease';
              preview.style.transformOrigin = 'center center';

              requestAnimationFrame(() => {
                  // All cards go to same position (stacked directly behind center)
                  preview.style.transform = `translate(${targetX}px, ${targetY}px) scale(1)`;
                  preview.style.opacity = '0';
              });
          });

          // Clear after animation completes
          setTimeout(() => {
              clearStackedPreviewLayer();
              resolve();
          }, 320);
      });
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
              // Escape quotes in path for CSS url()
              const escapedCover = sample.albumCover.replace(/["']/g, '\\$&');
              photo.style.backgroundImage = `url("${escapedCover}")`;
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
      // Center cards (promoted cards) should also get interactive reverse if opposite is available
      const isCardInCenter = card.classList.contains('center') || card.classList.contains('now-playing') || card.classList.contains('current-track');
      const wantsInteractiveReverse = oppositeAvailable && (card.classList.contains('next-track') || card.classList.contains('track-detail-card') || isCardInCenter);
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
      card.dataset.trackAlbum = track.album || track.beetsMeta?.album?.album || track.beetsMeta?.item?.album || '';

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
          const computedStyle = getComputedStyle(card);
          borderColor = computedStyle.getPropertyValue('--border-color').trim() ||
                       card.style.getPropertyValue('--border-color').trim();
          glowColor = computedStyle.getPropertyValue('--glow-color').trim() ||
                     card.style.getPropertyValue('--glow-color').trim();

          // Fallback: if no existing colors, calculate fresh ones
          if (!borderColor || !glowColor) {
              const freshColors = getDirectionColor(directionType, resolvedKey);
              borderColor = borderColor || freshColors.border;
              glowColor = glowColor || freshColors.glow;
          }
      } else {
          // Always respect the intrinsic palette of the resolved direction
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

      const albumName = track.album
          || track.beetsMeta?.album?.album
          || track.beetsMeta?.item?.album
          || card.dataset.trackAlbum
          || '';

      const newHTML = `
          <div class="${panelClasses}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <div class="rim"></div>
              <div class="label">
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${albumName}</h5>
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
              const oppositeKey = getOppositeDirection(resolvedKey);
              if (oppositeKey) {
                  swapFn(resolvedKey, oppositeKey);
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
    preloadAlbumCovers,
    renderReverseIcon,
    updateCardWithTrackDetails,
    cycleStackContents,
    applyDirectionStackIndicator,
    resolveOppositeBorderColor,
    resolveOppositeDirectionKey,
    createNextTrackCardStack,
    hideStackSizeIndicator,
    applyReverseBadge,
    hasActualOpposite,
    ensureStackedPreviewLayer,
    clearStackedPreviewLayer,
    packUpStackCards,
    renderStackedPreviews,
    redrawDimensionCardsWithNewNext,
    hideDirectionKeyOverlay,
    decodeHexEncodedPath,
    extractFileStem
};

// Keep window.* for console debugging
if (typeof window !== 'undefined') {
    window.getDisplayTitle = getDisplayTitle;
    window.photoStyle = photoStyle;
    window.updateCardWithTrackDetails = updateCardWithTrackDetails;
    window.packUpStackCards = packUpStackCards;
    window.preloadAlbumCovers = preloadAlbumCovers;
}
