  // Global state like it's 1989!
const state = {
    latestExplorerData: null,
    latestCurrentTrack: null,
    previousNextTrack: null,
    usingOppositeDirection: false,
    journeyMode: true,
    selectedIdentifier: null,
    stackIndex: 0,
    forceLayout: null,
    isStarted: false,
    progressAnimation: null,
    heartbeatTimeout: null,
    renderer: null,
    camera: null,
    scene: null,
    baseDirectionKey: null,
    streamUrl: '/stream',
    eventsEndpoint: '/events',
    streamUrlBase: '/stream',
    eventsEndpointBase: '/events',
    currentResolution: 'magnifying',
    manualNextTrackOverride: false,
    nextTrackAnimationTimer: null,
    manualNextDirectionKey: null,
    playbackStartTimestamp: null,
    playbackDurationSeconds: 0,
    lastTrackUpdateTs: 0,
    pendingInitialTrackTimer: null,
    pendingResyncCheckTimer: null,
    pendingAudioConfirmTimer: null,
    creatingNewSession: false,
    remainingCounts: {}
  };
window.state = state;

(function hydrateStateFromLocation() {
  state.streamUrlBase = '/stream';
  state.eventsEndpointBase = '/events';
  state.streamUrl = state.streamUrlBase;
  state.eventsEndpoint = state.eventsEndpointBase;
  window.streamUrl = state.streamUrl;
  window.eventsUrl = state.eventsEndpoint;
})();

const RADIUS_MODES = ['microscope', 'magnifying', 'binoculars'];

