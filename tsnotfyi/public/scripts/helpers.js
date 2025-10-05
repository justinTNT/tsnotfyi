// HTML Helpers: page independent, some explorer state.
//  *) utils
//  *) card details
//  *) createTrackDetailCard
//  *) updateCardWithTrackDetails
//  *) createDirectionCard

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

  function getDisplayTitle(track) {
      return track.title ||
          (track.identifier ? `Track ${track.identifier.substring(0, 8)}...` : 'Unknown Track');
  }

  function findTrackInExplorer(directionKey, explorerData, identifier) {
      if (!explorerData || !explorerData.directions || !identifier) return null;
      const directions = explorerData.directions;
      const inspect = (direction) => {
          if (!direction) return null;
          const primary = direction.sampleTracks || [];
          for (const sample of primary) {
              const track = sample.track || sample;
              if (track?.identifier === identifier) return track;
          }
          if (direction.oppositeDirection) {
              const oppositeSamples = direction.oppositeDirection.sampleTracks || [];
              for (const sample of oppositeSamples) {
                  const track = sample.track || sample;
                  if (track?.identifier === identifier) return track;
              }
          }
          return null;
      };

      if (directionKey && directions[directionKey]) {
          const directHit = inspect(directions[directionKey]);
          if (directHit) return directHit;
      }

      for (const direction of Object.values(directions)) {
          const hit = inspect(direction);
          if (hit) return hit;
      }
      return null;
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

  // Update the stack visualization with remaining track count
  function updateStackSizeIndicator(direction, cardForContext, overrideIndex) {
      const nextTrackCard = cardForContext
          || document.querySelector('.dimension-card.next-track.selected')
          || document.querySelector('.dimension-card.next-track');
      if (!nextTrackCard) return;

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
      const currentTrack = window.state?.latestCurrentTrack;
      const sampleTracks = direction.sampleTracks || [];
      const activeIdentifier = window.state?.selectedIdentifier || md5;
      const matchedTrack = sampleTracks.find(sample => {
          const track = sample.track || sample;
          return track.identifier === activeIdentifier;
      }) || sampleTracks.find(sample => {
          const track = sample.track || sample;
          return track.identifier === md5;
      }) || sampleTracks[0];
      const nextTrackPayload = window.state?.latestExplorerData?.nextTrack?.track || window.state?.latestExplorerData?.nextTrack || {};
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
      if (matchedIndex < 0 && typeof window.state?.stackIndex === 'number') {
          matchedIndex = window.state.stackIndex;
      }
      if (matchedIndex < 0) {
          matchedIndex = 0;
      }

      const totalTracks = Number.isFinite(totalTracksFromDataset) && totalTracksFromDataset > 0
          ? totalTracksFromDataset
          : (sampleTracks.length || tracksToCount.length || 0);

      if (!window.state.remainingCounts) {
          window.state.remainingCounts = {};
      }

      let remainingCount;
      if (Number.isFinite(matchedIndex)) {
          remainingCount = Math.max(0, totalTracks - matchedIndex - 1);
      } else if (window.state.remainingCounts.hasOwnProperty(directionKey)) {
          remainingCount = Math.max(0, Number(window.state.remainingCounts[directionKey]));
      } else if (window.state.stackIndex && directionKey === window.state.latestExplorerData?.nextTrack?.directionKey) {
          const idx = Number(window.state.stackIndex);
          remainingCount = Math.max(0, totalTracks - idx - 1);
      } else {
          remainingCount = Math.max(0, totalTracks - 1);
      }

      window.state.remainingCounts[directionKey] = remainingCount;

      if (!Number.isFinite(matchedIndex)) {
          const stored = window.state?.remainingCounts ? window.state.remainingCounts[directionKey] : undefined;
          if (stored !== undefined && stored !== null) {
              remainingCount = Math.max(0, Number(stored));
          }
      }

      if (!window.state.remainingCounts) {
          window.state.remainingCounts = {};
      }
      window.state.remainingCounts[directionKey] = remainingCount;
      const fallbackIndex = Math.max(0, totalTracks - remainingCount - 1);
      nextTrackCard.dataset.trackIndex = String(Number.isFinite(matchedIndex) ? matchedIndex : fallbackIndex);
      nextTrackCard.dataset.totalTracks = String(totalTracks);

      console.log(`💿 Stack indicator: ${direction.key}, tracks=${tracksToCount.length}, remaining=${remainingCount}`);

      const existingMetrics = nextTrackCard.querySelector('.track-metrics');
      if (existingMetrics) {
          existingMetrics.remove();
      }

      if (remainingCount > 0) {
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
              currentHeight = currentHeight * 0.75;
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

      const createMetric = (label, value) => {
          const container = document.createElement('div');
          container.className = 'metric-chip';
          container.innerHTML = `<span class="metric-label">${label}</span><span class="metric-value">${value}</span>`;
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
          if (!identifier || !window.state?.latestExplorerData) return null;
          const directions = window.state.latestExplorerData.directions || {};
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
          if (!identifier || !window.state?.latestExplorerData) return null;
          const directions = window.state.latestExplorerData.directions || {};
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
          metricsContainer.appendChild(createMetric('next', formatMetric(candidateValue)));
      }

      if (window.debugNextTrackMetrics.current) {
          metricsContainer.appendChild(createMetric('curr', formatMetric(currentValue)));
      }

      if (window.debugNextTrackMetrics.delta) {
          const diff = (candidateValue !== undefined && currentValue !== undefined)
              ? Number(candidateValue) - Number(currentValue)
              : undefined;
          metricsContainer.appendChild(createMetric(' Δ ', formatDelta(diff)));
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
                  metricsContainer.appendChild(createMetric(label, valueText));
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
                      metricsContainer.appendChild(createMetric(key, formatDelta(delta)));
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

      const collectChips = typeof window.collectBeetsChips === 'function'
          ? window.collectBeetsChips
          : null;

      if (collectChips) {
          const trackData = candidateTrack && (candidateTrack.track || candidateTrack);
          if (trackData) {
              const beetsMeta = trackData.beetsMeta || trackData.beets || null;
              const beetsChips = Array.isArray(beetsMeta)
                  ? beetsMeta
                  : (beetsMeta ? collectChips(beetsMeta) : []);

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

  // Hide the stack size indicator
  function hideStackSizeIndicator() {
      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
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
          if (directionData && typeof updateStackSizeIndicator === 'function') {
              updateStackSizeIndicator(directionData, centerCard, nextIndex);
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

      // Add stacking classes based on total track count in this direction
      if (totalTracks > 1) {
          cardClasses += ' stacked';
      }
      if (totalTracks >= 3) {
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
      card.dataset.trackMd5 = track.identifier;
      card.dataset.trackIndex = trackIndex;
      card.dataset.totalTracks = totalTracks;

      // Position next track cards at CENTER of screen
      const centerX = 50; // Dead center horizontally
      const centerY = 45; // Slightly above center to balance with UI

      // For multiple tracks in stack, use small offset for stacking
      const angle = (positionIndex / totalDimensions) * Math.PI * 2 - Math.PI / 2;
      const radiusX = 8; // Small offset for stacked cards
      const radiusY = 5; // Minimal vertical offset
      const baseX = centerX + radiusX * Math.cos(angle);
      const baseY = centerY + radiusY * Math.sin(angle);

      // Stack cards: selected track in front, others behind and to the right
      const offsetX = isSelected ? 0 : (trackIndex - 0) * 2; // 2% offset per card behind
      const offsetY = isSelected ? 0 : -10; // Move back cards up by 10% to be halfway closer to top edge
      const offsetZ = isSelected ? -1000 : -2500 - (trackIndex * 250); // Even further back for less crowding
      const scale = isSelected ? 0.85 : 0.3; // Smaller cards overall to reduce crowding
      const zIndex = isSelected ? 100 : (200 - trackIndex); // Higher z-index for back cards to ensure clickability

      card.style.left = `${baseX + offsetX}%`;
      card.style.top = `${baseY + offsetY}%`;
      // Use 2D transforms instead of 3D for better performance
      card.style.transform = `translate(-50%, -50%) scale(${scale})`;
      card.style.zIndex = zIndex;
      card.style.position = 'absolute';
      card.style.willChange = 'transform, opacity';

      // Use same color as parent dimension for consistency
      const directionType = getDirectionType(direction.key);
      const colorVariant = variantFromDirectionType(directionType);


      // Track details
      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);

      const explorerDirections = state.latestExplorerData?.directions || {};
      const oppositeKey = getOppositeDirection(direction.key);
      const hasOpposite =
          direction.hasOpposite === true ||
          !!direction.oppositeDirection ||
          (oppositeKey ? !!explorerDirections[oppositeKey] : false) ||
          Object.values(explorerDirections).some(dir => dir.oppositeDirection?.key === direction.key);
      const unoReverseHtml = hasOpposite && isSelected ? `
          <div class="uno-reverse enabled">^</div>
      ` : '';

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <span class="rim"></span>
              ${unoReverseHtml}
              <div class="label">
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${track.album || ''}</h5>
                  <p>${duration} · FLAC</p>
              </div>
          </div>
      `;

      // Click handler - cycle through tracks in this direction
      card.addEventListener('click', (e) => {
          // Check if clicking on the reverse icon - if so, don't cycle
          if (e.target.closest('.uno-reverse')) {
              console.log(`🔄 Clicked on reverse icon, ignoring card click`);
              return; // Let the reverse icon handle its own behavior
          }

          console.log(`🔄 Cycling stack for dimension: ${direction.key} from track index ${state.stackIndex}`);
          cycleStackContents(direction.key, state.stackIndex);
      });

      // Add click handler for Uno Reverse symbol if present
      if (hasOpposite && isSelected) {
          const unoReverse = card.querySelector('.uno-reverse');
          if (unoReverse) {
              unoReverse.addEventListener('click', (e) => {
                  e.stopPropagation(); // Prevent card click
                  console.log(`🔄 Swapping stack contents from ${direction.key} to opposite`);

                  const currentDirection = state.latestExplorerData.directions[direction.key];
                  if (currentDirection && currentDirection.oppositeDirection) {
                      // Temporarily add the opposite direction to SSE data for swapping
                      const oppositeKey = getOppositeDirection(direction.key);
                      if (oppositeKey) {
                          state.latestExplorerData.directions[oppositeKey] = {
                              ...currentDirection.oppositeDirection,
                              hasOpposite: true,
                              key: oppositeKey
                          };

                          // Swap stack contents immediately without animation
                          swapFn(direction.key, oppositeKey);
                      }
                  } else {
                      console.warn(`Opposite direction not available for ${direction.key}`);
                  }
              });
          }
      }

      return card;
  }

  function redrawDimensionCardsWithNewNext(newNextDirectionKey) {
      if (!state.latestExplorerData) return;

      // Update the stored explorer data to track the new next direction
      const stack = state.latestExplorerData.directions[newNextDirectionKey];
      state.latestExplorerData.nextTrack = {
          directionKey: newNextDirectionKey,
          direction:    stack.direction,
          track:        stack.sampleTracks[0]
      };

      // Remove ALL existing track detail cards (both old next track stacks and any other detail cards)
      document.querySelectorAll('.track-detail-card').forEach(card => card.remove());

      // Recreate the card stack for the new next direction immediately
      const container = document.getElementById('dimensionCards');
      const directions = Object.entries(state.latestExplorerData.directions).map(([key, directionInfo]) => ({
          key: key,
          name: directionInfo.direction || key,
          trackCount: directionInfo.trackCount,
          description: directionInfo.description,
          diversityScore: directionInfo.diversityScore,
          sampleTracks: directionInfo.sampleTracks || []
      }));

      const swapFn = typeof window.swapStackContents === 'function' ? window.swapStackContents : () => {};

      const targetDimension = directions.find(d => d.key === newNextDirectionKey);
      if (targetDimension) {
          const dimensionIndex = directions.findIndex(d => d.key === newNextDirectionKey);
          // Create immediately without animation delay
          const sampleTracks = (targetDimension.sampleTracks || []).map(entry => entry.track || entry);
          if (sampleTracks.length === 0) {
              console.warn(`🔄 redrawDimensionCardsWithNewNext: no sample tracks for ${newNextDirectionKey}`);
              return;
          }

          // Use global selection state, default to first track if none selected
          const selectedTrackIndex = state.selectedIdentifier
              ? sampleTracks.findIndex(trackObj => trackObj.identifier === state.selectedIdentifier)
              : 0;
          const finalSelectedTrackIndex = selectedTrackIndex >= 0 ? selectedTrackIndex : 0;
          const selectedTrack = sampleTracks[finalSelectedTrackIndex] || sampleTracks[0];

          // Update global selection bookkeeping for future stack cycles
          state.stackIndex = finalSelectedTrackIndex;
          state.selectedIdentifier = selectedTrack?.identifier || state.selectedIdentifier;
          if (!state.remainingCounts) {
              state.remainingCounts = {};
          }
          state.remainingCounts[newNextDirectionKey] = Math.max(0, sampleTracks.length - finalSelectedTrackIndex - 1);

          // Prefer reusing an existing next-track card if one is already mounted
          const existingCard = document.querySelector('.dimension-card.next-track');
          if (existingCard) {
              // Remove any stray duplicates of the next-track card
              const duplicates = document.querySelectorAll('.dimension-card.next-track');
              duplicates.forEach((dup, idx) => {
                  if (dup !== existingCard) {
                      dup.remove();
                  }
              });

              existingCard.classList.add('next-track');
              existingCard.classList.remove('animating-to-center');
              existingCard.dataset.directionKey = newNextDirectionKey;
              existingCard.dataset.trackMd5 = selectedTrack?.identifier || '';
              existingCard.dataset.clockPosition = existingCard.dataset.clockPosition || '6';
              existingCard.style.left = '50%';
              existingCard.style.top = '45%';
              existingCard.style.transform = 'translate(-50%, -40%) translateZ(-400px) scale(1.0)';
              existingCard.style.zIndex = '100';

              updateCardWithTrackDetails(existingCard, selectedTrack, {
                  ...targetDimension,
                  key: newNextDirectionKey,
                  sampleTracks
              }, true, swapFn);

              existingCard.dataset.trackIndex = String(finalSelectedTrackIndex);
              existingCard.dataset.totalTracks = String(sampleTracks.length);

              const directionData = state.latestExplorerData?.directions?.[newNextDirectionKey];
              if (directionData && typeof updateStackSizeIndicator === 'function') {
                  updateStackSizeIndicator(directionData, existingCard, finalSelectedTrackIndex);
              }

              return;
          }

          const card = createTrackDetailCard(
              targetDimension,
              selectedTrack,
              dimensionIndex,
              directions.length,
              true,
              finalSelectedTrackIndex,
              sampleTracks.length,
              swapFn
          );
          card.classList.add('next-track');
          card.style.left = '50%';
          card.style.top = '45%';
          card.style.transform = 'translate(-50%, -40%) translateZ(-400px) scale(1.0)';
          card.style.zIndex = '100';

          container.appendChild(card);
          card.dataset.trackIndex = String(finalSelectedTrackIndex);
          card.dataset.totalTracks = String(sampleTracks.length);

          const directionData = state.latestExplorerData?.directions?.[newNextDirectionKey];
          if (directionData && typeof updateStackSizeIndicator === 'function') {
              updateStackSizeIndicator(directionData, card, finalSelectedTrackIndex);
          }

          requestAnimationFrame(() => {
              card.classList.add('visible');
          });
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
      const swapFn = typeof window.swapStackContents === 'function' ? window.swapStackContents : () => {};
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
      text1.textContent = JSON.stringify(trackPayload, null, 2);
      console.dir({got: text1.textContent, from: trackPayload});
      text2.textContent = JSON.stringify(metadata2, null, 2);
      console.dir({got: text2.textContent, from: metadata2});

      helpersColorLog(`🎨 JSON metadata overlay updated for: ${direction.key}`);
  }


  // Update card content with track details
  function updateCardWithTrackDetails(card, track, direction, preserveColors = false, swapStackContents) {
      const swapFn = typeof swapStackContents === 'function' ? swapStackContents : (a, b) => {};
      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);

      const explorerDirections = state.latestExplorerData?.directions || {};
      const oppositeKey = getOppositeDirection(direction.key);
      const hasOpposite =
          direction.hasOpposite === true ||
          !!direction.oppositeDirection ||
          (oppositeKey ? !!explorerDirections[oppositeKey] : false) ||
          Object.values(explorerDirections).some(dir => dir.oppositeDirection?.key === direction.key);

      // 🎯 DEBUG: Detailed reverse icon availability check
      const directionData = state.latestExplorerData.directions[direction.key];
      const oppositeExists = oppositeKey && state.latestExplorerData.directions[oppositeKey];

      const unoReverseHtml = hasOpposite ? `
          <div class="uno-reverse next-track-reverse enabled"></div>
      ` : '';
      console.log(`🔄 Generated unoReverseHtml:`, unoReverseHtml.trim());

      // Always define directionType for later use
      const directionType = getDirectionType(direction.key);
      card.dataset.directionType = directionType;
      const intrinsicNegative = isNegativeDirection(direction.key);

      const sampleTracks = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
      const currentIndex = sampleTracks.findIndex(sample => {
          const candidate = sample?.track || sample;
          return candidate?.identifier === track.identifier;
      });

      if (track.identifier) {
          card.dataset.trackMd5 = track.identifier;
      }
      card.dataset.trackIndex = currentIndex >= 0 ? currentIndex : 0;

      let borderColor, glowColor;

      if (preserveColors) {
          // When preserving colors (e.g., card promotion to center), use existing CSS custom properties
          helpersColorLog(`🎨 PRESERVE: Keeping existing colors for ${direction.key}`);
          const computedStyle = getComputedStyle(card);
          borderColor = computedStyle.getPropertyValue('--border-color').trim() ||
                       card.style.getPropertyValue('--border-color').trim();
          glowColor = computedStyle.getPropertyValue('--glow-color').trim() ||
                     card.style.getPropertyValue('--glow-color').trim();

          // Fallback: if no existing colors, calculate fresh ones
          if (!borderColor || !glowColor) {
              helpersColorLog(`🎨 PRESERVE FALLBACK: No existing colors found, calculating fresh ones`);
              const freshColors = getDirectionColor(directionType, direction.key);
              borderColor = borderColor || freshColors.border;
              glowColor = glowColor || freshColors.glow;
          }
      } else {
          // SIMPLIFIED COLOR CALCULATION: Always calculate fresh colors from dimension

          if (state.usingOppositeDirection) {
              // In reverse mode, get analogous complementary colors for the current dimension
              helpersColorLog(`🎨 REVERSE: Calculating reverse colors for ${direction.key} (${directionType})`);
              const reverseColors = getDirectionColor(directionType, direction.key + '_force_negative');
              borderColor = reverseColors.border;
              glowColor = reverseColors.glow;
          } else {
              // Normal mode: get primary colors for the current dimension
              helpersColorLog(`🎨 NORMAL: Calculating primary colors for ${direction.key} (${directionType})`);
              const primaryColors = getDirectionColor(directionType, direction.key + '_force_primary');
              borderColor = primaryColors.border;
              glowColor = primaryColors.glow;
          }
      }

      // Apply the final colors
      card.style.setProperty('--border-color', borderColor);
      card.style.setProperty('--glow-color', glowColor);

      // ALSO update the data attributes to match
      card.dataset.borderColor = borderColor;
      card.dataset.glowColor = glowColor;

      const computeRimBackground = () => {
          if (intrinsicNegative) {
              return `conic-gradient(from 180deg, ${glowColor}, ${borderColor}, ${glowColor})`;
          }
          return `conic-gradient(${borderColor}, ${glowColor}, ${borderColor})`;
      };

      const applyRimBackground = (rimEl) => {
          if (!rimEl) return;
          const rimStyle = computeRimBackground();
          rimEl.style.background = rimStyle;
      };

      applyRimBackground(card.querySelector('.rim'));

      // Preserve existing panel classes (color variants)
      const existingPanel = card.querySelector('.panel');
      let panelClasses = 'panel';
      if (existingPanel) {
          panelClasses = existingPanel.className;
      } else {
          // Generate panel class from direction type if no existing panel
          const variantClass = variantFromDirectionType(directionType);
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
              ${unoReverseHtml}
          </div>
      `;

      card.innerHTML = newHTML;

      const shouldUseNegativeMask = intrinsicNegative;
      card.classList.toggle('negative-direction', shouldUseNegativeMask);

      applyRimBackground(card.querySelector('.rim'));

      // Add click handler for Uno Reverse if present
      if (hasOpposite) {
          const unoReverse = card.querySelector('.uno-reverse.next-track-reverse');

          // Set reversed icon state and rim direction
          if (unoReverse) {
              unoReverse.classList.toggle('reversed', state.usingOppositeDirection);
              unoReverse.addEventListener('click', (e) => {
                  e.stopPropagation();
                  console.log(`🔄 Reverse icon clicked for ${direction.key}`);

                  const oppositeKey = getOppositeDirection(direction.key);
                  console.log(`🔄 Opposite key found: ${oppositeKey}`);
                  if (oppositeKey) {
                      console.log(`🔄 About to call swapStackContents(${direction.key}, ${oppositeKey})`);
                      swapFn(direction.key, oppositeKey);
                  } else {
                      console.warn(`No opposite direction found for ${direction.key}`);
                  }
              });
          }


      }

      // Ensure card's data-direction-key matches the actual direction being displayed
      card.dataset.directionKey = direction.key;
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
          updateStackSizeIndicator(direction, card, stackIndex >= 0 ? stackIndex : undefined);
          updateDirectionKeyOverlay(direction, track);
      } else {
          // Hide indicator if not a next track stack
          hideStackSizeIndicator();
          hideDirectionKeyOverlay();
      }
  }
