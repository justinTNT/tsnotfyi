  // ====== Audio Streaming Setup ======

  // Global state like it's 1989!

  // Check for injected sessionId first (from MD5 route)
  let sessionId = window.sessionId;

  // Store latest explorer data for redrawing
  let latestExplorerData = null;

  // this one's just for metadata
  let latestCurrentTrack = null;

  // Simple reverse state: just track if current dimension is using opposite direction
  let usingOppositeDirection = false;


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
  const audio = document.getElementById('audio');
  const clickCatcher = document.getElementById('clickCatcher');
  const volumeControl = document.getElementById('volumeControl');
  const volumeBar = document.getElementById('volumeBar');
  const fullscreenProgress = document.getElementById('fullscreenProgress');
  const progressWipe = document.getElementById('progressWipe');

  audio.volume = 0.85;

  let isStarted = false;
  let progressAnimation = null;
  let selectedNextTrackSha = null; // Track which next track card is currently selected
  let currentDimensionTrackIndex = 0; // Track current index for the selected dimension

  // Heartbeat state (minimal - use latestCurrentTrack and latestExplorerData for actual data)
  let heartbeatTimeout = null;        // Timer for 60s heartbeat

  // ====== 3D Visualization Setup ======
  const SPARKLE_COUNT = 124;
  const NUM_LONG = 60;
  const NUM_LAT = 80;
  const NUM_LAT_OTHER = 69;
  const TUBE_RADIUS = 0.005;
  const PATH_RES = 123;
  const RADIAL_SEG = 53;
  const BASE_PULSE_HZ = 0.23;
  const SEL_PULSE_HZ = 1.23;

  let RADIUS_SCALE = 0.6;
  let RADIUS_SCALE_TARGET = 0.6;

  // Initialize renderer
  const mount = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 2000);
  makeCurves(scene);
  setUsefulBeams();

  let fuzzyCameraFactor = 1 + Math.random() * Math.random() / 3;
  let rejig = () => camera.position.set(-4 * fuzzyCameraFactor, 8 * fuzzyCameraFactor, -11 * fuzzyCameraFactor);
  rejig();

  const hemi = new THREE.HemisphereLight(0x66ccff, 0x080808, 0.5);
  scene.add(hemi);




  // ====== Force-Based Layout System ======
  class ForceLayoutManager {
      constructor(container) {
          this.container = container;
          this.simulation = null;
          this.nodes = [];
          // Position cards on the right side of screen, leaving left clear for current track
          this.centerX = window.innerWidth * 0.66; // 66% from left (right side)
          this.centerY = window.innerHeight / 2;    // Middle height

          // Layout parameters
          this.baseRadius = 100; // Slightly smaller base radius for tighter grouping
          this.centerForce = 80;  // Strength of center attraction
          this.repelForce = -200; // Less repulsion for tighter clustering
      }

      initializeSimulation() {
          this.simulation = d3.forceSimulation(this.nodes)
              .force('collision', d3.forceCollide().radius(d => d.radius).strength(0.8))
              .force('center', d3.forceCenter(this.centerX, this.centerY).strength(0.1))
              .force('charge', d3.forceManyBody().strength(this.repelForce))
              .force('radial', d3.forceRadial(200, this.centerX, this.centerY).strength(0.3))
              .alphaDecay(0.02) // Slow decay for smooth animation
              .on('tick', () => this.updateCardPositions());

          console.log('🔬 Force simulation initialized');
      }

      addCard(cardElement, cardData) {
          const isNextTrack = cardData.isNextTrack || false;
          const isSelected = cardData.isSelected || false;

          // Dynamic sizing based on card type and selection
          let radius, scale;
          if (isNextTrack && isSelected) {
              radius = this.baseRadius * 1.2; // Largest for selected next track
              scale = 1.0;
          } else if (isNextTrack) {
              radius = this.baseRadius * 1.0; // Medium for next track
              scale = 0.8;
          } else if (isSelected) {
              radius = this.baseRadius * 1.1; // Slightly larger for selected regular
              scale = 0.9;
          } else {
              radius = this.baseRadius * 0.7; // Smallest for regular cards
              scale = 0.5;
          }

          const node = {
              id: cardData.key || `card_${this.nodes.length}`,
              element: cardElement,
              radius: radius,
              scale: scale,
              isNextTrack: isNextTrack,
              isSelected: isSelected,
              // Initialize position near right-side center with some randomness
              x: this.centerX + (Math.random() - 0.5) * 150,
              y: this.centerY + (Math.random() - 0.5) * 150,
              vx: 0,
              vy: 0
          };

          this.nodes.push(node);

          // Apply initial styling with performance optimizations
          cardElement.style.transform = `translate(-50%, -50%) scale(${scale})`;
          cardElement.style.transition = 'transform 0.15s ease-out'; // Faster animation
          cardElement.style.position = 'absolute';
          cardElement.style.zIndex = isNextTrack ? '100' : '50';
          cardElement.style.willChange = 'transform'; // Optimize for transforms

          console.log(`🔬 Added ${isNextTrack ? 'NEXT' : 'REG'} card: ${node.id}, radius: ${radius}`);
          return node;
      }

      updateCardPositions() {
          this.nodes.forEach(node => {
              if (node.element && node.element.parentElement) {
                  // Convert simulation coordinates to percentages
                  const leftPercent = (node.x / window.innerWidth) * 100;
                  const topPercent = (node.y / window.innerHeight) * 100;

                  node.element.style.left = `${leftPercent}%`;
                  node.element.style.top = `${topPercent}%`;
                  node.element.style.transform = `translate(-50%, -50%) scale(${node.scale})`;
              }
          });
      }

      selectCard(cardId) {
          console.log(`🔬 Selecting card: ${cardId}`);

          this.nodes.forEach(node => {
              const wasSelected = node.isSelected;
              node.isSelected = (node.id === cardId);

              // Update radius and scale for selection change
              if (node.isSelected && !wasSelected) {
                  node.radius *= 1.2;
                  node.scale *= 1.1;
                  node.element.style.zIndex = '200'; // Bring to front
              } else if (!node.isSelected && wasSelected) {
                  node.radius /= 1.2;
                  node.scale /= 1.1;
                  node.element.style.zIndex = node.isNextTrack ? '100' : '50';
              }
          });

          // Restart simulation with higher alpha to animate the changes
          if (this.simulation) {
              this.simulation.alpha(0.5).restart();
          }
      }

      resizeContainer() {
          // Keep cards on right side after resize
          this.centerX = window.innerWidth * 0.75; // 75% from left (right side)
          this.centerY = window.innerHeight / 2;    // Middle height

          if (this.simulation) {
              this.simulation
                  .force('center', d3.forceCenter(this.centerX, this.centerY).strength(0.08))
                  .force('radial', d3.forceRadial(200, this.centerX, this.centerY).strength(0.3))
                  .alpha(0.3).restart();
          }
      }

      destroy() {
          if (this.simulation) {
              this.simulation.stop();
          }
          this.nodes = [];
      }
  }

  // Global force layout manager
  let forceLayout = null;

  // ====== UI Controls ======
  // Utility function to get displayable track title with fallback
  function getDisplayTitle(track) {
      return track.title ||
          (track.identifier ? `Track ${track.identifier.substring(0, 8)}...` : 'Unknown Track');
  }





  function updateNowPlayingCard(trackData, driftState) {
      latestCurrentTrack = trackData;

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
      photo.style.background= trackData.albumCover;

      // Randomly assign panel color variant
      const panel = document.querySelector('.panel');
      const variants = ['red-variant', 'green-variant', 'yellow-variant', 'blue-variant'];
      // Remove existing variants
      variants.forEach(v => panel.classList.remove(v));
      // Add random variant
      const randomVariant = variants[Math.floor(Math.random() * variants.length)];
      panel.classList.add(randomVariant);

      // Show card with zoom-in animation
      const card = document.getElementById('nowPlayingCard');
      card.classList.add('visible');

  }




  function createDimensionCards(explorerData) {
      // Store for later redraw
      latestExplorerData = explorerData;

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
      console.log(`🎯 Not setting global selectedNextTrackSha - each direction will use its own first track`);

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
          d.key.includes('entropy') ||
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
      if (!latestExplorerData) return;

      // Update the stored explorer data to track the new next direction
      latestExplorerData.nextTrack = {
          directionKey: newNextDirectionKey,
          direction: latestExplorerData.directions[newNextDirectionKey].direction,
          track: latestExplorerData.directions[newNextDirectionKey].sampleTracks[0]
      };

      // Remove ALL existing track detail cards (both old next track stacks and any other detail cards)
      document.querySelectorAll('.track-detail-card').forEach(card => card.remove());

      // Recreate the card stack for the new next direction immediately
      const container = document.getElementById('dimensionCards');
      const directions = Object.entries(latestExplorerData.directions).map(([key, directionInfo]) => ({
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
          const selectedTrackIndex = selectedNextTrackSha
              ? sampleTracks.findIndex(trackObj => {
                  const track = trackObj.track || trackObj;
                  return track.identifier === selectedNextTrackSha;
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
      const selectedTrackIndex = selectedNextTrackSha
          ? sampleTracks.findIndex(trackObj => {
              const track = trackObj.track || trackObj;
              return track.identifier === selectedNextTrackSha;
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


  // tool to create all the styling for album covers
  const photoStyle = (albumCover) =>
    `background: url('${albumCover}'); background-size: 120%; background-position-x: 45%`


  // Stack indicators are now implemented via CSS pseudo-elements

  function createTrackDetailCard(direction, track, positionIndex, totalDimensions, isSelected, trackIndex, totalTracks) {
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
      card.dataset.trackSha = track.identifier;
      card.dataset.trackIndex = trackIndex;

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
      function getPanelVariantFromDirectionType(directionType) {
          const variantMap = {
              rhythmic_core: 'red-variant',
              rhythmic_pca: 'red-variant',
              tonal_core: 'green-variant',
              tonal_pca: 'green-variant',
              spectral_core: 'blue-variant',
              spectral_pca: 'blue-variant',
              outlier: 'yellow-variant'
          };
          return variantMap[directionType] || 'yellow-variant';
      }
      const colorVariant = getPanelVariantFromDirectionType(directionType);


      // Track details
      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);

      // Server provides hasOpposite flag directly - no complex client-side detection needed
      const hasOpposite = direction.hasOpposite === true;
      const unoReverseHtml = hasOpposite && isSelected ? `
          <div class="uno-reverse next-track-reverse enabled">^</div>
      ` : '';

      card.innerHTML = `
          <div class="panel ${colorVariant}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <span class="rim"></span>
              <div class="bottom"></div>
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

          console.log(`🔄 Cycling stack for dimension: ${direction.key} from track index ${currentDimensionTrackIndex}`);
          cycleStackContents(direction.key, currentDimensionTrackIndex);
      });

      // Add click handler for Uno Reverse symbol if present
      if (hasOpposite && isSelected) {
          const unoReverse = card.querySelector('.uno-reverse.next-track-reverse');
          if (unoReverse) {
              unoReverse.addEventListener('click', (e) => {
                  e.stopPropagation(); // Prevent card click
                  console.log(`🔄 Swapping stack contents from ${direction.key} to opposite`);

                  const currentDirection = latestExplorerData.directions[direction.key];
                  if (currentDirection && currentDirection.oppositeDirection) {
                      // Temporarily add the opposite direction to SSE data for swapping
                      const oppositeKey = getOppositeDirection(direction.key);
                      if (oppositeKey) {
                          latestExplorerData.directions[oppositeKey] = {
                              ...currentDirection.oppositeDirection,
                              key: oppositeKey
                          };

                          // Swap stack contents immediately without animation
                          swapStackContents(direction.key, oppositeKey);
                      }
                  } else {
                      console.warn(`Opposite direction not available for ${direction.key}`);
                  }
              });
          }
      }

      return card;
  }

  function updateSelectedTrackInStack(directionKey, newSelectedIndex) {
      // Find all cards for this dimension
      const dimensionCards = document.querySelectorAll(`[data-direction-key="${directionKey}"]`);
      if (dimensionCards.length === 0) return;

      // Find the current selected card (the one with scale 1.0) and new selected track
      let currentSelectedCard = null;
      let newSelectedCard = null;

      dimensionCards.forEach(card => {
          const cardIndex = parseInt(card.dataset.trackIndex);
          if (card.style.transform.includes('scale(1)')) {
              currentSelectedCard = card;
          }
          if (cardIndex === newSelectedIndex) {
              newSelectedCard = card;
          }
      });

      if (!newSelectedCard || newSelectedCard === currentSelectedCard) return;

      // Simple content and visual swap
      const newTrackSha = newSelectedCard.dataset.trackSha;
      const currentTrackContent = currentSelectedCard.querySelector('.label').innerHTML;
      const newTrackContent = newSelectedCard.querySelector('.label').innerHTML;

      // Also swap the visual styling (photo background and panel colors)
      const currentPhoto = currentSelectedCard.querySelector('.photo');
      const newPhoto = newSelectedCard.querySelector('.photo');
      const currentPanel = currentSelectedCard.querySelector('.panel');
      const newPanel = newSelectedCard.querySelector('.panel');

      // Swap photo backgrounds
      const currentPhotoStyle = currentPhoto.style.background;
      const newPhotoStyle = newPhoto.style.background;

      // Swap panel color classes
      const currentPanelClasses = Array.from(currentPanel.classList);
      const newPanelClasses = Array.from(newPanel.classList);

      // Update the front card's content and styling
      currentSelectedCard.querySelector('.label').innerHTML = newTrackContent;
      currentSelectedCard.dataset.trackSha = newTrackSha;
      currentSelectedCard.dataset.trackIndex = newSelectedIndex;
      currentPhoto.style.background = newPhotoStyle;

      // Replace panel classes
      currentPanel.className = 'panel';
      newPanelClasses.forEach(cls => {
          if (cls !== 'panel') currentPanel.classList.add(cls);
      });

      // Update the clicked card to show what was previously selected
      newSelectedCard.querySelector('.label').innerHTML = currentTrackContent;
      newPhoto.style.background = currentPhotoStyle;
      newPanel.className = 'panel';
      currentPanelClasses.forEach(cls => {
          if (cls !== 'panel') newPanel.classList.add(cls);
      });
  }

  // Categorize direction into 7 distinct types for color coding
  function getDirectionType(directionKey) {
      // 7 categories: Core vs PCA for rhythmic/tonal/spectral, plus outliers
      if (directionKey.includes('rhythmic_pc') || (directionKey.includes('pc') && directionKey.includes('rhythmic'))) {
          return 'rhythmic_pca'; // Rhythmic PCA directions
      } else if (directionKey.includes('rhythmic') || directionKey.includes('bpm') || directionKey.includes('dance') || directionKey.includes('onset')) {
          return 'rhythmic_core'; // Core rhythmic features
      } else if (directionKey.includes('tonal_pc') || (directionKey.includes('pc') && directionKey.includes('tonal'))) {
          return 'tonal_pca'; // Tonal PCA directions
      } else if (directionKey.includes('tonal') || directionKey.includes('chord') || directionKey.includes('tuning') || directionKey.includes('fifths')) {
          return 'tonal_core'; // Core tonal features
      } else if (directionKey.includes('spectral_pc') || (directionKey.includes('pc') && directionKey.includes('spectral'))) {
          return 'spectral_pca'; // Spectral PCA directions
      } else if (directionKey.includes('spectral') || directionKey.includes('centroid') || directionKey.includes('rolloff') || directionKey.includes('flatness')) {
          return 'spectral_core'; // Core spectral features
      } else {
          return 'outlier'; // Outliers, entropy, crest, and miscellaneous
      }
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

          console.log(`A`);
      // Match panel variant to direction type colors (consistent with border/glow)
      function getPanelVariantFromDirectionType(directionType) {
          const variantMap = {
              rhythmic_core: 'red-variant',
              rhythmic_pca: 'red-variant',
              tonal_core: 'green-variant',
              tonal_pca: 'green-variant',
              spectral_core: 'blue-variant',
              spectral_pca: 'blue-variant',
              outlier: 'yellow-variant'
          };
          return variantMap[directionType] || 'yellow-variant';
      }
      const colorVariant = getPanelVariantFromDirectionType(directionType);
          console.log(`B`);


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
                  usingOppositeDirection = false; // Reset reverse flag when selecting new direction
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
                         console.log(`🔄 Cycling stack for ${direction.key}, current card shows ${currentCardDirection}, usingOppositeDirection = ${usingOppositeDirection}`);

                         // Determine which tracks to cycle through based on reverse flag
                         let tracksToUse, dimensionToShow;
                         if (usingOppositeDirection && direction.oppositeDirection?.sampleTracks) {
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
                         updateCardWithTrackDetails(card, track, dimensionToShow, true);
                      } else {
                          console.log(`🎬 Found existing next track: ${existingNextTrackCard.dataset.directionKey}, rotating to next clock position`);
                          rotateCenterCardToNextPosition(existingNextTrackCard.dataset.directionKey);
                          // Wait for the rotation animation to complete before starting the new one
                          setTimeout(() => {
                              usingOppositeDirection = false; // Reset reverse flag when selecting new direction
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


  // Swap the roles: make a direction the new next track stack, demote current next track to regular direction
  function swapNextTrackDirection(newNextDirectionKey) {
      if (!latestExplorerData || !latestExplorerData.directions[newNextDirectionKey]) {
          console.error('Cannot swap to direction:', newNextDirectionKey);
          return;
      }

      console.log(`🔄 Swapping next track direction from ${latestExplorerData.nextTrack?.directionKey} to ${newNextDirectionKey}`);

      // Get the first track from the new direction
      const newDirection = latestExplorerData.directions[newNextDirectionKey];
      const sampleTracks = newDirection.sampleTracks || [];
      const firstTrack = sampleTracks[0] ? (sampleTracks[0].track || sampleTracks[0]) : null;

      if (!firstTrack) {
          console.error('No tracks available in direction:', newNextDirectionKey);
          return;
      }

      // Update the global state
      selectedNextTrackSha = firstTrack.identifier;

      // Update latestExplorerData to reflect the new next track
      latestExplorerData.nextTrack = {
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
      if (!latestExplorerData.directions[directionKey]) return;

      const sampleTracks = latestExplorerData.directions[directionKey].sampleTracks || [];

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
      if (!latestExplorerData || !selectedNextTrackSha) return;
      console.log('🔄 Seamlessly updating selection:', selectedNextTrackSha);

      // Find the selected card first
      const allTrackCards = document.querySelectorAll('.dimension-card.track-detail-card.next-track');
      let selectedCard = null;
      let selectedDimensionKey = null;

      // First pass: identify the selected card
      allTrackCards.forEach(card => {
          if (card.dataset.trackSha === selectedNextTrackSha) {
              selectedCard = card;
              selectedDimensionKey = card.dataset.directionKey;
          }
      });

      if (!selectedCard) return;

      // Second pass: update all cards based on selection
      allTrackCards.forEach(card => {
          const cardTrackSha = card.dataset.trackSha;
          const directionKey = card.dataset.directionKey;
          const trackIndex = parseInt(card.dataset.trackIndex) || 0;
          const isSelectedCard = (cardTrackSha === selectedNextTrackSha);
          const isSameDimension = (directionKey === selectedDimensionKey);

          // Find the track data for this card
          const direction = latestExplorerData.directions[directionKey];
          const track = direction && direction.sampleTracks ?
              (direction.sampleTracks[trackIndex]?.track || direction.sampleTracks[trackIndex]) : null;
          if (!track) return;

          const labelDiv = card.querySelector('.label');
          if (!labelDiv) return;

          if (isSelectedCard) {
              // Update the top card content to show selected track
              card.classList.add('selected');

              // Show full track details
              const direction = latestExplorerData?.directions?.[directionKey];
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
      if (isStarted) return;

      // Immediately hide clickwall and show interface
      clickCatcher.classList.add('fadeOut');
      volumeControl.style.display = 'block';
      document.body.style.cursor = 'default';
      isStarted = true;

      // Remove clickwall completely after fade
      setTimeout(() => {
          clickCatcher.style.display = 'none';
      }, 800);

      // Set audio source and start playing
      console.log(`🎵 Setting audio source to: ${streamUrl}`);

      // Add error event listeners for better diagnostics
      audio.onerror = function(e) {
          console.error('🎵 Audio error event:', e);

          const mediaError = audio.error;
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
              networkState: audio.networkState,
              readyState: audio.readyState,
              src: audio.src,
              currentTime: audio.currentTime,
              duration: audio.duration
          });

          // Check if server is reachable
          checkStreamEndpoint();
      };

      audio.onloadstart = () => console.log('🎵 Load started');
      audio.oncanplay = () => console.log('🎵 Can play');
      audio.oncanplaythrough = () => console.log('🎵 Can play through');

      audio.src = streamUrl;
      audio.play().catch(e => {
          console.error('🎵 Play failed:', e);
          console.error('🎵 Audio state when play failed:', {
              error: audio.error,
              networkState: audio.networkState,
              readyState: audio.readyState,
              src: audio.src
          });
          // Keep interface visible even if audio fails
      });
  }

  // Click to start
  clickCatcher.addEventListener('click', startAudio);

  // Handle window resize for force layout
  window.addEventListener('resize', () => {
      if (forceLayout) {
          forceLayout.resizeContainer();
      }
  });

  // Keep manual start - do not auto-start
  audio.addEventListener('canplay', () => {
      if (isStarted) return;
      // User prefers manual click-to-start
  });

  // Volume control
  volumeControl.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = volumeControl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      const volume = Math.max(0, Math.min(1, percent));

      audio.volume = volume;
      volumeBar.style.width = (volume * 100) + '%';
  });

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
      if (!isStarted) return;

      switch (e.key) {
          case 'ArrowUp':
          case '+':
              audio.volume = Math.min(1, audio.volume + 0.1);
              volumeBar.style.width = (audio.volume * 100) + '%';
              e.preventDefault();
              break;
          case 'ArrowDown':
          case '-':
              audio.volume = Math.max(0, audio.volume - 0.1);
              volumeBar.style.width = (audio.volume * 100) + '%';
              e.preventDefault();
              break;
          case ' ':
              if (audio.paused) {
                  audio.play();
              } else {
                  audio.pause();
              }
              e.preventDefault();
              break;
          case 'Escape':
              // Seek behavior: halfway in first wipe, 5 secs before crossfade in second wipe
              // Since audio is streamed, requires server-side cooperation
              if (!audio || !audio.duration) {
                  console.log('🎮 ESC pressed but no audio duration available');
                  e.preventDefault();
                  break;
              }

              const currentTime = audio.currentTime;
              const totalDuration = audio.duration;
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

              // Smooth 250ms fade out before seek
              const originalVolume = audio.volume;
              const fadeSteps = 10;
              const fadeInterval = 250 / fadeSteps;
              let currentStep = 0;

              const fadeOut = setInterval(() => {
                  currentStep++;
                  audio.volume = originalVolume * (1 - currentStep / fadeSteps);

                  if (currentStep >= fadeSteps) {
                      clearInterval(fadeOut);

                      // Send seek request to server for streamed audio
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
                                      if (progressAnimation) {
                                          clearInterval(progressAnimation);
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

                                      // Fade back in after sync
                                      setTimeout(() => {
                                          let fadeStep = 0;
                                          const fadeIn = setInterval(() => {
                                              fadeStep++;
                                              audio.volume = originalVolume * (fadeStep / fadeSteps);

                                              if (fadeStep >= fadeSteps) {
                                                  clearInterval(fadeIn);
                                                  audio.volume = originalVolume;
                                              }
                                          }, fadeInterval);
                                      }, 50); // Shorter pause since SSE is faster
                                  }
                              };

                              // Add temporary listener for seek sync response
                              eventSource.addEventListener('message', handleSeekSync);

                              // Timeout fallback in case SSE doesn't respond
                              setTimeout(() => {
                                  eventSource.removeEventListener('message', handleSeekSync);
                                  if (audio.volume < originalVolume) {
                                      console.log('⚠️ SSE seek sync timeout - restoring audio');
                                      audio.volume = originalVolume;
                                  }
                              }, 2000);

                          } else {
                              console.error('❌ Server seek request failed');
                              audio.volume = originalVolume; // Restore volume on error
                          }
                      }).catch(err => {
                          console.error('❌ Seek request error:', err);
                          audio.volume = originalVolume; // Restore volume on error
                      });
                  }
              }, fadeInterval);

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
      if (progressAnimation) {
          clearInterval(progressAnimation);
      }

      // Reset progress and interaction state
      progressWipe.style.width = '0%';
      progressWipe.style.left = '0%';
      progressWipe.style.right = 'auto';
      fullscreenProgress.classList.add('active');
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

      progressAnimation = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const elapsedProgress = elapsed / remainingDuration;
          const progress = Math.min(initialProgress + elapsedProgress * (1 - initialProgress), 1);

          // Phase 1 (0-50%): Fix left edge, grow width (wipe on L→R) - BROWSING TIME
          // Phase 2 (50-100%): Fix right edge, shrink width (wipe off L→R) - LOCKED IN
          if (progress <= 0.5) {
              // Phase 1: Wipe on from left
              progressWipe.style.left = '0%';
              progressWipe.style.right = 'auto';
              progressWipe.style.width = (progress * 2 * 100) + '%'; // 0% to 100% in first half
          } else {
              // Phase 2: Wipe off from left (shrink from right edge)
              const phase2Progress = (progress - 0.5) * 2; // 0-1 for second half
              progressWipe.style.left = (phase2Progress * 100) + '%';
              progressWipe.style.right = 'auto';
              progressWipe.style.width = ((1 - phase2Progress) * 100) + '%'; // 100% to 0%

              // Trigger midpoint actions when crossing from phase 1 to phase 2
              if (!midpointReached) {
                  triggerMidpointActions();
                  midpointReached = true;
              }
          }

          // Stop when complete
          if (progress >= 1) {
              clearInterval(progressAnimation);
              progressAnimation = null;
              // Keep the progress bar visible until next track
          }
      }, 100); // Update every 100ms for smooth animation
  }

  function stopProgressAnimation() {
      if (progressAnimation) {
          clearInterval(progressAnimation);
          progressAnimation = null;
      }
      fullscreenProgress.classList.remove('active');
      progressWipe.style.width = '0%';
      progressWipe.style.left = '0%';
      progressWipe.style.right = 'auto';
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
      if (!latestExplorerData.directions[directionKey]) return;

      const sampleTracks = latestExplorerData.directions[directionKey].sampleTracks || [];
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
      currentDimensionTrackIndex = nextIndex;

      // Update selection
      selectedNextTrackSha = nextTrack.identifier;

      // Update server
      sendNextTrack(nextTrack.identifier, directionKey, 'user');

      // Refresh UI
      refreshCardsWithNewSelection();
  }

  // Swap stack contents between current and opposite direction
  function swapStackContents(currentDimensionKey, oppositeDimensionKey) {
      console.log(`🔄 swapStackContents called with ${currentDimensionKey} → ${oppositeDimensionKey}`);

      // Toggle the simple opposite direction flag
      usingOppositeDirection = !usingOppositeDirection;
      console.log(`🔄 Toggled reverse mode: now using opposite direction = ${usingOppositeDirection}`);

      // Reset track index when flipping to opposite direction
      currentDimensionTrackIndex = 0;
      console.log(`🔄 Reset track index to 0 for opposite direction`);

      // Redraw using the specific dimension we're working with, not the current playing track
      console.log(`🔄 About to call redrawNextTrackStack with currentDimensionKey: ${currentDimensionKey}`);
      redrawNextTrackStack(currentDimensionKey);
      console.log(`🔄 Finished calling redrawNextTrackStack`);
  }

  // Redraw the next track stack respecting the reverse flag
  function redrawNextTrackStack(specifiedDimensionKey = null) {
      if (!latestExplorerData?.nextTrack) return;

      const baseDimensionKey = specifiedDimensionKey || latestExplorerData.nextTrack.directionKey;
      let displayDimensionKey = baseDimensionKey;

      // Determine which direction data to use based on reverse state
      let displayDirection;

      if (usingOppositeDirection) {
          // Using opposite direction - find the opposite data
          const baseDirection = latestExplorerData.directions[baseDimensionKey];
          displayDimensionKey = getOppositeDirection(baseDimensionKey);

          console.log(`🔄 Current direction data:`, baseDirection);
          console.log(`🔄 Has oppositeDirection:`, !!baseDirection?.oppositeDirection);
          console.log(`🔄 Opposite key from getOppositeDirection:`, displayDimensionKey);
          console.log(`🔄 Opposite exists in directions:`, !!latestExplorerData.directions[displayDimensionKey]);

          // Try embedded opposite direction first, then fallback to directions lookup
          if (baseDirection?.oppositeDirection) {
              displayDirection = baseDirection.oppositeDirection;
              displayDimensionKey = baseDirection.oppositeDirection.key || displayDimensionKey;
              console.log(`🔄 Using embedded opposite direction data: ${displayDimensionKey}`);
          } else if (latestExplorerData.directions[displayDimensionKey]) {
              displayDirection = latestExplorerData.directions[displayDimensionKey];
              console.log(`🔄 Using directions lookup for opposite direction: ${displayDimensionKey}`);
          } else {
              console.error(`🔄 No opposite direction data available for ${baseDimensionKey}`);
              return;
          }
      } else {
          // Using original direction - but need to check if baseDimensionKey is actually the "primary" one
          displayDirection = latestExplorerData.directions[baseDimensionKey];

          // If the current baseDimensionKey doesn't exist in directions, it might be an opposite
          // that became the display direction, so we need to find its counterpart
          if (!displayDirection) {
              // Search all directions for one that has this key as oppositeDirection
              for (const [dirKey, dirData] of Object.entries(latestExplorerData.directions)) {
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

          for (const [mainKey, mainDirection] of Object.entries(latestExplorerData.directions)) {
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
                  available: Object.keys(latestExplorerData.directions || {}),
                  requested: baseDimensionKey,
                  searchedEmbedded: true
              });
              return;
          }
      }

      console.log(`🔄 Redrawing next track stack: base=${baseDimensionKey}, display=${displayDimensionKey}, reversed=${usingOppositeDirection}`);
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
          usingOppositeDirection,
          baseDimensionKey,
          displayDimensionKey,
          displayTracksCount: displayTracks.length,
          selectedTrack: trackToShow.title,
          selectedTrackId: trackToShow.identifier
      });

      // Reset track index and update selection when flipping to opposite stack
      currentDimensionTrackIndex = 0;
      selectedNextTrackSha = trackToShow.identifier;
      console.log(`🔄 Updated selection to first track of ${usingOppositeDirection ? 'OPPOSITE' : 'ORIGINAL'} stack (${displayDimensionKey}): ${trackToShow.title} (${trackToShow.identifier})`);

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
      currentDimensionTrackIndex = 0;
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

      if (!latestExplorerData?.directions[directionKey]) {
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

      const dimension = latestExplorerData.directions[directionKey];
      const directionType = getDirectionType(directionKey);

      // Get matching colors and variant
      const colors = getDirectionColor(directionType, directionKey);
      function getPanelVariantFromDirectionType(directionType) {
          const variantMap = {
              rhythmic_core: 'red-variant',
              rhythmic_pca: 'red-variant',
              tonal_core: 'green-variant',
              tonal_pca: 'green-variant',
              spectral_core: 'blue-variant',
              spectral_pca: 'blue-variant',
              outlier: 'yellow-variant'
          };
          return variantMap[directionType] || 'yellow-variant';
      }
      const colorVariant = getPanelVariantFromDirectionType(directionType);

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
      const directionName = dimension?.isOutlier ? "Outlier" : formatDirectionName(directionKey);
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
      console.log(`🔄 Latest explorer data:`, latestExplorerData);
      console.log(`🔄 Direction data:`, latestExplorerData?.directions[directionKey]);

      let directionData = latestExplorerData?.directions[directionKey];
      let actualDirectionKey = directionKey;

      if (!directionData) {
          // FALLBACK: Try the opposite direction if this direction doesn't exist in data
          const oppositeKey = getOppositeDirection(directionKey);
          console.log(`🔄 No data for ${directionKey}, trying opposite: ${oppositeKey}`);

          if (oppositeKey && latestExplorerData?.directions[oppositeKey]) {
              directionData = latestExplorerData.directions[oppositeKey];
              actualDirectionKey = oppositeKey;
              console.log(`🔄 Using opposite direction data: ${oppositeKey}`);
          } else {
              console.error(`🔄 No direction data found for ${directionKey} or its opposite ${oppositeKey}`);
              console.error(`🔄 Available directions:`, Object.keys(latestExplorerData?.directions || {}));
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

  // Update card content with track details
  function updateCardWithTrackDetails(card, track, direction, preserveColors = false) {
      console.log(`🎨 updateCardWithTrackDetails called`);
      console.log(`🎨 Card element:`, card);
      console.log(`🎨 Track data:`, track);
      console.log(`🎨 Dimension data:`, direction);
      console.log(`🎨 Updating card with track details: ${track?.title} by ${track?.artist}`);
      const duration = (track.duration || track.length) ?
          `${Math.floor((track.duration || track.length) / 60)}:${String(Math.floor((track.duration || track.length) % 60)).padStart(2, '0')}` :
          '??:??';

      const directionName = direction.isOutlier ? "Outlier" : formatDirectionName(direction.key);

      // Server provides hasOpposite flag directly
      const hasOpposite = direction.hasOpposite === true;

      // 🎯 DEBUG: Detailed reverse icon availability check
      const directionData = latestExplorerData.directions[direction.key];
      const oppositeKey = getOppositeDirection(direction.key);
      const oppositeExists = oppositeKey && latestExplorerData.directions[oppositeKey];

      console.log(`🔄 REVERSE ICON DEBUG for ${direction.key}:`, {
          hasOpposite: hasOpposite,
          hasOppositeFlag: directionData?.hasOpposite,
          oppositeDirection: directionData?.oppositeDirection ? 'present' : 'missing',
          calculatedOppositeKey: oppositeKey,
          oppositeExistsInDirections: oppositeExists,
          isOutlier: directionData?.isOutlier
      });
      const unoReverseHtml = hasOpposite ? `
          <div class="uno-reverse next-track-reverse enabled"></div>
      ` : '';
      console.log(`🔄 Generated unoReverseHtml:`, unoReverseHtml.trim());

      // Simple: if we're using opposite direction, show reverse visual feedback
      const isReversed = usingOppositeDirection;
      console.log(`🔄 Visual feedback: usingOppositeDirection=${usingOppositeDirection}, showing reversed state=${isReversed}`);

      // Always define directionType for later use
      const directionType = getDirectionType(direction.key);
      card.dataset.directionType = directionType;

      let borderColor, glowColor;

      if (preserveColors) {
          // When preserving colors (e.g., card promotion to center), use existing CSS custom properties
          console.log(`🎨 PRESERVE: Keeping existing colors for ${direction.key}`);
          const computedStyle = getComputedStyle(card);
          borderColor = computedStyle.getPropertyValue('--border-color').trim() ||
                       card.style.getPropertyValue('--border-color').trim();
          glowColor = computedStyle.getPropertyValue('--glow-color').trim() ||
                     card.style.getPropertyValue('--glow-color').trim();

          // Fallback: if no existing colors, calculate fresh ones
          if (!borderColor || !glowColor) {
              console.log(`🎨 PRESERVE FALLBACK: No existing colors found, calculating fresh ones`);
              const freshColors = getDirectionColor(directionType, direction.key);
              borderColor = borderColor || freshColors.border;
              glowColor = glowColor || freshColors.glow;
          }
      } else {
          // SIMPLIFIED COLOR CALCULATION: Always calculate fresh colors from dimension

          if (usingOppositeDirection) {
              // In reverse mode, get analogous complementary colors for the current dimension
              console.log(`🎨 REVERSE: Calculating reverse colors for ${direction.key} (${directionType})`);
              const reverseColors = getDirectionColor(directionType, direction.key + '_force_negative');
              borderColor = reverseColors.border;
              glowColor = reverseColors.glow;
          } else {
              // Normal mode: get primary colors for the current dimension
              console.log(`🎨 NORMAL: Calculating primary colors for ${direction.key} (${directionType})`);
              const primaryColors = getDirectionColor(directionType, direction.key + '_force_primary');
              borderColor = primaryColors.border;
              glowColor = primaryColors.glow;
          }
      }

      console.log(`🎨 FINAL COLORS for ${direction.key}: border=${borderColor}, glow=${glowColor}${preserveColors ? ' (preserved)' : ' (calculated)'}`)

      // Apply the final colors
      card.style.setProperty('--border-color', borderColor);
      card.style.setProperty('--glow-color', glowColor);

      // ALSO update the data attributes to match
      card.dataset.borderColor = borderColor;
      card.dataset.glowColor = glowColor;

      console.log(`🎨 Applied colors: border=${borderColor}, glow=${glowColor}, reversed=${isReversed}`);
      console.log(`🎨 Updated data attributes: data-border-color=${card.dataset.borderColor}, data-glow-color=${card.dataset.glowColor}`);

      // Also update rim based on reversed state
      const rim = card.querySelector('.rim');
      if (rim && isReversed) {
          // Apply reversed rim gradient (inverted)
          const rimStyle = `conic-gradient(from 180deg, ${glowColor}, ${borderColor}, ${glowColor})`;
          console.log(`🔄 Setting reversed rim style: ${rimStyle}`);
          rim.style.background = rimStyle;
      } else if (rim && !isReversed) {
          // Apply normal rim gradient based on direction type
          const isNegative = isNegativeDirection(direction.key);
          if (isNegative) {
              rim.style.background = `conic-gradient(from 180deg, ${glowColor}, ${borderColor}, ${glowColor})`;
          } else {
              rim.style.background = `conic-gradient(${borderColor}, ${glowColor}, ${borderColor})`;
          }
          console.log(`🔄 Setting original rim style for ${direction.key}`);
      }

      // Preserve existing panel classes (color variants)
      const existingPanel = card.querySelector('.panel');
      let panelClasses = 'panel';
      if (existingPanel) {
          panelClasses = existingPanel.className;
          console.log(`🎨 Preserving existing panel classes: ${panelClasses}`);
      } else {
          // Generate panel class from direction type if no existing panel
          const variantClass = getPanelVariantFromDirectionType(directionType);
          panelClasses = `panel ${variantClass}`;
          console.log(`🎨 Generated new panel classes: ${panelClasses}`);
      }

      const newHTML = `
          <div class="${panelClasses}">
              <div class="photo" style="${photoStyle(track.albumCover)}"></div>
              <div class="rim"></div>
              <div class="bottom"></div>
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

      console.log(`🎨 Setting card innerHTML to:`, newHTML);
      card.innerHTML = newHTML;
      console.log(`🎨 Card innerHTML updated successfully`);

      console.log(`🎨 Preserved ${directionType} colors in metadata upgrade: ${direction.key} (${borderColor}, ${glowColor})`);

      // Add click handler for Uno Reverse if present
      if (hasOpposite) {
          const unoReverse = card.querySelector('.uno-reverse.next-track-reverse');

          // Set reversed icon state and rim direction
          if (unoReverse) {
              console.log(`🔄 About to set visual feedback: isReversed=${isReversed}, usingOppositeDirection=${usingOppositeDirection}`);
              if (isReversed) {
                  unoReverse.classList.add('reversed');
                  card.classList.add('negative-direction'); // Flip rim mask
                  console.log(`🔄 Added reversed class and negative-direction class for ${direction.key}`);
              } else {
                  unoReverse.classList.remove('reversed');
                  card.classList.remove('negative-direction'); // Reset rim mask
                  console.log(`🔄 Removed reversed class and negative-direction class for ${direction.key}`);
              }

              unoReverse.addEventListener('click', (e) => {
                  e.stopPropagation();
                  console.log(`🔄 Reverse icon clicked for ${direction.key}`);

                  const oppositeKey = getOppositeDirection(direction.key);
                  console.log(`🔄 Opposite key found: ${oppositeKey}`);
                  if (oppositeKey) {
                      console.log(`🔄 About to call swapStackContents(${direction.key}, ${oppositeKey})`);
                      swapStackContents(direction.key, oppositeKey);
                  } else {
                      console.warn(`No opposite direction found for ${direction.key}`);
                  }
              });
          }


      }

      // Ensure card's data-direction-key matches the actual direction being displayed
      card.dataset.directionKey = direction.key;

      // Update stack size indicator for next track stacks
      if (card.classList.contains('next-track')) {
          updateStackSizeIndicator(direction);
          updateDirectionKeyOverlay(direction);
      } else {
          // Hide indicator if not a next track stack
          hideStackSizeIndicator();
          hideDirectionKeyOverlay();
      }
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
      text1.textContent = JSON.stringify(latestCurrentTrack, null, 2);
      console.dir({got: text1.textContent, from: latestCurrentTrack});
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
  audio.addEventListener('error', () => {
      setTimeout(() => {
          audio.load();
          if (isStarted) audio.play().catch(() => {});
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
    if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
    }

    // Use existing data if not provided (heartbeat/refresh case)
    const md5ToSend = trackMd5 || latestExplorerData?.nextTrack?.track?.identifier || selectedNextTrackSha;
    const dirToSend = direction || latestExplorerData?.nextTrack?.directionKey;

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
        analyzeAndAct(data, source);

    } catch (error) {
        console.error('❌ sendNextTrack failed:', error);
        // Set shorter retry timeout
        scheduleHeartbeat(10000); // Retry in 10s
    }
}

function analyzeAndAct(data, source) {
    const { nextTrack, currentTrack, duration, remaining } = data;

    if (!data || !currentTrack) {
        console.warn('⚠️ Invalid server response');
        scheduleHeartbeat(60000);
        return;
    }

    // Check 1: Current track MD5 mismatch
    const currentMd5 = latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        console.log(`🔄 CURRENT TRACK MISMATCH! Expected ${currentMd5?.substring(0,8)}, got ${currentTrack?.substring(0,8)}`);
        fullResync();
        return;
    }

    // Check 2: Next track MD5 mismatch
    const expectedNextMd5 = latestExplorerData?.nextTrack?.track?.identifier || selectedNextTrackSha;
    const nextTrackMismatch = expectedNextMd5 && nextTrack !== expectedNextMd5;

    if (nextTrackMismatch) {
        console.log(`🔄 NEXT TRACK MISMATCH! Expected ${expectedNextMd5?.substring(0,8)}, got ${nextTrack?.substring(0,8)}`);

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
    if (!latestExplorerData || !latestExplorerData.directions) {
        return false;
    }

    // Search through all directions' sample tracks
    for (const [dirKey, direction] of Object.entries(latestExplorerData.directions)) {
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
    if (!latestExplorerData || !latestExplorerData.directions) {
        console.warn('⚠️ No explorer data to promote track from');
        return;
    }

    // Find which direction contains this track
    let foundDirection = null;
    let foundTrack = null;

    for (const [dirKey, direction] of Object.entries(latestExplorerData.directions)) {
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
    selectedNextTrackSha = trackMd5;
}

function scheduleHeartbeat(delayMs = 60000) {
    if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
    }

    heartbeatTimeout = setTimeout(() => {
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
document.addEventListener('DOMContentLoaded', setupManualRefreshButton);


// ====== Fuzzy Search (fzf) Interface ======

let fzfState = {
    isVisible: false,
    currentResults: [],
    selectedIndex: 0,
    searchTimeout: null
};

// Set up fuzzy search interface
function setupFzfSearch() {
    const fzfSearch = document.getElementById('fzfSearch');
    const fzfInput = document.getElementById('fzfInput');
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfSearch || !fzfInput || !fzfResults) {
        console.warn('🔍 Fuzzy search elements not found in DOM');
        return;
    }

    // Global keyboard shortcut to open fzf (Ctrl+K or Cmd+K)
    document.addEventListener('keydown', (e) => {
        // Open fzf with Ctrl+K or Cmd+K
        if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !fzfState.isVisible) {
            e.preventDefault();
            openFzfSearch();
        }

        // Close fzf with Escape
        if (e.key === 'Escape' && fzfState.isVisible) {
            e.preventDefault();
            closeFzfSearch();
        }
    });

    // Input event listener for real-time search
    fzfInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();

        // Clear previous timeout
        if (fzfState.searchTimeout) {
            clearTimeout(fzfState.searchTimeout);
        }

        // Debounce search requests
        fzfState.searchTimeout = setTimeout(() => {
            if (query.length >= 2) {
                performFzfSearch(query);
            } else {
                clearFzfResults();
            }
        }, 300);
    });

    // Keyboard navigation in fzf
    fzfInput.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                navigateFzf(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                navigateFzf(-1);
                break;
            case 'Enter':
                e.preventDefault();
                selectFzfResult();
                break;
            case 'Escape':
                e.preventDefault();
                closeFzfSearch();
                break;
        }
    });

    // Click outside to close
    fzfSearch.addEventListener('click', (e) => {
        if (e.target === fzfSearch) {
            closeFzfSearch();
        }
    });

    console.log('🔍 Fuzzy search interface set up (Ctrl+K to open)');

    // Set up search icon click handler
    const searchIcon = document.getElementById('searchIcon');
    if (searchIcon) {
        searchIcon.addEventListener('click', () => {
            if (!fzfState.isVisible) {
                openFzfSearch();
            }
        });
        console.log('🔍 Search icon click handler set up');
    }
}

// Open fuzzy search interface
function openFzfSearch() {
    const fzfSearch = document.getElementById('fzfSearch');
    const fzfInput = document.getElementById('fzfInput');

    if (fzfSearch && fzfInput) {
        fzfState.isVisible = true;
        fzfSearch.classList.remove('hidden');

        // Focus input and clear previous search
        fzfInput.value = '';
        fzfInput.focus();

        clearFzfResults();

        console.log('🔍 Opened fuzzy search interface');
    }
}

// Close fuzzy search interface
function closeFzfSearch() {
    const fzfSearch = document.getElementById('fzfSearch');

    if (fzfSearch) {
        fzfState.isVisible = false;
        fzfSearch.classList.add('hidden');

        // Clear search state
        fzfState.currentResults = [];
        fzfState.selectedIndex = 0;

        if (fzfState.searchTimeout) {
            clearTimeout(fzfState.searchTimeout);
            fzfState.searchTimeout = null;
        }

        console.log('🔍 Closed fuzzy search interface');
    }
}

// Perform fuzzy search request
async function performFzfSearch(query) {
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfResults) return;

    // Show loading state
    fzfResults.innerHTML = '<div class="fzf-loading">Searching...</div>';

    try {
        console.log(`🔍 Searching for: "${query}"`);

        const response = await fetch(`/search?q=${encodeURIComponent(query)}&limit=20`);

        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();

        console.log(`🔍 Found ${data.results.length} results for "${query}"`);

        fzfState.currentResults = data.results;
        fzfState.selectedIndex = 0;

        renderFzfResults();

    } catch (error) {
        console.error('🔍 Search error:', error);
        fzfResults.innerHTML = '<div class="fzf-no-results">Search failed. Please try again.</div>';
    }
}

// Render search results
function renderFzfResults() {
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfResults) return;

    if (fzfState.currentResults.length === 0) {
        fzfResults.innerHTML = '<div class="fzf-no-results">No tracks found</div>';
        return;
    }

    const resultsHtml = fzfState.currentResults.map((result, index) => {
        const isSelected = index === fzfState.selectedIndex;
        const selectedClass = isSelected ? 'selected' : '';

        return `
            <div class="fzf-result-item ${selectedClass}" data-index="${index}">
                <div class="fzf-result-primary">${result.displayText || `${result.artist} - ${result.title}`}</div>
                <div class="fzf-result-secondary">${result.album || ''} ${result.year ? `(${result.year})` : ''}</div>
                <div class="fzf-result-meta">${result.identifier}</div>
            </div>
        `;
    }).join('');

    fzfResults.innerHTML = resultsHtml;

    // Add click handlers to results
    fzfResults.querySelectorAll('.fzf-result-item').forEach((item, index) => {
        item.addEventListener('click', () => {
            fzfState.selectedIndex = index;
            selectFzfResult();
        });
    });

    // Scroll selected item into view
    scrollSelectedIntoView();
}

// Navigate through search results
function navigateFzf(direction) {
    if (fzfState.currentResults.length === 0) return;

    fzfState.selectedIndex += direction;

    // Wrap around
    if (fzfState.selectedIndex < 0) {
        fzfState.selectedIndex = fzfState.currentResults.length - 1;
    } else if (fzfState.selectedIndex >= fzfState.currentResults.length) {
        fzfState.selectedIndex = 0;
    }

    // Update visual selection
    const fzfResults = document.getElementById('fzfResults');
    if (fzfResults) {
        fzfResults.querySelectorAll('.fzf-result-item').forEach((item, index) => {
            item.classList.toggle('selected', index === fzfState.selectedIndex);
        });

        scrollSelectedIntoView();
    }
}

// Scroll selected item into view
function scrollSelectedIntoView() {
    const selectedItem = document.querySelector('.fzf-result-item.selected');
    if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

// Select current result and jump to track
function selectFzfResult() {
    if (fzfState.currentResults.length === 0 || fzfState.selectedIndex < 0) return;

    const selectedResult = fzfState.currentResults[fzfState.selectedIndex];

    if (selectedResult) {
        console.log(`🔍 Selected track: ${selectedResult.displayText} (${selectedResult.identifier})`);

        // Jump to this track (use the SHA endpoint)
        jumpToTrack(selectedResult.identifier);

        // Close fzf interface
        closeFzfSearch();
    }
}

// Jump to a specific track by SHA
async function jumpToTrack(trackSha) {
    try {
        console.log(`🎯 Jumping to track: ${trackSha}`);

        // Navigate to the track using the existing SHA endpoint
        window.location.href = `/${trackSha}`;

    } catch (error) {
        console.error('🎯 Failed to jump to track:', error);
    }
}

// Clear search results
function clearFzfResults() {
    const fzfResults = document.getElementById('fzfResults');
    if (fzfResults) {
        fzfResults.innerHTML = '<div class="fzf-no-results">...</div>';
    }

    fzfState.currentResults = [];
    fzfState.selectedIndex = 0;
}

// Initialize fuzzy search when page loads
document.addEventListener('DOMContentLoaded', setupFzfSearch);

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

