// HTML Helpers: page independent, some explorer state.
//  *) createTrackDetailCard
//  *) updateCardWithTrackDetails
//  *) createDirectionCard

  // tool-let to create all the styling for album covers
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

      // Server provides hasOpposite flag directly - no complex client-side detection needed
      const hasOpposite = direction.hasOpposite === true;
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
      const directionData = state.latestExplorerData.directions[direction.key];
      const oppositeKey = getOppositeDirection(direction.key);
      const oppositeExists = oppositeKey && state.latestExplorerData.directions[oppositeKey];

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

      console.log(`🎨 FINAL COLORS for ${direction.key}: border=${borderColor}, glow=${glowColor}${preserveColors ? ' (preserved)' : ' (calculated)'}`)

      // Apply the final colors
      card.style.setProperty('--border-color', borderColor);
      card.style.setProperty('--glow-color', glowColor);

      // ALSO update the data attributes to match
      card.dataset.borderColor = borderColor;
      card.dataset.glowColor = glowColor;

      console.log(`🎨 Applied colors: border=${borderColor}, glow=${glowColor}, reversed=${state.usingOppositeDirection}`);
      console.log(`🎨 Updated data attributes: data-border-color=${card.dataset.borderColor}, data-glow-color=${card.dataset.glowColor}`);

      // Also update rim based on reversed state
      const rim = card.querySelector('.rim');
      if (rim && state.usingOppositeDirection) {
          // Apply reversed rim gradient (inverted)
          const rimStyle = `conic-gradient(from 180deg, ${glowColor}, ${borderColor}, ${glowColor})`;
          console.log(`🔄 Setting reversed rim style: ${rimStyle}`);
          rim.style.background = rimStyle;
      } else if (rim && !state.usingOppositeDirection) {
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
          const variantClass = variantFromDirectionType(directionType);
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
              if (state.usingOppositeDirection) {
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
                         updateCardWithTrackDetails(card, track, dimensionToShow, true);
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