function explorerContainsTrack(explorerData, identifier) {
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

function normalizeResolution(resolution) {
  if (!resolution) return null;
  const value = resolution.toLowerCase();
  if (value === 'magnifying_glass' || value === 'magnifying') {
    return 'magnifying';
  }
  if (value === 'microscope' || value === 'binoculars') {
    return value;
  }
  return value;
}

function composeStreamEndpoint(sessionId, cacheBust = false) {
  const base = state.streamUrlBase || '/stream';
  const params = [];
  if (sessionId) {
    params.push(`session=${encodeURIComponent(sessionId)}`);
  }
  if (cacheBust !== false) {
    const value = cacheBust === true ? Date.now() : cacheBust;
    params.push(`t=${value}`);
  }
  if (!params.length) {
    return base;
  }
  return `${base}?${params.join('&')}`;
}

function composeEventsEndpoint(sessionId) {
  const base = state.eventsEndpointBase || '/events';
  if (!sessionId) {
    return base;
  }
  return `${base}?session=${encodeURIComponent(sessionId)}`;
}

function syncStreamEndpoint(sessionId, { cacheBust = false } = {}) {
  const url = composeStreamEndpoint(sessionId, cacheBust);
  state.streamUrl = url;
  window.streamUrl = url;
  return url;
}

function syncEventsEndpoint(sessionId) {
  const url = composeEventsEndpoint(sessionId);
  state.eventsEndpoint = url;
  window.eventsUrl = url;
  return url;
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

initializeApp();

function initializeApp() {

  // ====== Audio Streaming Setup ======

  console.log('🆔 Using cookie-managed audio session');

  // Connection health management
  const connectionHealth = {
    sse: {
      status: 'connecting',
      lastMessage: Date.now(),
      reconnectAttempts: 0,
      reconnectDelay: 2000,
      maxReconnectDelay: 30000,
      stuckTimeout: null,
    },
    audio: {
      status: 'connecting',
      reconnectAttempts: 0,
      reconnectDelay: 2000,
      maxReconnectDelay: 30000,
      maxAttempts: 10,
    },
    currentEventSource: null,
  };

  // Update connection health UI
  function updateConnectionHealthUI() {
    const healthIndicator = document.getElementById('connectionHealth');
    const sseStatus = document.getElementById('sseStatus');
    const audioStatus = document.getElementById('audioStatus');

    if (!healthIndicator) return;

    // Update status text
    if (sseStatus) sseStatus.textContent = connectionHealth.sse.status;
    if (audioStatus) audioStatus.textContent = connectionHealth.audio.status;

    // Determine overall health
    const sseOk = connectionHealth.sse.status === 'connected';
    const audioOk = connectionHealth.audio.status === 'connected';

    healthIndicator.classList.remove('healthy', 'degraded', 'error');

    if (sseOk && audioOk) {
      healthIndicator.classList.add('healthy');
    } else if (sseOk || audioOk) {
      healthIndicator.classList.add('degraded');
    } else {
      healthIndicator.classList.add('error');
    }
  }

  const LOCKOUT_THRESHOLD_SECONDS = 30;

  const elements = {
	  clickCatcher:        document.getElementById('clickCatcher'),
          volumeControl:       document.getElementById('volumeControl'),
          volumeBar:           document.getElementById('volumeBar'),
          fullscreenProgress:  document.getElementById('fullscreenProgress'),
	  progressWipe:        document.getElementById('progressWipe'),
          audio:               document.getElementById('audio'),
          playbackClock:       document.getElementById('playbackClock')
  }
  elements.audio.volume = 0.85;


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

      // Randomly assign panel color variant
      const panel = document.querySelector('#nowPlayingCard .panel');
      const variants = ['red-variant', 'green-variant', 'yellow-variant', 'blue-variant'];
      // Remove existing variants
      variants.forEach(v => panel.classList.remove(v));

      // Add random variant
      panel.classList.add(
		  state.previousNextTrack?.identifier === trackData.identifier
		  ? state.previousNextTrack?.variant
		  : variants[Math.floor(Math.random() * variants.length)]
      );

      const isNegativeDirection = Boolean(currentDirectionKey && currentDirectionKey.includes('_negative'));
      const nowPlayingRoot = document.getElementById('nowPlayingCard');
      if (nowPlayingRoot) {
          nowPlayingRoot.classList.toggle('negative-direction', isNegativeDirection);
      }
      if (panel) {
          panel.classList.toggle('negative-direction', isNegativeDirection);
      }

      // Show card with zoom-in animation
      const card = document.getElementById('nowPlayingCard');
      card.classList.add('visible');
  }



var cache = document.createElement("CACHE");
cache.style = "position:absolute;z-index:-1000;opacity:0;";
document.body.appendChild(cache);
function preloadImage(url) {
    var img = new Image();
    img.src = url;
    img.style = "position:absolute";
    cache.appendChild(img);
}

function createDimensionCards(explorerData, options = {}) {
      const skipExitAnimation = options.skipExitAnimation === true;
      const normalizeTracks = (direction) => {
          if (!direction || !Array.isArray(direction.sampleTracks)) return;
          direction.sampleTracks = direction.sampleTracks.map(entry => entry.track || entry);
          if (direction.oppositeDirection) {
              normalizeTracks(direction.oppositeDirection);
          }
      };

      const previousExplorerData = state.latestExplorerData;
      // Store for later redraw
      const previousNext = previousExplorerData?.nextTrack;
      const previousNextId = previousNext?.track?.identifier || previousNext?.identifier || null;
      const incomingNextId = explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null;

      if (previousNext && previousNextId && incomingNextId && incomingNextId !== previousNextId) {
          state.previousNextTrack = {
	      identifier: previousNextId,
	      albumCover: previousNext.albumCover,
              variant: variantFromDirectionType(getDirectionType(previousNext.directionKey))
          };
      }
      state.latestExplorerData = explorerData;
      state.remainingCounts = {};

      Object.values(explorerData.directions || {}).forEach(normalizeTracks);

      // Run comprehensive duplicate analysis on new data
      performDuplicateAnalysis(explorerData, "createDimensionCards");

      const container = document.getElementById('dimensionCards');
      console.log('🎯 Container element:', container);

      if (!container) {
          console.error('❌ NO CONTAINER ELEMENT FOUND!');
          return;
      }

      const nextTrackId = explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null;
      const selectionStillPresent = state.selectedIdentifier ? explorerContainsTrack(explorerData, state.selectedIdentifier) : false;
      const currentTrackUnchanged = explorerData.currentTrack?.identifier === state.latestCurrentTrack?.identifier;
      const manualOverrideHydrated = Boolean(state.manualNextTrackOverride && currentTrackUnchanged && selectionStillPresent);
      const manualOverridePending = Boolean(state.manualNextTrackOverride && currentTrackUnchanged && !selectionStillPresent);

      const overridePinnedButMissing = Boolean(
          state.manualNextTrackOverride &&
          state.selectedIdentifier &&
          !selectionStillPresent &&
          !currentTrackUnchanged
      );

      if (overridePinnedButMissing) {
          console.error('🛰️ ACTION pinned-track-missing', {
              pinnedTrack: state.selectedIdentifier,
              availableDirections: Object.keys(explorerData.directions || {}),
              nextTrackFromServer: explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null
          });

          state.manualNextTrackOverride = false;
          state.manualNextDirectionKey = null;

          const fallbackIdentifier = explorerData.nextTrack?.track?.identifier || explorerData.nextTrack?.identifier || null;
          state.selectedIdentifier = fallbackIdentifier;
      }

      if (manualOverridePending) {
          console.log('🎯 Manual override pending hydration; deferring explorer refresh');
          if (state.nextTrackAnimationTimer) {
              clearTimeout(state.nextTrackAnimationTimer);
              state.nextTrackAnimationTimer = null;
          }
          state.usingOppositeDirection = false;
          return;
      }

      const manualOverrideActive = manualOverrideHydrated;

      if (manualOverrideActive && previousNext && previousNextId) {
          console.log('🎯 Manual override active; preserving prior next-track payload for heartbeat sync');
          explorerData.nextTrack = previousNext;
          state.latestExplorerData = explorerData;
      }

      if (manualOverrideActive) {
          console.log('🎯 Manual next track override active; preserving existing cards (selection still present)');
          if (state.nextTrackAnimationTimer) {
              clearTimeout(state.nextTrackAnimationTimer);
              state.nextTrackAnimationTimer = null;
          }
          state.usingOppositeDirection = false;
          return;
      }

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

      console.log(`🎯 RECEIVED ${directionCount} directions from server:`, Object.keys(explorerData.directions));

      console.log('🎯 CREATING CARDS from explorer data:', explorerData);

      // Don't auto-select globally - let each direction use its own first track by default
      // This prevents the bug where all cards try to use the same track from the first direction
      console.log(`🎯 Not setting global selectedIdentifier - each direction will use its own first track`);

      // Smart filtering: max 11 regular directions + outliers, or 12 if no outliers
      console.log(`🔍 Raw explorerData.directions:`, explorerData.directions);

      let allDirections = Object.entries(explorerData.directions).map(([key, directionInfo]) => {
          console.log(`🔍 Processing direction: ${key}`, directionInfo);
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

      console.log(`🔍 All directions mapped:`, allDirections);

      // ✅ Server now prioritizes larger stacks as primary, smaller as oppositeDirection

      // Separate outliers from regular directions
      const outlierDirections = allDirections.filter(d =>
          d.key.includes('outlier') ||
          d.key.includes('unknown') ||
          getDirectionType(d.key) === 'outlier'
      );
      const regularDirections = allDirections.filter(d => !outlierDirections.includes(d));

      console.log(`🎯 Found ${regularDirections.length} regular directions, ${outlierDirections.length} outliers`);

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

      console.log(`🎯 Using ${directions.length} total directions: ${directions.length - outlierDirections.length} regular + ${outlierDirections.length} outliers`);

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
              console.log(`🌟 Added ${outliersToAdd.length} legacy outlier directions (${outlierSpaceAvailable} slots available)`);
          }
      }

      // Server now handles bidirectional prioritization - just trust the hasOpposite flag
      const bidirectionalDirections = directions.filter(direction => direction.hasOpposite);
      console.log(`🔄 Server provided ${bidirectionalDirections.length} directions with reverse capability`);
      console.log(`🔄 Directions with opposites:`, bidirectionalDirections.map(d => `${d.key} (${d.sampleTracks?.length || 0} tracks)`));

      // Find the next track direction from explorer data
      const nextTrackDirection = explorerData.nextTrack ? explorerData.nextTrack.directionKey : null;

      console.log(`🎯 About to create ${directions.length} cards - drawing order: bottom first, next track last`);
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
          for (t in tracks) preloadImage(t.albumCover);

          console.log(`🎯 Creating direction card ${index}: ${direction.key} (${trackCount} tracks)${hasReverse ? ' with reverse' : ''}`);
          if (hasReverse) {
              const oppositeTracks = direction.oppositeDirection?.sampleTracks || [];
              const oppositeCount = oppositeTracks.length;
              for (t in oppositeTracks) preloadImage(t.albumCover);
              console.log(`🔄 Reverse available: ${oppositeCount} tracks in opposite direction`);
          }

          // All start as direction cards in clock positions (no special next-track handling yet)
          console.log(`Create direction card ${index}`);
          let card;
          try {
              card = createDirectionCard(direction, index, directions.length, false, null, hasReverse, null, directions);
              console.log(`✅ Created card for ${direction.key}, appending to container`);
              container.appendChild(card);
              cardsCreated++;
              console.log(`✅ Successfully added card ${index} (${direction.key}) to DOM, total cards: ${cardsCreated}`);

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
              console.log(`🎯 Animating ${explorerData.nextTrack.directionKey} to center as next track`);
              animateDirectionToCenter(explorerData.nextTrack.directionKey);
          }
          state.nextTrackAnimationTimer = null;
      }, directions.length * 150 + 1500); // Wait for all cards to appear

      console.log(`🎯 FINISHED creating ${cardsCreated} cards in container`);

      // 🐞 DEBUG: Count cards by type in the DOM
      const allCards = container.querySelectorAll('.dimension-card');
      const nextTrackCards = container.querySelectorAll('.dimension-card.next-track');
      const regularCards = container.querySelectorAll('.dimension-card:not(.next-track)');
      const trackDetailCards = container.querySelectorAll('.track-detail-card');

      console.log(`🐞 DOM CARDS SUMMARY:`);
      console.log(`🐞   Total cards in DOM: ${allCards.length}`);
      console.log(`🐞   Next track cards: ${nextTrackCards.length}`);
      console.log(`🐞   Regular direction cards: ${regularCards.length}`);
      console.log(`🐞   Track detail cards: ${trackDetailCards.length}`);

      // 🐞 DEBUG: Show what text content is actually visible
      allCards.forEach((card, index) => {
          const labelDiv = card.querySelector('.label');
          const text = labelDiv ? labelDiv.textContent.trim() : 'NO LABEL';
          const isNextTrack = card.classList.contains('next-track');
          const isTrackDetail = card.classList.contains('track-detail-card');
          console.log(`🐞   Card ${index}: ${isNextTrack ? '[NEXT]' : '[REG]'} ${isTrackDetail ? '[TRACK]' : '[DIR]'} "${text.substring(0, 50)}..."`);
      });

      // Apply initial selection state to show stacked cards immediately
      setTimeout(() => {
          refreshCardsWithNewSelection();
      }, 100);
  }


  // Swap the roles: make a direction the new next track stack, demote current next track to regular direction
  function swapNextTrackDirection(newNextDirectionKey) {
      if (!state.latestExplorerData || !state.latestExplorerData.directions[newNextDirectionKey]) {
          console.error('Cannot swap to direction:', newNextDirectionKey);
          return;
      }

      console.log(`🔄 Swapping next track direction from ${state.latestExplorerData.nextTrack?.directionKey} to ${newNextDirectionKey}`);

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

      // Find the selected card first
      const allTrackCards = document.querySelectorAll('.dimension-card.track-detail-card.next-track');
      if (allTrackCards.length === 0) {
          console.warn(`${ICON} ACTION selection-cards-unavailable`, {
              selection: state.selectedIdentifier,
              reason: 'no next-track cards rendered'
          });
          return;
      }
      let selectedCard = null;
      let selectedDimensionKey = null;

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
          const trackIndex = parseInt(card.dataset.trackIndex) || 0;
          const isSelectedCard = (cardTrackMd5 === state.selectedIdentifier);
          const isSameDimension = (directionKey === selectedDimensionKey);

          // Find the track data for this card
          const direction = state.latestExplorerData.directions[directionKey];
          const track = direction && direction.sampleTracks ?
              (direction.sampleTracks[trackIndex]?.track || direction.sampleTracks[trackIndex]) : null;
          if (!track) return;

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

              // Show full track details
              const direction = state.latestExplorerData?.directions?.[directionKey];
              const directionName = direction?.isOutlier ? "Outlier" : formatDirectionName(directionKey);
              const duration = formatTrackTime(track.duration);
              labelDiv.innerHTML = `
                  <h2>${directionName}</h2>
                  <h3>${getDisplayTitle(track)}</h3>
                  <h4>${track.artist || 'Unknown Artist'}</h4>
                  <h5>${track.album || ''}</h5>
                  <p>${duration} · FLAC</p>
              `;

              // Update stacked card colors based on other tracks in this direction
              updateStackedCardColors(card, directionKey);
          } else if (isSameDimension) {
              // Hide other cards from same dimension (they're behind the selected one)
              card.style.opacity = '0';
          } else {
              // Cards from other dimensions remain unchanged
              card.classList.remove('selected');
              labelDiv.innerHTML = `<div class="dimension-label">${directionName}</div>`;
          }
      });
  }

  // ====== Audio Controls ======
  function startAudio() {
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

      // Set audio source and start playing
      console.log(`🎵 Setting audio source to: ${state.streamUrl}`);
      if (state.streamUrl) {
          elements.audio.src = state.streamUrl;
      }

      // Add error event listeners for better diagnostics
      elements.audio.onerror = function(e) {
          console.error('🎵 Audio error event:', e);

          const mediaError = elements.audio.error;
          let errorType = 'Unknown';
          let errorMessage = 'Unknown media error';

          if (mediaError) {
              switch (mediaError.code) {
                  case MediaError.MEDIA_ERR_ABORTED:
                      errorType = 'MEDIA_ERR_ABORTED';
                      errorMessage = 'Audio loading was aborted by user';
                      break;
                  case MediaError.MEDIA_ERR_NETWORK:
                      errorType = 'MEDIA_ERR_NETWORK';
                      errorMessage = 'Network error while loading audio';
                      break;
                  case MediaError.MEDIA_ERR_DECODE:
                      errorType = 'MEDIA_ERR_DECODE';
                      errorMessage = 'Audio decoding error';
                      break;
                  case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                      errorType = 'MEDIA_ERR_SRC_NOT_SUPPORTED';
                      errorMessage = 'Audio format not supported';
                      break;
              }
          }

          console.error('🎵 Audio error details:', {
              errorType,
              errorMessage,
              errorCode: mediaError?.code,
              mediaError,
              networkState: elements.audio.networkState,
              readyState: elements.audio.readyState,
              src: elements.audio.src,
              currentTime: elements.audio.currentTime,
              duration: elements.audio.duration
          });

          // Check if server is reachable
          checkStreamEndpoint();
      };

      elements.audio.onloadstart = () => console.log('🎵 Load started');
      elements.audio.oncanplay = () => console.log('🎵 Can play');
      elements.audio.oncanplaythrough = () => console.log('🎵 Can play through');

      elements.audio.src = state.streamUrl;
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
          // Keep interface visible even if audio fails
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
            state.selectedIdentifier = null;
            state.stackIndex = 0;
            console.warn('🛰️ ACTION initial-track-missing: no SSE track after 10s, requesting refresh');
            fullResync();
        }
      }, 10000);
  });


  // ====== Inactivity Management ======
  let inactivityTimer = null;
  let lastActivityTime = Date.now();
  let cardsInactiveTilted = false; // Track if cards are already tilted from inactivity
  let midpointReached = false; // Track if we've hit the lockout threshold
  let cardsLocked = false; // Track if card interactions are locked

  function markActivity() {
      lastActivityTime = Date.now();

      // Only respond to activity if we're in the first half and cards aren't locked
      if (midpointReached || cardsLocked) {
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

  // ====== Progress Bar Functions ======

  function startProgressAnimation(durationSeconds) {
      startProgressAnimationFromPosition(durationSeconds, 0);
  }

  function renderProgressBar(progressFraction) {
      const clamped = Math.min(Math.max(progressFraction, 0), 1);
      const background = document.getElementById('background');

      if (clamped <= 0.5) {
          const widthPercent = clamped * 2 * 100; // 0 → 100
          elements.progressWipe.style.left = '0%';
          elements.progressWipe.style.right = 'auto';
          elements.progressWipe.style.width = `${widthPercent}%`;

          if (background) {
              background.style.background = 'linear-gradient(135deg, #235, #403)';
          }
      } else {
          const phase2Progress = (clamped - 0.5) * 2; // 0 → 1
          elements.progressWipe.style.left = `${phase2Progress * 100}%`;
          elements.progressWipe.style.right = 'auto';
          elements.progressWipe.style.width = `${(1 - phase2Progress) * 100}%`;

          if (background) {
              background.style.background = 'linear-gradient(135deg, #235, #453)';
          }
      }
  }

  function formatTimecode(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
          return '--:--';
      }
      const wholeSeconds = Math.floor(seconds);
      const minutes = Math.floor(wholeSeconds / 60);
      const secs = wholeSeconds % 60;
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  function updatePlaybackClockDisplay(forceSeconds = null) {
      if (!elements.playbackClock) return;

      if (!state.playbackStartTimestamp || state.playbackDurationSeconds <= 0) {
          elements.playbackClock.textContent = '--:--';
          return;
      }

      const elapsedSeconds = forceSeconds !== null
          ? forceSeconds
          : Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
      const clampedElapsed = Math.min(elapsedSeconds, state.playbackDurationSeconds);
      elements.playbackClock.textContent = formatTimecode(clampedElapsed);
  }

  function clearPlaybackClock() {
      state.playbackStartTimestamp = null;
      state.playbackDurationSeconds = 0;
      updatePlaybackClockDisplay(null);
  }

  function shouldLockInteractions(elapsedSeconds, totalDuration) {
      if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
          return false;
      }
      const remaining = Math.max(totalDuration - elapsedSeconds, 0);
      return remaining <= LOCKOUT_THRESHOLD_SECONDS;
  }

  function startProgressAnimationFromPosition(durationSeconds, startPositionSeconds = 0, options = {}) {
      const resync = !!options.resync;

      // Clear any existing animation
      if (state.progressAnimation) {
          clearInterval(state.progressAnimation);
      }

      // Reset progress visuals
      elements.progressWipe.style.width = '0%';
      elements.progressWipe.style.left = '0%';
      elements.progressWipe.style.right = 'auto';
      elements.fullscreenProgress.classList.add('active');

      if (!resync) {
          midpointReached = false;
          cardsLocked = false;
          cardsInactiveTilted = false;

          // Unlock cards at start of new track
          unlockCardInteractions();

          // Restart inactivity tracking for new track
          markActivity();
      }

      console.log(`🎬 Starting progress animation for ${durationSeconds}s from position ${startPositionSeconds}s – lockout begins with ${LOCKOUT_THRESHOLD_SECONDS}s remaining`);

      const safeDuration = Math.max(durationSeconds, 0.001);
      const clampedStartPosition = Math.min(Math.max(startPositionSeconds, 0), safeDuration);
      const initialProgress = clampedStartPosition / safeDuration;
      const remainingDuration = Math.max((safeDuration - clampedStartPosition) * 1000, 0); // ms

      state.playbackDurationSeconds = safeDuration;
      state.playbackStartTimestamp = Date.now() - clampedStartPosition * 1000;

      renderProgressBar(initialProgress);
      updatePlaybackClockDisplay(clampedStartPosition);

      const initialShouldLock = shouldLockInteractions(clampedStartPosition, safeDuration);

      if (resync) {
          if (initialShouldLock) {
              if (!midpointReached || !cardsLocked) {
                  triggerMidpointActions();
              }
              midpointReached = true;
              cardsLocked = true;
          } else {
              if (cardsLocked || midpointReached) {
                  unlockCardInteractions();
              }
              midpointReached = false;
              cardsLocked = false;
              cardsInactiveTilted = false;
          }
      } else {
          if (!midpointReached && initialShouldLock) {
              triggerMidpointActions();
              midpointReached = true;
              cardsLocked = true;
          }
      }

      if (remainingDuration <= 0) {
          renderProgressBar(1);
          updatePlaybackClockDisplay(safeDuration);
          return;
      }

      const startTime = Date.now();

      state.progressAnimation = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const elapsedProgress = Math.min(elapsed / remainingDuration, 1);
          const progress = Math.min(initialProgress + elapsedProgress * (1 - initialProgress), 1);

          renderProgressBar(progress);
          updatePlaybackClockDisplay();

          const elapsedSeconds = progress * safeDuration;
          if (!midpointReached && shouldLockInteractions(elapsedSeconds, safeDuration)) {
              triggerMidpointActions();
              midpointReached = true;
              cardsLocked = true;
          }

          if (progress >= 1) {
              clearInterval(state.progressAnimation);
              state.progressAnimation = null;
              updatePlaybackClockDisplay(safeDuration);
          }
      }, 100); // Update every 100ms for smooth animation
  }

  function stopProgressAnimation() {
      if (state.progressAnimation) {
          clearInterval(state.progressAnimation);
          state.progressAnimation = null;
      }
      elements.fullscreenProgress.classList.remove('active');
      elements.progressWipe.style.width = '0%';
      elements.progressWipe.style.left = '0%';
      elements.progressWipe.style.right = 'auto';
      midpointReached = false;
      cardsLocked = false;
      console.log('🛑 Stopped progress animation');
      clearPlaybackClock();
  }

  function triggerMidpointActions() {
      console.log(`🎯 Locking in selection - ${LOCKOUT_THRESHOLD_SECONDS}s or less remaining`);

      // Clear inactivity timer - no longer needed in second half
      if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
      }

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
  }

  function lockCardInteractions() {
      console.log('🔒 Locking card interactions until next track');
      cardsLocked = true;

      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
          card.classList.add('interaction-locked');
          card.style.pointerEvents = 'none';
      });
  }

  function unlockCardInteractions() {
      console.log('🔓 Unlocking card interactions for new track');
      cardsLocked = false;
      cardsInactiveTilted = false;

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
  }

  // ====== Session Management ======

  // Smart SSE connection with health monitoring and reconnection
  function connectSSE() {
    const eventsUrl = syncEventsEndpoint(state.sessionId);
    console.log(`🔌 Connecting to SSE: ${eventsUrl}`);

    // Close existing connection if any
    if (connectionHealth.currentEventSource) {
      connectionHealth.currentEventSource.close();
    }

    const eventSource = new EventSource(eventsUrl);
    connectionHealth.currentEventSource = eventSource;

    const handleSseStuck = async () => {
      try {
        const response = await fetch('/sessions/now-playing', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const sessionInfo = Array.isArray(payload.sessions)
          ? payload.sessions.find(entry => entry.sessionId === state.sessionId)
          : null;

        if (sessionInfo && sessionInfo.md5) {
          console.warn('📡 SSE idle but session active; requesting explorer refresh');
          await requestSSERefresh();
          return false;
        }

        if (sessionInfo && !sessionInfo.md5) {
          console.warn('📡 SSE idle; session reported but no track yet. Waiting.');
          return false;
        }
      } catch (error) {
        console.error('📡 SSE stuck check failed:', error);
      }
      return true;
    };

    const resetStuckTimer = () => {
      if (connectionHealth.sse.stuckTimeout) {
        clearTimeout(connectionHealth.sse.stuckTimeout);
      }
      connectionHealth.sse.stuckTimeout = setTimeout(async () => {
        const shouldReconnect = await handleSseStuck();
        if (shouldReconnect) {
          console.warn('📡 SSE stuck check: forcing reconnect');
          connectionHealth.sse.status = 'reconnecting';
          updateConnectionHealthUI();
          eventSource.close();
          setTimeout(() => connectSSE(), 1000);
        } else {
          resetStuckTimer();
        }
      }, 60000);
    };

          fetch('/refresh-sse-simple', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {})
eventSource.onopen = () => {
      console.log('📡 SSE connected');
      connectionHealth.sse.status = 'connected';
      connectionHealth.sse.reconnectAttempts = 0;
      connectionHealth.sse.reconnectDelay = 2000;
      connectionHealth.sse.lastMessage = Date.now();
      updateConnectionHealthUI();

      resetStuckTimer();
    };

    eventSource.onmessage = (event) => {
      connectionHealth.sse.lastMessage = Date.now();
      resetStuckTimer();

      try {
        const raw = JSON.parse(event.data);

        // Normalize explorer sample tracks early (wrap { track } -> track)
        if (raw.explorer && raw.explorer.directions) {
          for (const directionKey of Object.keys(raw.explorer.directions)) {
            const direction = raw.explorer.directions[directionKey];
            if (Array.isArray(direction.sampleTracks)) {
              direction.sampleTracks = direction.sampleTracks.map(entry => entry.track || entry);
            }
            if (direction.oppositeDirection && Array.isArray(direction.oppositeDirection.sampleTracks)) {
              direction.oppositeDirection.sampleTracks = direction.oppositeDirection.sampleTracks.map(entry => entry.track || entry);
            }
          }
        }

       const data = raw;
       console.log('📡 Event:', data.type, data);

        if (data.type === 'connected' && data.sessionId) {
          const previousSession = state.sessionId;
          state.sessionId = data.sessionId;
          if (previousSession && previousSession !== data.sessionId) {
            console.warn(`🆔 SSE reported session change ${previousSession} → ${data.sessionId}`);
          } else if (!previousSession) {
            console.log(`🆔 SSE assigned session: ${state.sessionId}`);
          }
          syncEventsEndpoint(state.sessionId);
          if (!state.streamUrl || !state.streamUrl.includes('session=')) {
            syncStreamEndpoint(state.sessionId);
          }
        }

        // Ignore events from other sessions
        if (state.sessionId && data.session && data.session.sessionId && data.session.sessionId !== state.sessionId) {
          console.log(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${state.sessionId})`);
          return;
        }

        if (!state.sessionId && data.session && data.session.sessionId) {
          state.sessionId = data.session.sessionId;
          console.log(`🆔 Session discovered from payload: ${state.sessionId}`);
        }

        if (data.type === 'track_started') {
          const previousTrackId = state.latestCurrentTrack?.identifier || null;
          const currentTrackId = data.currentTrack?.identifier || null;
          const isSameTrack = previousTrackId && currentTrackId && previousTrackId === currentTrackId;
          const inferredTrack = data.explorer?.nextTrack?.track?.identifier || data.explorer?.nextTrack?.identifier || null;

          const rawResolution = data.explorer?.resolution;
          const normalizedResolution = normalizeResolution(rawResolution);
          const resolutionChanged = normalizedResolution && normalizedResolution !== state.currentResolution;
          if (resolutionChanged) {
            state.currentResolution = normalizedResolution;
            console.log(`🔍 Explorer resolution changed to: ${state.currentResolution}`);
            updateRadiusControlsUI();
          }

          const manualSelectionId = state.manualNextTrackOverride ? state.selectedIdentifier : null;
          const manualConflict = state.manualNextTrackOverride && manualSelectionId && currentTrackId && currentTrackId !== manualSelectionId;

          if (manualConflict) {
            console.warn('🛰️ ACTION override-diverged', {
              manualSelection: manualSelectionId,
              playing: currentTrackId,
              manualDirection: state.manualNextDirectionKey,
              serverSuggestedNext: inferredTrack || null
            });

            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            if (inferredTrack) {
              state.selectedIdentifier = inferredTrack;
            } else if (currentTrackId) {
              state.selectedIdentifier = currentTrackId;
            } else {
              state.selectedIdentifier = null;
            }
            updateRadiusControlsUI();
          }

          if (!isSameTrack) {
            if (state.manualNextTrackOverride) {
              const selectionVisible = state.selectedIdentifier && explorerContainsTrack(data.explorer, state.selectedIdentifier);

              if (selectionVisible) {
                console.log('🎯 Manual override: selection present in explorer payload; keeping user choice pinned');
              } else {
                console.log('🎯 Manual override: selection not yet in payload; waiting before repainting to avoid flicker');
              }
            } else {
              state.selectedIdentifier = inferredTrack;
              console.log(`🔄 SSE: New track started, accepting server next track: ${inferredTrack?.substring(0,8)}`);
              updateRadiusControlsUI();
            }
          } else {
            // Same track still playing
            if (resolutionChanged) {
              // Resolution changed - surrender previous selection and accept new explorer data
              console.log(`🔍 Resolution changed for same track - surrendering selection, accepting fresh explorer data`);
              state.manualNextTrackOverride = false;
              state.manualNextDirectionKey = null;
              state.selectedIdentifier = inferredTrack;
              updateRadiusControlsUI();
            } else if (state.manualNextTrackOverride && state.selectedIdentifier) {
              // No resolution change - preserve manual selection
              console.log(`🎯 SSE: Same track playing, preserving manual selection: ${state.selectedIdentifier?.substring(0,8)}`);
            }
          }

          console.log(`🎵 ${data.currentTrack.title} by ${data.currentTrack.artist}`);
          console.log(`🎯 Direction: ${data.driftState?.currentDirection}, Step: ${data.driftState?.stepCount}`);

          if (state.manualNextTrackOverride && currentTrackId && currentTrackId === state.selectedIdentifier) {
            console.log('🎯 Manual override satisfied by playback; releasing override lock');
            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            if (inferredTrack) {
              state.selectedIdentifier = inferredTrack;
              updateRadiusControlsUI();
            }
          }

          // New track started - ensure audio is connected
          if (connectionHealth.audio.status === 'error' || connectionHealth.audio.status === 'failed') {
            console.log('🔄 SSE received track but audio errored, reconnecting audio...');
            reconnectAudio();
          }

          updateNowPlayingCard(data.currentTrack, data.driftState);
          state.latestExplorerData = data.explorer;
          state.remainingCounts = {};
          createDimensionCards(data.explorer);

          const trackDurationSeconds = data.currentTrack.duration || data.currentTrack.length || 0;
          const startTimeMs = data.currentTrack.startTime;
          let elapsedSeconds = 0;
          if (startTimeMs) {
            elapsedSeconds = Math.max(0, (Date.now() - startTimeMs) / 1000);
          }

          if (trackDurationSeconds > 0) {
            const clampedElapsed = Math.min(elapsedSeconds, trackDurationSeconds);
            if (isSameTrack) {
              console.log(`🔄 SSE progress resync: elapsed=${clampedElapsed.toFixed(2)}s / duration=${trackDurationSeconds.toFixed(2)}s`);
              startProgressAnimationFromPosition(trackDurationSeconds, clampedElapsed, { resync: true });
            } else {
              startProgressAnimationFromPosition(trackDurationSeconds, clampedElapsed);
            }
          }
        }

        if (data.type === 'flow_options') {
          console.log('🌟 Flow options available:', Object.keys(data.flowOptions));
        }

        if (data.type === 'direction_change') {
          console.log(`🔄 Flow changed to: ${data.direction}`);
        }

      } catch (e) {
        console.log('📡 Raw event:', event.data);
      }
    };

    eventSource.onerror = (error) => {
      console.log('📡 SSE error:', error);
      connectionHealth.sse.status = 'reconnecting';
      updateConnectionHealthUI();

      // EventSource auto-reconnects, but track attempts
      connectionHealth.sse.reconnectAttempts++;
      connectionHealth.sse.reconnectDelay = Math.min(
        connectionHealth.sse.reconnectDelay * 1.5,
        connectionHealth.sse.maxReconnectDelay
      );

      // If stuck reconnecting, force recreate
      if (connectionHealth.sse.reconnectAttempts > 5) {
        console.log('📡 SSE stuck reconnecting, forcing new connection');
        eventSource.close();
        setTimeout(() => connectSSE(), connectionHealth.sse.reconnectDelay);
      }
    };
  }

  // Initialize SSE connection
  connectSSE();

    // Comprehensive duplicate detection system
  function performDuplicateAnalysis(explorerData, context = "unknown") {
      console.log(`🃏 === DUPLICATE ANALYSIS START (${context}) ===`);

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
                  console.log(`🃏 INTERESTING: Cross-direction duplicate:`, {
                      id, title: track.title, artist: track.artist,
                      directions: locations.map(l => l.direction),
                      locations: locations.map(l => `${l.direction}[${l.index}]`)
                  });
              }
          }
      });

      // Summary report
      console.log(`🃏 === DUPLICATE ANALYSIS SUMMARY (${context}) ===`);
      console.log(`🃏 Direction-level duplicates (VERY BAD): ${directionDuplicates.size} directions affected`);
      console.log(`🃏 Cross-dimension duplicates (WORSE): ${crossDimensionCount} tracks`);
      console.log(`🃏 Cross-direction duplicates (INTERESTING): ${crossDirectionCount} tracks`);
      console.log(`🃏 Total duplicate tracks: ${globalDuplicates.size}`);
      console.log(`🃏 === DUPLICATE ANALYSIS END ===`);

      return {
          directionDuplicates,
          crossDimensionCount,
          crossDirectionCount,
          globalDuplicates,
          totalDuplicates: globalDuplicates.size
      };
  }


  // Swap stack contents between current and opposite direction
  function swapStackContents(currentDimensionKey, oppositeDimensionKey) {
      console.log(`🔄 swapStackContents called with ${currentDimensionKey} → ${oppositeDimensionKey}`);

      // Toggle the simple opposite direction flag
      state.usingOppositeDirection = !state.usingOppositeDirection;
      console.log(`🔄 Toggled reverse mode: now using opposite direction = ${state.usingOppositeDirection}`);

      // Reset track index when flipping to opposite direction
      state.stackIndex = 0;
      console.log(`🔄 Reset track index to 0 for opposite direction`);

      // Redraw using the specific dimension we're working with, not the current playing track
      const baseKey = state.baseDirectionKey || currentDimensionKey;
      console.log(`🔄 About to call redrawNextTrackStack with baseDirectionKey: ${baseKey}`);
      redrawNextTrackStack(baseKey);
      console.log(`🔄 Finished calling redrawNextTrackStack`);
  }

  window.swapStackContents = swapStackContents;

  // Redraw the next track stack respecting the reverse flag
  function redrawNextTrackStack(specifiedDimensionKey = null) {
      if (!state.latestExplorerData?.nextTrack) return;

      const baseDimensionKey = specifiedDimensionKey || state.latestExplorerData.nextTrack.directionKey;
      state.baseDirectionKey = baseDimensionKey;
      const baseDirection = state.latestExplorerData.directions[baseDimensionKey];

      let displayDimensionKey, displayDirection; // Determine which direction data to use based on reverse state

      if (state.usingOppositeDirection) {
          // Using opposite direction - find the opposite data
          displayDimensionKey = getOppositeDirection(baseDimensionKey);
          displayDirection = state.latestExplorerData.directions[displayDimensionKey];

          console.log(`🔄 Current direction data:`, baseDirection);
          console.log(`🔄 Has oppositeDirection:`, !!baseDirection?.oppositeDirection);
          console.log(`🔄 Opposite key from getOppositeDirection:`, displayDimensionKey);
          console.log(`🔄 Opposite exists in directions:`, !!displayDirection);

          // Try embedded opposite direction first, then fallback to directions lookup
          if (baseDirection?.oppositeDirection) {
              displayDirection = baseDirection.oppositeDirection;
              displayDirection.hasOpposite = true;
              displayDimensionKey = baseDirection.oppositeDirection.key || displayDimensionKey;
              console.log(`🔄 Using embedded opposite direction data: ${displayDimensionKey}`);
          } else if (displayDirection) {
              console.log(`🔄 Using directions lookup for opposite direction: ${displayDimensionKey}`);
          } else {
              console.error(`🔄 No opposite direction data available for ${baseDimensionKey}`);
              return;
          }
      } else {
          // Using original direction - but need to check if baseDimensionKey is actually the "primary" one
	  displayDimensionKey = baseDimensionKey;
          displayDirection = state.latestExplorerData.directions[baseDimensionKey];

          // If the current baseDimensionKey doesn't exist in directions, it might be an opposite
          // that became the display direction, so we need to find its counterpart
          if (!displayDirection) {
              // Search all directions for one that has this key as oppositeDirection
              for (const [dirKey, dirData] of Object.entries(state.latestExplorerData.directions)) {
                  if (dirData.oppositeDirection?.key === baseDimensionKey) {
                      displayDirection = dirData.oppositeDirection;
                      displayDimensionKey = baseDimensionKey;
                      console.log(`🔄 Found embedded direction data for ${baseDimensionKey} in ${dirKey}.oppositeDirection`);
                      break;
                  }
              }
          }

          if (!displayDirection) {
              console.error(`🔄 No direction data found for ${baseDimensionKey}`);
              return;
          }
      }

      // Safety check for displayDirection
      if (!displayDirection) {
          // Direction doesn't exist in main list - search for it as embedded oppositeDirection data
          let foundEmbeddedData = false;

          for (const [mainKey, mainDirection] of Object.entries(state.latestExplorerData.directions)) {
              if (mainDirection.oppositeDirection?.key === baseDimensionKey) {
                  displayDirection = mainDirection.oppositeDirection;
                  displayDimensionKey = baseDimensionKey;
                  foundEmbeddedData = true;
                  console.log(`🔄 Found embedded data for ${baseDimensionKey} in ${mainKey}.oppositeDirection`);
                  break;
              }
          }

          if (!foundEmbeddedData) {
              console.error(`🔄 No direction data found for ${baseDimensionKey}`, {
                  available: Object.keys(state.latestExplorerData.directions || {}),
                  requested: baseDimensionKey,
                  searchedEmbedded: true
              });
              return;
          }
      }

      console.log(`🔄 Redrawing next track stack: base=${baseDimensionKey}, display=${displayDimensionKey}, reversed=${state.usingOppositeDirection}`);
      console.log(`🔄 Direction sample tracks count:`, displayDirection?.sampleTracks?.length || 0);
      console.log(`🔄 First track in direction:`, displayDirection?.sampleTracks?.[0]?.title || 'None');

      // Find the current next-track card
      const currentCard = document.querySelector('.dimension-card.next-track');
      if (!currentCard) {
          console.error('🔄 Could not find current next-track card');
          return;
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

      // Reset track index and update selection when flipping to opposite stack
      state.stackIndex = 0;
      state.selectedIdentifier = trackToShow.identifier;
      console.log(`🔄 Updated selection to first track of ${state.usingOppositeDirection ? 'OPPOSITE' : 'ORIGINAL'} stack (${displayDimensionKey}): ${trackToShow.title} (${trackToShow.identifier})`);

      // Notify server of the new track selection
      sendNextTrack(trackToShow.identifier, displayDimensionKey, 'user');

      // Clear stored original colors so they get recalculated for the new direction
      delete currentCard.dataset.originalBorderColor;
      delete currentCard.dataset.originalGlowColor;
      // ALSO clear current color data attributes to force complete recalculation
      delete currentCard.dataset.borderColor;
      delete currentCard.dataset.glowColor;
      console.log(`🔄 Cleared ALL stored colors for direction switch to ${displayDimensionKey}`);

      // Ensure displayDirection has the correct key property for color calculations
      displayDirection.key = displayDimensionKey;
      console.log(`🔄 Updated displayDirection.key to ${displayDimensionKey} for color calculation`);

      // CRITICAL FIX: Update the card's data-direction-key to match the actual direction being displayed
      currentCard.dataset.directionKey = displayDimensionKey;
      console.log(`🔄 Updated card data-direction-key to ${displayDimensionKey} to match displayed direction`);

      // Force complete reset of all color-related attributes and CSS
      currentCard.style.removeProperty('--border-color');
      currentCard.style.removeProperty('--glow-color');
      currentCard.dataset.directionType = getDirectionType(displayDimensionKey);

      // Update the card with the new track details (this will also handle visual feedback)
      updateCardWithTrackDetails(currentCard, trackToShow, displayDirection, false, swapStackContents);
  }

  // Animate a direction card from its clock position to center (becoming next track stack)
  function animateDirectionToCenter(directionKey) {
      console.log(`🎬 animateDirectionToCenter called for: ${directionKey}`);

      // Reset track index for the new dimension
      state.stackIndex = 0;
      const card = document.querySelector(`[data-direction-key="${directionKey}"]`);
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

          // If no fallback works, just return without animation
          console.error(`🎬 No fallback card found either, skipping animation`);
          return;
      }

      console.log(`🎬 Found card element, animating ${directionKey} from clock position to center`);

      // Transform this direction card into a next-track stack
      card.classList.add('next-track', 'animating-to-center');

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
      const sampleCount = direction.sampleTracks ? direction.sampleTracks.length : 0;
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
      console.log(`🎨 INITIAL COLOR RESULT for ${direction.key}:`, colors);
      console.log(`🎨 Card ${direction.key}: type=${directionType}, colors=`, colors);

      // Store direction type and colors for consistent coloring
      card.dataset.directionType = directionType;
      card.dataset.borderColor = colors.border;
      card.dataset.glowColor = colors.glow;

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

      const colorVariant = variantFromDirectionType(directionType);

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

      // Direction cards should NOT have reverse buttons - only next track stacks get them
      const unoReverseHtml = '';

      if (hasReverse) {
          console.log(`🔄 Generated reverse HTML for ${direction.key}:`, unoReverseHtml);
      }

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(direction.sampleTracks[0].albumCover)}"></div>
              <span class="rim"></span>
              <div class="bottom"></div>
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

      return card;
  }

  // Rotate center card to next available clock position (circular rotation system)
  function rotateCenterCardToNextPosition(directionKey) {
      const card = document.querySelector(`[data-direction-key="${directionKey}"].next-track`);
      if (!card) return;

      console.log(`🔄 Rotating center card ${directionKey} to next clock position`);

      if (typeof hideStackSizeIndicator === 'function') {
          hideStackSizeIndicator();
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
          card.classList.remove('next-track');
          // Stack indication is now handled by CSS pseudo-elements

          // Reset card content to simple direction display
          resetCardToDirectionDisplay(card, directionKey);

          card.style.transition = '';
      }, 800);
  }

  // Reset a card back to simple direction display (when moving from center to clock position)
  function resetCardToDirectionDisplay(card, directionKey) {
      console.log(`🔄 Resetting card ${directionKey} to direction display`);

      // IMPORTANT: Reset reverse state and restore original face
      console.log(`🔄 Restoring original face for ${directionKey} (removing any reversed state)`);

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

      // Clear any stored opposite direction state
      if (card.dataset.directionKey !== directionKey) {
          console.log(`🔄 Restoring original directionKey: ${card.dataset.directionKey} → ${directionKey}`);
          card.dataset.directionKey = directionKey;
      }

      const explorerDirections = state.latestExplorerData?.directions || {};
      let direction = explorerDirections[directionKey];

      if (!direction) {
          for (const [baseKey, baseDirection] of Object.entries(explorerDirections)) {
              if (baseDirection.oppositeDirection?.key === directionKey) {
                  direction = {
                      ...baseDirection.oppositeDirection,
                      hasOpposite: baseDirection.oppositeDirection.hasOpposite === true || baseDirection.hasOpposite === true
                  };
                  console.log(`🔄 Found embedded direction data for ${directionKey} inside ${baseKey}.oppositeDirection`);
                  break;
              }
          }
      }

      if (!direction) {
          console.error(`🔄 No direction data found for ${directionKey}`);
          console.error(`🔄 Available directions:`, Object.keys(explorerDirections));
          return;
      }

      const resolvedKey = direction.key || directionKey;
      const directionType = getDirectionType(resolvedKey);

      // Get matching colors and variant
      const colors = getDirectionColor(directionType, resolvedKey);
      const colorVariant = variantFromDirectionType(directionType);


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
      const labelContent = `<div class="dimension-label">${directionName}</div>`;

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(albumCover)}"></div>
              <span class="rim"></span>
              <div class="bottom"></div>
              <div class="label">
                  ${labelContent}
              </div>
          </div>
      `;

      console.log(`🔄 Card ${directionKey} reset to simple direction display`);

      if (state.baseDirectionKey === directionKey) {
          state.baseDirectionKey = null;
      }
  }

  // Convert a direction card into a next track stack (add track details and indicators)
  function convertToNextTrackStack(directionKey) {
      console.log(`🔄 Converting ${directionKey} to next track stack...`);
      console.log(`🔄 Latest explorer data:`, state.latestExplorerData);
      console.log(`🔄 Direction data:`, state.latestExplorerData?.directions[directionKey]);

      let directionData = state.latestExplorerData?.directions[directionKey];
      let actualDirectionKey = directionKey;

      if (!directionData) {
          // FALLBACK: Try the opposite direction if this direction doesn't exist in data
          const oppositeKey = getOppositeDirection(directionKey);
          console.log(`🔄 No data for ${directionKey}, trying opposite: ${oppositeKey}`);

          if (oppositeKey && state.latestExplorerData?.directions[oppositeKey]) {
              directionData = state.latestExplorerData.directions[oppositeKey];
              actualDirectionKey = oppositeKey;
              console.log(`🔄 Using opposite direction data: ${oppositeKey}`);
          } else {
              console.error(`🔄 No direction data found for ${directionKey} or its opposite ${oppositeKey}`);
              console.error(`🔄 Available directions:`, Object.keys(state.latestExplorerData?.directions || {}));
              return;
          }
      }

      // Use the resolved direction data and key
      const direction = directionData;
      // Ensure direction has the key property for consistency (use the card's key, not the data key)
      direction.key = directionKey;

      const sampleTracks = direction.sampleTracks || [];
      if (sampleTracks.length === 0) {
          console.error(`🔄 No sample tracks found for ${directionKey}`);
          return;
      }

      state.baseDirectionKey = directionKey;

      // Update the main card content with track details
      const card = document.querySelector(`[data-direction-key="${directionKey}"]`);
      if (!card) {
          console.error(`🔄 Could not find card element for ${directionKey}`);
          return;
      }
      console.log(`🔄 Found card for ${directionKey}, updating with track details...`);
      console.log(`🔄 Card element:`, card);
      console.log(`🔄 Sample tracks:`, sampleTracks);

      const selectedTrack = sampleTracks[0].track || sampleTracks[0];
      console.log(`🔄 Selected track:`, selectedTrack);
      console.log(`🔄 About to call updateCardWithTrackDetails with preserveColors=true...`);
      updateCardWithTrackDetails(card, selectedTrack, direction, true, swapStackContents);
      console.log(`🔄 Finished calling updateCardWithTrackDetails`);

      // Stack depth indication is now handled via CSS pseudo-elements on the main card
  }



  // Smart audio reconnection with exponential backoff
  function reconnectAudio() {
    if (connectionHealth.audio.reconnectAttempts >= connectionHealth.audio.maxAttempts) {
      console.error('🎵 Max audio reconnect attempts reached');
      connectionHealth.audio.status = 'failed';
      updateConnectionHealthUI();
      return;
    }

    connectionHealth.audio.reconnectAttempts++;
    connectionHealth.audio.status = 'reconnecting';
    updateConnectionHealthUI();

    const delay = connectionHealth.audio.reconnectDelay;
    console.log(`🎵 Audio reconnecting in ${delay}ms (attempt ${connectionHealth.audio.reconnectAttempts}/${connectionHealth.audio.maxAttempts})`);

    setTimeout(() => {
      if (state.streamUrl) {
        elements.audio.src = state.streamUrl;
      }
      elements.audio.load();
      if (state.isStarted) {
        elements.audio.play().then(() => {
          connectionHealth.audio.status = 'connected';
          connectionHealth.audio.reconnectAttempts = 0;
          connectionHealth.audio.reconnectDelay = 2000;
          updateConnectionHealthUI();
        }).catch((err) => {
          console.error('🎵 Audio play failed:', err);
          // Exponential backoff
          connectionHealth.audio.reconnectDelay = Math.min(
            connectionHealth.audio.reconnectDelay * 2,
            connectionHealth.audio.maxReconnectDelay
          );
          reconnectAudio();
        });
      }
    }, delay);
  }

  // Audio error handler with smart reconnection
  elements.audio.addEventListener('error', (e) => {
    const mediaError = elements.audio.error;
    console.error('🎵 Audio error:', mediaError?.code, mediaError?.message);

    connectionHealth.audio.status = 'error';
    updateConnectionHealthUI();

    // Only reconnect for network errors
    if (mediaError?.code === MediaError.MEDIA_ERR_NETWORK) {
      reconnectAudio();
    }
  });

  // Audio success handler
  elements.audio.addEventListener('playing', () => {
    connectionHealth.audio.status = 'connected';
    connectionHealth.audio.reconnectAttempts = 0;
    connectionHealth.audio.reconnectDelay = 2000;
    updateConnectionHealthUI();
  });

  // Periodic status check (optional, for monitoring)
  setInterval(() => {
    fetch('/status').catch(() => {});
  }, 30000);


// ====== Heartbeat & Sync System ======

// Unified next-track communication (handles user selection, heartbeat, and manual refresh)
async function sendNextTrack(trackMd5 = null, direction = null, source = 'user') {
    // source: 'user' | 'heartbeat' | 'manual_refresh'

    // Clear existing heartbeat
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
        state.heartbeatTimeout = null;
    }

    // Use existing data if not provided (heartbeat/refresh case)
    const manualOverrideActive = state.manualNextTrackOverride && state.selectedIdentifier;

    const allowFallback = source !== 'manual_refresh';

    let md5ToSend = trackMd5;
    let dirToSend = direction;

    if (!md5ToSend && allowFallback) {
        if (manualOverrideActive && state.selectedIdentifier) {
            md5ToSend = state.selectedIdentifier;
            dirToSend = dirToSend || state.manualNextDirectionKey || null;
        }

        if (!md5ToSend) {
            md5ToSend = state.latestExplorerData?.nextTrack?.track?.identifier || null;
            dirToSend = dirToSend || state.latestExplorerData?.nextTrack?.directionKey || null;
        }

        if (!md5ToSend) {
            md5ToSend = state.selectedIdentifier || null;
        }
    }

    if (manualOverrideActive && !dirToSend) {
        dirToSend = state.manualNextDirectionKey;
    }

    if (!md5ToSend) {
        console.warn('⚠️ sendNextTrack: No track MD5 available; requesting fresh guidance from server');
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;
        scheduleHeartbeat(10000); // Retry in 10s
        fullResync();
        return;
    }

    console.log(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend || 'unknown'}`);

    if (source === 'user') {
        state.manualNextTrackOverride = true;
        state.manualNextDirectionKey = dirToSend;
        if (state.nextTrackAnimationTimer) {
            clearTimeout(state.nextTrackAnimationTimer);
            state.nextTrackAnimationTimer = null;
        }
    }

    try {
        const response = await fetch('/next-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trackMd5: md5ToSend,
                direction: dirToSend,
                source
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        window.state = window.state || {};
        window.state.lastHeartbeatResponse = data;

        const serverTrack = data.currentTrack;
        const localTrack = state.latestCurrentTrack?.identifier || null;
        if (source === 'heartbeat' && serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch (immediate)', { serverTrack, localTrack });
            fullResync();
            return;
        }


        // data = { nextTrack, currentTrack, duration, remaining }

        console.log(`📥 Server response: next=${data.nextTrack?.substring(0,8)}, current=${data.currentTrack?.substring(0,8)}, remaining=${data.remaining}ms`);

        // Analyze response and take appropriate action
        analyzeAndAct(data, source, md5ToSend);

    } catch (error) {
        console.error('❌ sendNextTrack failed:', error);
        // Set shorter retry timeout
        scheduleHeartbeat(10000); // Retry in 10s
    }
}

function analyzeAndAct(data, source, sentMd5) {
    const { nextTrack, currentTrack, duration, remaining } = data;

    if (!data || !currentTrack) {
        console.warn('⚠️ Invalid server response');
        scheduleHeartbeat(60000);
        return;
    }

    const ICON = '🛰️';
    const serverDurationSeconds = (typeof duration === 'number' && duration > 0) ? (duration / 1000) : null;
    const serverElapsedSeconds = (typeof duration === 'number' && typeof remaining === 'number' && duration > 0)
        ? Math.max((duration - remaining) / 1000, 0)
        : null;
    const clientDurationSeconds = state.playbackDurationSeconds || null;
    const clientElapsedSeconds = (state.playbackStartTimestamp && state.playbackDurationSeconds)
        ? Math.max((Date.now() - state.playbackStartTimestamp) / 1000, 0)
        : null;

    const clientNextTrack = state.latestExplorerData?.nextTrack?.track?.identifier
        || state.latestExplorerData?.nextTrack?.identifier
        || state.selectedIdentifier
        || null;

    console.log(`${ICON} Sync snapshot (${source})`, {
        server: {
            currentTrack: currentTrack || null,
            elapsedSeconds: serverElapsedSeconds,
            durationSeconds: serverDurationSeconds,
            nextTrack: nextTrack || null
        },
        client: {
            currentTrack: state.latestCurrentTrack?.identifier || null,
            elapsedSeconds: clientElapsedSeconds,
            durationSeconds: clientDurationSeconds,
            nextTrack: clientNextTrack || null,
            pendingSelection: state.selectedIdentifier || null
        },
        sentOverride: sentMd5 || null
    });

    // Check 1: Current track MD5 mismatch
    const currentMd5 = state.latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        console.log(`${ICON} ACTION current-track-mismatch`, {
            expected: currentMd5,
            received: currentTrack,
            source
        });
        fullResync();
        return;
    }

    // Check 2: Next track MD5 mismatch
    const expectedNextMd5 = state.latestExplorerData?.nextTrack?.track?.identifier || state.selectedIdentifier;
    const nextTrackMismatch = expectedNextMd5 && nextTrack !== expectedNextMd5;

    if (nextTrackMismatch) {
        console.log(`${ICON} ACTION next-track-mismatch`, {
            expected: expectedNextMd5,
            received: nextTrack,
            source,
            sentMd5
        });

        // If this is what we just sent, it's a confirmation not a mismatch - just update our state
        if (sentMd5 && nextTrack === sentMd5) {
            console.log(`${ICON} ACTION confirmation`, {
                acknowledged: sentMd5,
                source
            });
            selectedNextTrackSha = nextTrack;
            scheduleHeartbeat(60000);
            return;
        }

        // Otherwise, server picked something different (only happens on heartbeat/auto-transition)
        // Check if the server's next track is in our current neighborhood
        if (isTrackInNeighborhood(nextTrack)) {
            console.log(`${ICON} ACTION promote-neighborhood`, {
                track: nextTrack,
                source
            });
            promoteTrackToNextStack(nextTrack);
            scheduleHeartbeat(60000);
        } else {
            console.log(`${ICON} ACTION full-resync-needed`, {
                track: nextTrack,
                reason: 'not_in_neighborhood',
                source
            });
            fullResync();
            return;
        }
    }

    // Check 3: Timing drift (just update, don't panic)
    if (typeof duration === 'number' && typeof remaining === 'number' && duration > 0) {
        const durationSeconds = Math.max(duration / 1000, 0);
        const elapsedSeconds = Math.max((duration - remaining) / 1000, 0);
        const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
        console.log(`${ICON} ACTION timing-update`, {
            durationSeconds,
            elapsedSeconds: clampedElapsed,
            source
        });
        startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: true });
    }

    // All checks passed
    console.log(`${ICON} ACTION sync-ok`, { source });
    scheduleHeartbeat(60000);
}

function isTrackInNeighborhood(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        return false;
    }

    // Search through all directions' sample tracks
    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const found = direction.sampleTracks.some(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });
            if (found) {
                console.log(`🔍 Track ${trackMd5.substring(0,8)} found in direction: ${dirKey}`);
                return true;
            }
        }
    }

    return false;
}

function promoteTrackToNextStack(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        console.warn('⚠️ No explorer data to promote track from');
        return;
    }

    // Find which direction contains this track
    let foundDirection = null;
    let foundTrack = null;

    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const trackData = direction.sampleTracks.find(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });

            if (trackData) {
                foundDirection = dirKey;
                foundTrack = trackData.track || trackData;
                break;
            }
        }
    }

    if (!foundDirection || !foundTrack) {
        console.error('❌ Track not found in any direction, cannot promote');
        return;
    }

    console.log(`🎯 Promoting track from ${foundDirection} to next track stack`);

    // Use existing function to swap next track direction
    swapNextTrackDirection(foundDirection);

    // Update selected track state
    state.selectedIdentifier = trackMd5;
}

function scheduleHeartbeat(delayMs = 60000) {
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
    }

    state.heartbeatTimeout = setTimeout(() => {
        console.log('💓 Heartbeat triggered');
        sendNextTrack(null, null, 'heartbeat');
        window.state = window.state || {};
        const serverTrack = window.state?.lastHeartbeatResponse?.currentTrack;
        const localTrack = window.state?.latestCurrentTrack?.identifier || null;
        if (serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch', { serverTrack, localTrack });
            fullResync();
            return;
        }

    }, delayMs);

    console.log(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

async function fullResync() {
    console.log('🔄 Full resync triggered - calling /refresh-sse');

    try {
        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: state.sessionId ? JSON.stringify({ sessionId: state.sessionId }) : '{}'
        });

        // Check for 404 - session no longer exists (server restart)
        if (response.status === 404) {
            console.error('🚨 Session not found on server - session was destroyed (likely server restart)');
            console.log('🔄 Reloading page to get new session...');
            window.location.reload();
            return;
        }

        const result = await response.json();

        if (result.ok) {
            console.log('✅ Resync broadcast triggered, waiting for SSE update...');
            // SSE event will update UI
            scheduleHeartbeat(60000);

            if (state.pendingResyncCheckTimer) {
              clearTimeout(state.pendingResyncCheckTimer);
            }

            state.pendingResyncCheckTimer = setTimeout(() => {
              const lastUpdate = state.lastTrackUpdateTs || 0;
              const age = Date.now() - lastUpdate;
              const hasCurrent = state.latestCurrentTrack && state.latestCurrentTrack.identifier;

              if (!hasCurrent || age > 5000) {
                console.warn('🛰️ ACTION resync-followup: no track update after broadcast, requesting SSE refresh');
                requestSSERefresh();
              }
            }, 5000);
        } else {
            console.warn('⚠️ Resync failed:', result.reason);

            // If session doesn't exist, reload
            if (result.error === 'Session not found' || result.error === 'Master session not found') {
                console.log('🔄 Session lost, reloading page...');
                window.location.reload();
                return;
            }

            scheduleHeartbeat(10000); // Retry sooner
        }
    } catch (error) {
        console.error('❌ Resync error:', error);
        scheduleHeartbeat(10000); // Retry sooner
    }
}

// Request SSE refresh from the backend
async function createNewJourneySession(reason = 'unknown') {
    if (state.creatingNewSession) {
        console.log(`🛰️ ACTION new-session-skip: already creating (${reason})`);
        return;
    }

    state.creatingNewSession = true;
    const previousSessionId = state.sessionId;

    try {
        console.warn(`🛰️ ACTION new-session (${reason}) - requesting fresh journey`);

        const streamElement = state.isStarted ? elements.audio : null;
        if (streamElement) {
            try {
                streamElement.pause();
            } catch (err) {
                console.warn('🎵 Pause before new session failed:', err);
            }
        }

        const response = await fetch('/session/random', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        const streamBase = result.streamUrl || '/stream';
        const eventsBase = result.eventsUrl || '/events';
        const newSessionId = result.sessionId || null;
        const cacheBuster = Date.now();

        state.streamUrlBase = streamBase;
        state.eventsEndpointBase = eventsBase;
        state.sessionId = newSessionId;

        const newStreamUrl = syncStreamEndpoint(newSessionId, { cacheBust: cacheBuster });
        syncEventsEndpoint(newSessionId);

        if (streamElement) {
            streamElement.src = newStreamUrl;
        }

        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;
        state.latestExplorerData = null;
        state.remainingCounts = {};

        if (state.pendingInitialTrackTimer) {
            clearTimeout(state.pendingInitialTrackTimer);
            state.pendingInitialTrackTimer = null;
        }
        if (state.pendingResyncCheckTimer) {
            clearTimeout(state.pendingResyncCheckTimer);
            state.pendingResyncCheckTimer = null;
        }

        if (result.currentTrack) {
            updateNowPlayingCard(result.currentTrack, null);
        } else {
            state.latestCurrentTrack = null;
            window.state.latestCurrentTrack = null;
            state.lastTrackUpdateTs = 0;
        }

        if (connectionHealth.currentEventSource) {
            connectionHealth.currentEventSource.close();
            connectionHealth.currentEventSource = null;
        }
        connectionHealth.sse.status = 'reconnecting';
        updateConnectionHealthUI();
        connectSSE();

        if (streamElement) {
            streamElement.load();
            streamElement.play().catch(err => {
                console.error('🎵 Audio play failed after new session:', err);
            });
        }

        if (state.pendingAudioConfirmTimer) {
            clearTimeout(state.pendingAudioConfirmTimer);
            state.pendingAudioConfirmTimer = null;
        }

        if (state.sessionId) {
            state.pendingAudioConfirmTimer = setTimeout(async () => {
                state.pendingAudioConfirmTimer = null;
                try {
                    const snapshot = await fetch('/sessions/now-playing', { cache: 'no-store' });
                    if (!snapshot.ok) {
                        throw new Error(`HTTP ${snapshot.status}`);
                    }

                    const payload = await snapshot.json();
                    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
                    const activeNew = sessions.find(entry => entry.sessionId === state.sessionId);
                    const activePrev = previousSessionId ? sessions.find(entry => entry.sessionId === previousSessionId) : null;

                    const newHasClient = activeNew && Number(activeNew.clients) > 0;
                    const prevHasClient = activePrev && Number(activePrev.clients) > 0;

                    if (!newHasClient && prevHasClient) {
                        console.warn('🛰️ ACTION session-audio-revert: new session missing audio clients, reverting to previous active stream', {
                            newSession: state.sessionId,
                            previousSession: previousSessionId,
                            previousClients: activePrev.clients
                        });

                        state.sessionId = previousSessionId;
                        syncEventsEndpoint(previousSessionId);
                        const restoredStreamUrl = syncStreamEndpoint(previousSessionId, { cacheBust: Date.now() });

                        if (connectionHealth.currentEventSource) {
                            connectionHealth.currentEventSource.close();
                            connectionHealth.currentEventSource = null;
                        }
                        connectionHealth.sse.status = 'reconnecting';
                        updateConnectionHealthUI();
                        connectSSE();

                        if (elements.audio) {
                            elements.audio.src = restoredStreamUrl;
                            elements.audio.load();
                            elements.audio.play().catch(err => {
                                console.error('🎵 Audio play failed during session revert:', err);
                            });
                        }

                        scheduleHeartbeat(5000);
                    } else if (newHasClient) {
                        console.log('🛰️ ACTION session-audio-confirmed: audio client attached to new session', {
                            session: state.sessionId,
                            clients: activeNew.clients
                        });
                    }
                } catch (error) {
                    console.error('❌ session audio confirmation failed:', error);
                }
            }, 4000);
        }

        scheduleHeartbeat(5000);
    } catch (error) {
        console.error('❌ Failed to create new journey session:', error);
        scheduleHeartbeat(10000);
    } finally {
        state.creatingNewSession = false;
    }
}

async function verifyExistingSessionOrRestart(reason = 'unknown') {
    if (!state.sessionId) {
        await createNewJourneySession(reason);
        return;
    }

    try {
        const response = await fetch('/sessions/now-playing', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const entry = sessions.find(session => session.sessionId === state.sessionId);

        if (entry && entry.md5) {
            const clientCount = Number(entry.clients) || 0;
            const elapsedMs = Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : null;
            const durationMs = Number.isFinite(entry.durationMs) ? entry.durationMs : null;
            const stillPlaying = clientCount > 0 || (
                elapsedMs !== null && durationMs !== null && elapsedMs <= durationMs + 15000
            );

            if (stillPlaying) {
                console.warn('🛰️ ACTION session-rebind: stream still active, reconnecting SSE without resetting session');

                if (connectionHealth.currentEventSource) {
                    connectionHealth.currentEventSource.close();
                    connectionHealth.currentEventSource = null;
                }

                connectionHealth.sse.status = 'reconnecting';
                updateConnectionHealthUI();
                syncStreamEndpoint(state.sessionId);
                syncEventsEndpoint(state.sessionId);
                connectSSE();

                scheduleHeartbeat(10000);
                return;
            }
        }
    } catch (error) {
        console.error('❌ verifyExistingSessionOrRestart failed:', error);
    }

    await createNewJourneySession(reason);
}

async function requestSSERefresh() {
    try {
        console.log('🔄 Sending SSE refresh request to backend...');
        const requestBody = {
            reason: 'zombie_session_recovery',
            clientTime: Date.now(),
            lastTrackStart: state.latestCurrentTrack?.startTime || null
        };

        // Add session ID if we have one
        if (state.sessionId) {
            requestBody.sessionId = state.sessionId;
        }

        if (!state.latestExplorerData || !state.latestExplorerData.directions) {
            requestBody.requestExplorerData = true;
        }

        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ SSE refresh request successful:', result);

            if (result.ok === false) {
                const reason = result.reason || 'unknown';
                console.warn(`🔄 SSE refresh reported issue: ${reason}`);

                if (reason === 'inactive') {
                    console.warn('🔄 SSE refresh indicates inactive session; verifying stream state');
                    if (result.streamAlive === false) {
                        await createNewJourneySession('refresh_inactive');
                    } else {
                        await verifyExistingSessionOrRestart('refresh_inactive');
                    }
                } else if (reason === 'no_track') {
                    console.warn('🔄 SSE refresh returned no track; scheduling quick heartbeat');
                    scheduleHeartbeat(5000);
                }
                return;
            }

            if (result.currentTrack) {
                console.log(`🔄 Backend reports active session with track: ${result.currentTrack.title} by ${result.currentTrack.artist}`);
                console.log(`🔄 Duration: ${result.currentTrack.duration}s, Broadcasting to ${result.clientCount} clients`);

                // Update the now playing card with current track data
                updateNowPlayingCard(result.currentTrack, null);

                // If the backend provides exploration data, update the cards
                if (result.explorerData) {
                    console.log(`🔄 Backend provided exploration data, updating direction cards`);
                    createDimensionCards(result.explorerData);
                } else {
                    console.log(`🔄 No exploration data from backend - keeping existing cards`);
                }

                if (!result.explorerData && (!state.latestExplorerData || !state.latestExplorerData.directions)) {
                    console.warn('⚠️ Explorer data still missing after refresh; forcing follow-up request');
                    fullResync();
                }

                // Start progress animation if duration is available
                if (result.currentTrack.duration) {
                    startProgressAnimation(result.currentTrack.duration);
                }

            } else {
                console.warn('🔄 SSE refresh completed but no current track reported');
            }

        } else {
            console.error('❌ SSE refresh request failed:', response.status, response.statusText);
            const errorText = await response.text();
            console.error('❌ Error details:', errorText);
        }

    } catch (error) {
        console.error('❌ SSE refresh request error:', error);
    }
}

async function manualRefresh() {
    console.log('🔄 Manual refresh snapshot');
    try {
        const response = await fetch('/sessions/now-playing', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const entry = Array.isArray(payload.sessions)
            ? payload.sessions.find(session => session.sessionId === state.sessionId)
            : null;

        if (!entry) {
            console.warn('🛰️ Manual refresh: session missing on server, creating new journey');
            await createNewJourneySession('manual_refresh_missing');
            return;
        }

        if (!entry.md5) {
            console.warn('🛰️ Manual refresh: no current track reported yet, requesting SSE refresh');
            await requestSSERefresh();
            return;
        }

        const localTrackId = state.latestCurrentTrack?.identifier || null;
        if (!localTrackId || localTrackId !== entry.md5) {
            console.warn('🛰️ Manual refresh: local track differs from server snapshot, requesting SSE refresh');
        } else {
            console.log('🛰️ Manual refresh: state matches server, refreshing explorer data');
        }

        await requestSSERefresh();
    } catch (error) {
        console.error('❌ Manual refresh snapshot failed:', error);
        await requestSSERefresh();
    }
}


// Manual refresh button functionality
function setupManualRefreshButton() {
    const refreshButton = document.getElementById('refreshButton');

    if (refreshButton) {
        refreshButton.addEventListener('click', async () => {
            console.log('🔄 Manual refresh button clicked');

            // Add visual feedback
            refreshButton.classList.add('refreshing');

            try {
                await manualRefresh();

                // Keep spinning animation for a bit longer to show it worked
                setTimeout(() => {
                    refreshButton.classList.remove('refreshing');
                }, 1500);

            } catch (error) {
                console.error('❌ Manual refresh failed:', error);
                refreshButton.classList.remove('refreshing');
            }
        });

        console.log('🔄 Manual refresh button set up');
    } else {
        console.warn('🔄 Manual refresh button not found in DOM');
    }
}

// Initialize manual refresh button when page loads
document.addEventListener('DOMContentLoaded', function () {
    setupManualRefreshButton();
    setupRadiusControls();
    setupFzfSearch(function () { state.journeyMode = true; });
});

// Check if stream endpoint is reachable
async function checkStreamEndpoint() {
    try {
        console.log('🔍 Checking stream endpoint connectivity...');

        const response = await fetch(state.streamUrl || '/stream', {
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
        requestSSERefresh();
    }
}

}
