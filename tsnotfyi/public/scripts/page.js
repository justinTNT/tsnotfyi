  // ====== Audio Streaming Setup ======

  // Check for injected sessionId first (from MD5 route)
  let sessionId = window.sessionId;

  if (!sessionId) {
      // Extract session name from clean URL path
      sessionId = window.location.pathname.split('/').filter(part => part !== '').pop();
      console.log(`🆔 URL path: ${window.location.pathname}, extracted: ${sessionId}`);
      if (!sessionId) {
          // Use master session for root page
          sessionId = null;
          console.log(`🆔 Using master session (root page)`);
      } else {
          console.log(`🆔 Using session from URL: ${sessionId}`);
      }
  } else {
      console.log(`🎯 Using injected session ID from MD5 route: ${sessionId}`);
      if (window.startingTrackMd5) {
          console.log(`🎯 Starting track MD5: ${window.startingTrackMd5}`);
      }
  }

  const streamUrl = sessionId ? `/stream/${sessionId}` : '/stream';
  console.log(`🎵 Audio stream URL: ${streamUrl}`);

  // Global state like it's 1989!
  let state = {
    latestExplorerData: null,       // Store latest explorer data for redrawing
    latestCurrentTrack: null,       // this one's just for metadata
    previousNextTrack: null,        // this one's just for metadata
    usingOppositeDirection: false,  // Simple reverse state: just track if current dimension is using opposite direction
    journeyMode: true,              // drive the main ui - turn off for fzf, etc
    selectedIdentifier: null,     // which next track card is currently selected
    stackIndex: 0,                  // index in the stack for the current selected dimension
    forceLayout: null,
    isStarted: false,
    progressAnimation: null,
    heartbeatTimeout: null          // Timer for 60s heartbeat (use latestCurrentTrack and latestExplorerData)
  };

  const elements = {
	  clickCatcher:        document.getElementById('clickCatcher');
          volumeControl:       document.getElementById('volumeControl');
          volumeBar:           document.getElementById('volumeBar');
          fullscreenProgress:  document.getElementById('fullscreenProgress');
	  progressWipe:        document.getElementById('progressWipe');
          audio:               document.getElementById('audio');
  }
  elements.audio.volume = 0.85;


  // Utility function to get displayable track title with fallback
  function getDisplayTitle(track) {
      return track.title ||
          (track.identifier ? `Track ${track.identifier.substring(0, 8)}...` : 'Unknown Track');
  }



  function updateNowPlayingCard(trackData, driftState) {
      state.latestCurrentTrack = trackData;

      // Update direction based on current drift direction
      const directionText = driftState && driftState.currentDirection ?
          formatDirectionName(driftState.currentDirection) :
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
      photo.style.background =
		  state.previousNextTrack?.identifier === trackData.identifier
		  ? state.previousNextTrack.albumCover
		  : `url('${trackData.albumCover}')`;

      // Randomly assign panel color variant
      const panel = document.querySelector('.panel');
      const variants = ['red-variant', 'green-variant', 'yellow-variant', 'blue-variant'];
      // Remove existing variants
      variants.forEach(v => panel.classList.remove(v));
      // Add random variant
      const variant =
		  state.previousNextTrack?.identifier === trackData.identifier
		  ? state.previousNextTrack.variant
		  : variants[Math.floor(Math.random() * variants.length)];
      panel.classList.add(randomVariant);

      // Show card with zoom-in animation
      const card = document.getElementById('nowPlayingCard');
      card.classList.add('visible');

  }




  function createDimensionCards(explorerData) {
      // Store for later redraw
      const NxTk = state.latestExplorerData.nextTrack;
      if (NxTk && (explorerData.nextTrack.identifier !== NxTk.identifier))
          state.previousNextTrack = {
	      identifier: NxTk.identifier,
	      albumCover: NxTk.albumCover,
              variant: variantFromDirectionType(getDirectionType(NxTk.directionKey))
          };
      }
      state.latestExplorerData = explorerData;

      // Run comprehensive duplicate analysis on new data
      performDuplicateAnalysis(explorerData, "createDimensionCards");

      const container = document.getElementById('dimensionCards');
      console.log('🎯 Container element:', container);

      if (!container) {
          console.error('❌ NO CONTAINER ELEMENT FOUND!');
          return;
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
          const trackCount = direction.sampleTracks?.length || 0;

          console.log(`🎯 Creating direction card ${index}: ${direction.key} (${trackCount} tracks)${hasReverse ? ' with reverse' : ''}`);
          if (hasReverse) {
              const oppositeCount = direction.oppositeDirection?.sampleTracks?.length || 0;
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
      setTimeout(() => {
          if (explorerData.nextTrack) {
              console.log(`🎯 Animating ${explorerData.nextTrack.directionKey} to center as next track`);
              animateDirectionToCenter(explorerData.nextTrack.directionKey);
          }
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

      const targetDimension = directions.find(d => d.key === newNextDirectionKey);
      if (targetDimension) {
          const dimensionIndex = directions.findIndex(d => d.key === newNextDirectionKey);
          // Create immediately without animation delay
          const sampleTracks = targetDimension.sampleTracks || [];
          // Use global selection state, default to first track if none selected
          const selectedTrackIndex = state.selectedIdentifier
              ? sampleTracks.findIndex(trackObj => {
                  const track = trackObj.track || trackObj;
                  return track.identifier === state.selectedIdentifier;
                })
              : 0;
          const finalSelectedTrackIndex = selectedTrackIndex >= 0 ? selectedTrackIndex : 0;

          sampleTracks.forEach((trackObj, trackIndex) => {
              const track = trackObj.track || trackObj;
              const isSelectedTrack = trackIndex === finalSelectedTrackIndex;
              const card = createTrackDetailCard(targetDimension, track, dimensionIndex, directions.length, isSelectedTrack, trackIndex, sampleTracks.length);
              container.appendChild(card);
              // Make visible immediately - no delay
              card.classList.add('visible');
          });
      }
  }

  function createNextTrackCardStack(direction, index, total, nextTrackData, container) {
      // Get all sample tracks for this direction
      const sampleTracks = direction.sampleTracks || [];
      // Use global selection state, default to first track if none selected
      const selectedTrackIndex = state.selectedIdentifier
          ? sampleTracks.findIndex(trackObj => {
              const track = trackObj.track || trackObj;
              return track.identifier === state.selectedIdentifier;
            })
          : 0;
      const finalSelectedTrackIndex = selectedTrackIndex >= 0 ? selectedTrackIndex : 0;

      // Create selected card (front, fully visible)
      const selectedTrack = sampleTracks[finalSelectedTrackIndex];
      const selectedCard = createTrackDetailCard(direction, selectedTrack.track || selectedTrack, index, total, true, 0, sampleTracks.length);
      container.appendChild(selectedCard);

      // Stack depth indication is now handled via CSS pseudo-elements on the main card

      // Stagger animation for selected card
      setTimeout(() => {
          selectedCard.classList.add('visible');
      }, index * 150 + 1000);
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
      if (!state.latestExplorerData || !selectedIdentifier) return;
      console.log('🔄 Seamlessly updating selection:', selectedIdentifier);

      // Find the selected card first
      const allTrackCards = document.querySelectorAll('.dimension-card.track-detail-card.next-track');
      let selectedCard = null;
      let selectedDimensionKey = null;

      // First pass: identify the selected card
      allTrackCards.forEach(card => {
          if (card.dataset.trackMd5 === selectedIdentifier) {
              selectedCard = card;
              selectedDimensionKey = card.dataset.directionKey;
          }
      });

      if (!selectedCard) return;

      // Second pass: update all cards based on selection
      allTrackCards.forEach(card => {
          const cardTrackMd5 = card.dataset.trackMd5;
          const directionKey = card.dataset.directionKey;
          const trackIndex = parseInt(card.dataset.trackIndex) || 0;
          const isSelectedCard = (cardTrackMd5 === selectedIdentifier);
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
      elements.volumeControl.style.display = 'block';
      document.body.style.cursor = 'default';
      state.isStarted = true;

      // Remove clickwall completely after fade
      setTimeout(() => {
          elements.clickCatcher.style.display = 'none';
      }, 800);

      // Set audio source and start playing
      console.log(`🎵 Setting audio source to: ${streamUrl}`);

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

      elements.audio.src = streamUrl;
      elements.audio.play().catch(e => {
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
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      const volume = Math.max(0, Math.min(1, percent));

      elements.audio.volume = volume;
      elements.volumeBar.style.width = (volume * 100) + '%';
  });

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
      if (!state.isStarted) return;
      if (!state.journeyMode) return;

      switch (e.key) {
          case '+':
              elements.audio.volume = Math.min(1, elements.audio.volume + 0.1);
              elements.volumeBar.style.width = (elements.audio.volume * 100) + '%';
              e.preventDefault();
              break;
          case '-':
              elements.audio.volume = Math.max(0, elements.audio.volume - 0.1);
              elements.volumeBar.style.width = (elements.audio.volume * 100) + '%';
              e.preventDefault();
              break;
          case 'ArrowRight':
              // rotate the wheel clockwise
              const clockCards = Array.from(document.querySelectorAll('[data-direction-key]:not(.next-track)'))
                  .map(c => ({
                      element: c,
                      key: c.dataset.directionKey,
                      position: parseInt(c.dataset.clockPosition) || 12
                  }))
                  .sort((a, b) => a.position - b.position);

              // Find first available empty position on the clock face
              const occupiedPositions = new Set(clockCards.map(c => c.position));

              let nextPosition = card.dataset.originalClockPosition ? parseInt(card.dataset.originalClockPosition) : 1;

              // Find first available gap in positions 1-12
              const availablePositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11, 12];
              for (const index of [nextPosition..nextPosition+12) {
                  const posFromIndex = (index%12)+1;
                  if (occupiedPositions.has(posFromIndex) {
                      nextPosition = posFromIndex;
                      break;
                  }

              swapNextTrackDirection(clockCards[nextPosition - 1].key);
              e.preventDefault();
              break;
          case 'ArrowLeft':
              // rotate the wheel counter-clockwise
              const clockCards = Array.from(document.querySelectorAll('[data-direction-key]:not(.next-track)'))
                  .map(c => ({
                      element: c,
                      key: c.dataset.directionKey,
                      position: parseInt(c.dataset.clockPosition) || 12
                  }))
                  .sort((a, b) => a.position - b.position);

              const occupiedPositions = new Set(clockCards.map(c => c.position));
              let nextPosition = card.dataset.originalClockPosition ? parseInt(card.dataset.originalClockPosition) : 1;

              // Find first available gap in positions 12-1
              const availablePositions = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
              for (const index of [nextPosition..nextPosition+12) {
                  const posFromIndex = 12 - (index%12);
                  if (occupiedPositions.has(posFromIndex) {
                      nextPosition = posFromIndex;
                      break;
                  }

              swapNextTrackDirection(clockCards[nextPosition - 1].key);
              e.preventDefault();
              break;
          case 'ArrowDown':
              // deal another card from the pack
              const key =  state.latestExplorerData.nextTrack.directionKey;
              cycleStackContents(key, state.stackIndex);
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

                      fetch(`/session/${sessionId}/seek`, {
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
                                      startProgressAnimationFromPosition(data.newDuration, data.currentPosition);

                                      // Remove temporary event listener
                                      eventSource.removeEventListener('message', handleSeekSync);
                                  }
                              };

                              // Add temporary listener for seek sync response
                              eventSource.addEventListener('message', handleSeekSync);

                              // Timeout fallback in case SSE doesn't respond
                              setTimeout(() => {
                                  eventSource.removeEventListener('message', handleSeekSync);
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
              fetch(`/session/${sessionId}/zoom/microscope`, {
                  method: 'POST'
              }).catch(err => console.error('Microscope request failed:', err));
              e.preventDefault();
              rejig();
              break;

          case '2':
              // Magnifying glass - detailed examination
              console.log('🔍 Key 2: Magnifying glass mode');
              fetch(`/session/${sessionId}/zoom/magnifying`, {
                  method: 'POST'
              }).catch(err => console.error('Magnifying request failed:', err));
              e.preventDefault();
              rejig();
              break;

          case '3':
              // Binoculars - wide exploration
              console.log('🔭 Key 3: Binoculars mode');
              fetch(`/session/${sessionId}/zoom/binoculars`, {
                  method: 'POST'
              }).catch(err => console.error('Binoculars request failed:', err));
              e.preventDefault();
              rejig();
              break;
      }
  });

  animateBeams();

  // ====== Inactivity Management ======
  let inactivityTimer = null;
  let lastActivityTime = Date.now();
  let cardsInactiveTilted = false; // Track if cards are already tilted from inactivity
  let midpointReached = false; // Track if we've hit the midpoint
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

  function startProgressAnimationFromPosition(durationSeconds, startPositionSeconds = 0) {
      // Clear any existing animation
      if (state.progressAnimation) {
          clearInterval(state.progressAnimation);
      }

      // Reset progress and interaction state
      elements.progressWipe.style.width = '0%';
      elements.progressWipe.style.left = '0%';
      elements.progressWipe.style.right = 'auto';
      elements.fullscreenProgress.classList.add('active');
      midpointReached = false;
      cardsLocked = false;
      cardsInactiveTilted = false; // Reset inactivity state

      // Unlock cards at start of new track
      unlockCardInteractions();

      // Restart inactivity tracking for new track
      markActivity();

      console.log(`🎬 Starting progress animation for ${durationSeconds}s from position ${startPositionSeconds}s - First half: browsing, Second half: locked in`);

      // Calculate initial progress and remaining duration
      const initialProgress = startPositionSeconds / durationSeconds;
      const remainingDuration = (durationSeconds - startPositionSeconds) * 1000; // Convert to milliseconds

      // Animate progress over the remaining track duration
      const startTime = Date.now();

      state.progressAnimation = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const elapsedProgress = elapsed / remainingDuration;
          const progress = Math.min(initialProgress + elapsedProgress * (1 - initialProgress), 1);

          // Phase 1 (0-50%): Fix left edge, grow width (wipe on L→R) - BROWSING TIME
          // Phase 2 (50-100%): Fix right edge, shrink width (wipe off L→R) - LOCKED IN
          if (progress <= 0.5) {
              // Phase 1: Wipe on from left
              elements.progressWipe.style.left = '0%';
              elements.progressWipe.style.right = 'auto';
              elements.progressWipe.style.width = (progress * 2 * 100) + '%'; // 0% to 100% in first half
          } else {
              // Phase 2: Wipe off from left (shrink from right edge)
              const phase2Progress = (progress - 0.5) * 2; // 0-1 for second half
              elements.progressWipe.style.left = (phase2Progress * 100) + '%';
              elements.progressWipe.style.right = 'auto';
              elements.progressWipe.style.width = ((1 - phase2Progress) * 100) + '%'; // 100% to 0%

              // Trigger midpoint actions when crossing from phase 1 to phase 2
              if (!midpointReached) {
                  triggerMidpointActions();
                  midpointReached = true;
              }
          }

          // Stop when complete
          if (progress >= 1) {
              clearInterval(state.progressAnimation);
              state.progressAnimation = null;
              // Keep the progress bar visible until next track
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
  }

  function triggerMidpointActions() {
      console.log('🎯 MIDPOINT REACHED - Locking in selection');

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

  // Server-Sent Events for real-time track updates
  const eventsUrl = sessionId ? `/events/${sessionId}` : '/events';
  console.log(`🔌 Connecting to SSE: ${eventsUrl}`);
  console.log(`🔌 Session ID for SSE: ${sessionId || 'master'}`);
  const eventSource = new EventSource(eventsUrl);

  eventSource.onopen = () => {
      console.log('📡 Connected to stream events');
  };

  eventSource.onmessage = (event) => {
      try {
          const data = JSON.parse(event.data);
          console.log('📡 Event:', data.type, data);

          // Ignore events from other sessions
          if (data.session && data.session.sessionId && data.session.sessionId !== sessionId) {
              console.log(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${sessionId})`);
              return;
          }

          if (data.type === 'track_started') {
              console.log(`🎵 ${data.currentTrack.title} by ${data.currentTrack.artist}`);
              console.log(`🎯 Direction: ${data.driftState?.currentDirection}, Step: ${data.driftState?.stepCount}`);

              // Clear any previous zombie session guards - new track started successfully
              clearZombieSessionGuard();

              updateNowPlayingCard(data.currentTrack, data.driftState);
              createDimensionCards(data.explorer);

              // Start progress bar animation for track duration
              if (data.currentTrack.duration) {
                  startProgressAnimation(data.currentTrack.duration);

                  // Set up zombie session detection - request SSE refresh if no new track after 1.5x expected duration
                  setupZombieSessionGuard(data.currentTrack.duration);
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

      // Update server
      sendNextTrack(nextTrack.identifier, directionKey, 'user');

      // Refresh UI
      refreshCardsWithNewSelection();
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
      console.log(`🔄 About to call redrawNextTrackStack with currentDimensionKey: ${currentDimensionKey}`);
      redrawNextTrackStack(currentDimensionKey);
      console.log(`🔄 Finished calling redrawNextTrackStack`);
  }

  // Redraw the next track stack respecting the reverse flag
  function redrawNextTrackStack(specifiedDimensionKey = null) {
      if (!state.latestExplorerData?.nextTrack) return;

      const baseDimensionKey = specifiedDimensionKey || state.latestExplorerData.nextTrack.directionKey;
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

      // Get the tracks from the direction data we already have
      const displayTracks = displayDirection.sampleTracks || [];
      if (displayTracks.length === 0) {
          console.error(`🔄 No tracks found for direction ${displayDimensionKey}`);
          return;
      }

      const trackToShow = displayTracks[0].track || displayTracks[0];

      console.log(`🔄 TRACK SELECTION DEBUG:`, {
          state.usingOppositeDirection,
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
      updateCardWithTrackDetails(currentCard, trackToShow, displayDirection);
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

  // Rotate center card to next available clock position (circular rotation system)
  function rotateCenterCardToNextPosition(directionKey) {
      const card = document.querySelector(`[data-direction-key="${directionKey}"].next-track`);
      if (!card) return;

      console.log(`🔄 Rotating center card ${directionKey} to next clock position`);

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

      if (!state.latestExplorerData?.directions[directionKey]) {
          console.error(`🔄 No direction data found for ${directionKey}`);
          return;
      }

      // IMPORTANT: Reset reverse state and restore original face
      console.log(`🔄 Restoring original face for ${directionKey} (removing any reversed state)`);

      // Remove reversed classes and restore original direction
      card.classList.remove('reversed', 'negative-direction');

      // Clear any stored opposite direction state
      if (card.dataset.directionKey !== directionKey) {
          console.log(`🔄 Restoring original directionKey: ${card.dataset.directionKey} → ${directionKey}`);
          card.dataset.directionKey = directionKey;
      }

      const direction = state.latestExplorerData.directions[directionKey];
      const directionType = getDirectionType(directionKey);

      // Get matching colors and variant
      const colors = getDirectionColor(directionType, directionKey);
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

      // Reset to simple direction content
      const directionName = direction?.isOutlier ? "Outlier" : formatDirectionName(directionKey);
      const labelContent = `<div class="dimension-label">${directionName}</div>`;

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(direction.sampleTracks[0].albumCover)}"></div>
              <span class="rim"></span>
              <div class="bottom"></div>
              <div class="label">
                  ${labelContent}
              </div>
          </div>
      `;

      console.log(`🔄 Card ${directionKey} reset to simple direction display`);
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
      updateCardWithTrackDetails(card, selectedTrack, direction, true);
      console.log(`🔄 Finished calling updateCardWithTrackDetails`);

      // Stack depth indication is now handled via CSS pseudo-elements on the main card
  }

  // Update the stack size indicator with remaining track count
  function updateStackSizeIndicator(direction) {
      const nextTrackCard = document.querySelector('.dimension-card.next-track');
      if (!nextTrackCard) return;

      // Remove any existing stack indicator
      const existingIndicator = nextTrackCard.querySelector('.stack-size-indicator');
      if (existingIndicator) {
          existingIndicator.remove();
      }

      // Count tracks from the direction object that was actually passed in
      // This direction object already represents the correct track pool (original or opposite)
      const tracksToCount = direction.sampleTracks || [];
      const remainingCount = Math.max(0, tracksToCount.length - 1); // -1 for current showing track

      console.log(`💿 Stack indicator: ${direction.key}, tracks=${tracksToCount.length}, remaining=${remainingCount}`);

      if (remainingCount > 0) {
          // Create new stack indicator as child of the card
          const indicator = document.createElement('div');
          indicator.className = 'stack-size-indicator';
          indicator.innerHTML = `<span class="stack-size-text">+${remainingCount}</span>`;

          // Add click handler for cycling
          indicator.addEventListener('click', (e) => {
              e.stopPropagation(); // Prevent card click
              console.log(`💿 Stack indicator clicked - cycling deck`);

              // Simulate clicking the card to cycle through tracks
              nextTrackCard.click();
          });

          nextTrackCard.appendChild(indicator);
          console.log(`💿 Added stack indicator to card: +${remainingCount}`);
      }
  }

  // Hide the stack size indicator
  function hideStackSizeIndicator() {
      const allCards = document.querySelectorAll('.dimension-card');
      allCards.forEach(card => {
          const indicator = card.querySelector('.stack-size-indicator');
          if (indicator) {
              indicator.remove();
          }
      });
  }

  // Update the JSON metadata overlay with full next track data
  function updateDirectionKeyOverlay(direction) {
      console.log(`🎨 JSON 1`);
      const overlay = document.getElementById('directionKeyOverlay');
      const text1 = document.getElementById('dkt1');
      const text2 = document.getElementById('dkt2');

      if (!overlay || !text1 || !text2) return;
      console.log(`🎨 JSON 2`);

      const metadata2 = {
          direction: {
              key: direction.key,
              name: direction.name || formatDirectionName(direction.key),
              description: direction.description,
              trackCount: direction.trackCount,
              diversityScore: direction.diversityScore,
              sampleTracks: direction.sampleTracks?.length || 0
          },
          nextTrack: direction.sampleTracks?.[0] ? {
              identifier: direction.sampleTracks[0].identifier,
              title: getDisplayTitle(direction.sampleTracks[0]),
              artist: direction.sampleTracks[0].artist || 'Unknown Artist',
              album: direction.sampleTracks[0].album || null,
              duration: direction.sampleTracks[0].duration,
              distance: direction.sampleTracks[0].distance,
              features: direction.sampleTracks[0].features
          } : null,
      };

      // Format as readable JSON with proper indentation
      console.log(`🎨 JSON 3`);
      text1.textContent = JSON.stringify(state.latestCurrentTrack, null, 2);
      console.dir({got: text1.textContent, from: state.latestCurrentTrack});
      text2.textContent = JSON.stringify(metadata2, null, 2);
      console.dir({got: text2.textContent, from: metadata2});

      console.log(`🎨 JSON metadata overlay updated for: ${direction.key}`);
  }

  // Hide the direction key overlay
  function hideDirectionKeyOverlay() {
      const overlay = document.getElementById('directionKeyOverlay');
      if (overlay) {
          overlay.classList.add('hidden');
      }
  }

  eventSource.onerror = (error) => {
      console.log('📡 SSE error:', error);
  };

  setInterval(() => {
      const statusUrl = sessionId ? `/status/${sessionId}` : '/status';
      fetch(statusUrl).catch(() => {});
  }, 30000);

  // Auto-reload on stream errors
  elements.audio.addEventListener('error', () => {
      setTimeout(() => {
          elements.audio.load();
          if (state.isStarted) elements.audio.play().catch(() => {});
      }, 2000);
  });

  // ====== Resize Handler ======
  addEventListener('resize', () => {
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
  });


// ====== Zombie Session Detection & Recovery ======

let zombieGuardTimer = null;
let lastTrackStartTime = null;

// Set up guardrail to detect zombie sessions
function setupZombieSessionGuard(trackDuration) {
    // Clear any existing zombie guard
    if (zombieGuardTimer) {
        clearTimeout(zombieGuardTimer);
        zombieGuardTimer = null;
    }

    // Record when this track started
    lastTrackStartTime = Date.now();

    // Set up timer for 1.5x the track duration
    const guardTimeoutMs = trackDuration * 1500; // 1.5x duration in milliseconds

    console.log(`🛡️ Zombie session guard set for ${(guardTimeoutMs/1000).toFixed(1)}s (1.5x track duration of ${trackDuration}s)`);

    zombieGuardTimer = setTimeout(() => {
        const elapsedMs = Date.now() - lastTrackStartTime;
        const elapsedSec = elapsedMs / 1000;

        console.log(`🧟 Zombie session detected! Track should have ended after ${trackDuration}s, but ${elapsedSec.toFixed(1)}s have passed`);
        console.log(`🛡️ Requesting SSE refresh to recover zombie session`);

        // Request SSE refresh to wake up the backend
        requestSSERefresh();

        // Set up another guard in case the first refresh doesn't work
        setupRecoveryGuard(trackDuration);

    }, guardTimeoutMs);
}

// Set up secondary recovery guard after first refresh attempt
function setupRecoveryGuard(originalTrackDuration) {
    // Give it another 30 seconds after refresh request
    const recoveryTimeoutMs = 30000;

    console.log(`🛡️ Setting up recovery guard for additional 30s`);

    setTimeout(() => {
        const totalElapsedMs = Date.now() - lastTrackStartTime;
        const totalElapsedSec = totalElapsedMs / 1000;

        console.log(`🧟 Recovery failed! Total time elapsed: ${totalElapsedSec.toFixed(1)}s (expected: ${originalTrackDuration}s)`);
        console.log(`🛡️ Final recovery attempt - forcing SSE refresh`);

        // Final recovery attempt
        requestSSERefresh();

        // Optionally show user notification
        console.log('🚨 Session appears to be stuck - tried to recover automatically');

    }, recoveryTimeoutMs);
}

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
    const md5ToSend = trackMd5 || state.latestExplorerData?.nextTrack?.track?.identifier || state.selectedIdentifier;
    const dirToSend = direction || state.latestExplorerData?.nextTrack?.directionKey;

    if (!md5ToSend) {
        console.warn('⚠️ sendNextTrack: No track MD5 available, skipping');
        scheduleHeartbeat(10000); // Retry in 10s
        return;
    }

    console.log(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend || 'unknown'}`);

    try {
        const response = await fetch('/next-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trackMd5: md5ToSend,
                direction: dirToSend
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
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

    // Check 1: Current track MD5 mismatch
    const currentMd5 = state.latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        console.log(`🔄 CURRENT TRACK MISMATCH! Expected ${currentMd5?.substring(0,8)}, got ${currentTrack?.substring(0,8)}`);
        fullResync();
        return;
    }

    // Check 2: Next track MD5 mismatch
    const expectedNextMd5 = state.latestExplorerData?.nextTrack?.track?.identifier || state.selectedIdentifier;
    const nextTrackMismatch = expectedNextMd5 && nextTrack !== expectedNextMd5;

    if (nextTrackMismatch) {
        console.log(`🔄 NEXT TRACK MISMATCH! Expected ${expectedNextMd5?.substring(0,8)}, got ${nextTrack?.substring(0,8)}`);

        // If this is what we just sent, it's a confirmation not a mismatch - just update our state
        if (sentMd5 && nextTrack === sentMd5) {
            console.log(`✅ Server confirmed our selection - updating local state only`);
            selectedNextTrackSha = nextTrack;
            scheduleHeartbeat(60000);
            return;
        }

        // Otherwise, server picked something different (only happens on heartbeat/auto-transition)
        // Check if the server's next track is in our current neighborhood
        if (isTrackInNeighborhood(nextTrack)) {
            console.log(`✅ Server's next track found in local neighborhood - promoting to next track stack`);
            promoteTrackToNextStack(nextTrack);
            scheduleHeartbeat(60000);
        } else {
            console.log(`❌ Server's next track NOT in neighborhood - need full resync`);
            fullResync();
            return;
        }
    }

    // Check 3: Timing drift (just update, don't panic)
    // TODO: Could update progress bar here if we implement one

    // All checks passed
    console.log(`✅ Sync confirmed (${source})`);
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
    }, delayMs);

    console.log(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

async function fullResync() {
    console.log('🔄 Full resync triggered - calling /refresh-sse');

    try {
        const endpoint = sessionId ? '/refresh-sse' : '/refresh-sse-simple';
        const body = sessionId ? JSON.stringify({ sessionId }) : '{}';

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });

        const result = await response.json();

        if (result.ok) {
            console.log('✅ Resync broadcast triggered, waiting for SSE update...');
            // SSE event will update UI
            scheduleHeartbeat(60000);
        } else {
            console.warn('⚠️ Resync failed:', result.reason);
            scheduleHeartbeat(10000); // Retry sooner
        }
    } catch (error) {
        console.error('❌ Resync error:', error);
        scheduleHeartbeat(10000); // Retry sooner
    }
}

// Request SSE refresh from the backend
async function requestSSERefresh() {
    try {
        console.log(`🔄 Sending SSE refresh request to backend for session: ${sessionId || 'master'}...`);

        // Use the specific session refresh endpoint if we have a session ID
        const endpoint = sessionId ? '/refresh-sse' : '/refresh-sse-simple';
        const requestBody = {
            reason: 'zombie_session_recovery',
            clientTime: Date.now(),
            lastTrackStart: lastTrackStartTime
        };

        // Add session ID if we have one
        if (sessionId) {
            requestBody.sessionId = sessionId;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ SSE refresh request successful:', result);

            if (result.active && result.currentTrack) {
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

                // Start progress animation if duration is available
                if (result.currentTrack.duration) {
                    startProgressAnimation(result.currentTrack.duration);
                }

            } else {
                console.log('🔄 Backend reports inactive session - may need manual intervention');
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

// Clear zombie guard when new track starts (called from track_started event handler)
function clearZombieSessionGuard() {
    if (zombieGuardTimer) {
        console.log('🛡️ Clearing zombie session guard - new track started');
        clearTimeout(zombieGuardTimer);
        zombieGuardTimer = null;
    }
    lastTrackStartTime = Date.now();
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
                // Use heartbeat system for manual refresh
                await sendNextTrack(null, null, 'manual_refresh');

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
    state.journeyMode = false;
    setupFzfSearch( function() { state.journeMode = true } );
});

// Check if stream endpoint is reachable
async function checkStreamEndpoint() {
    try {
        console.log('🔍 Checking stream endpoint connectivity...');

        const response = await fetch('/stream', {
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

        // Also check if we can create a session
        checkSessionStatus();
    }
}


