// HTML Helpers: page independent, some explorer state.
//  *) utils
//  *) card details
//  *) createTrackDetailCard
//  *) updateCardWithTrackDetails
//  *) createDirectionCard

  // create all the styling for album covers
  const albumCoverBackground = (albumCover) =>
    `url('${albumCover}')`

  const photoStyle = (albumCover) =>
    `background: ${albumCoverBackground(albumCover)}; background-size: 120%; background-position-x: 45%`

  function getDisplayTitle(track) {
      return track.title ||
          (track.identifier ? `Track ${track.identifier.substring(0, 8)}...` : 'Unknown Track');
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
      card.dataset.trackMd5 = track.identifier;
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


  // Hide the direction key overlay
  function hideDirectionKeyOverlay() {
      const overlay = document.getElementById('directionKeyOverlay');
      if (overlay) {
          overlay.classList.add('hidden');
      }
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


  // Update card content with track details
  function updateCardWithTrackDetails(card, track, direction, preserveColors = false) {
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

          if (state.usingOppositeDirection) {
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


