// Clock animation - pack-away and zoom-out animations
// Handles visual transitions when track nears end
// Dependencies: globals.js (state, elements), playlist-tray.js

import { state, elements } from './globals.js';
import { playlistHasItems, addToPlaylist, renderPlaylistTray } from './playlist-tray.js';

// Animation state
let animationInProgress = false;
let packAwayTimer = null;
let triggerTimeoutId = null;

// Animation timing constants
const CARD_STACK_DURATION = 800;    // Cards slide behind next-track card
const CLOCK_ZOOM_DURATION = 4200;   // Clock zooms out along ellipsoidal arc
const COVER_SLIDE_DURATION = 1200;  // Album cover slides to tray
const TOTAL_ANIMATION_DURATION = 5000;
const TRIGGER_SECONDS_REMAINING = 30; // t-30s trigger point

/**
 * Calculate ellipsoidal arc position for clock zoom-out
 * @param {number} progress - Animation progress 0-1
 * @returns {Object} {x, y, z, scale, opacity}
 */
function calculateArcPosition(progress) {
    // Upper-left-back trajectory
    const theta = -Math.PI / 2 + progress * Math.PI * 0.6; // -90 to ~18
    const phi = progress * Math.PI * 0.3; // tilt back

    const x = 50 + 45 * Math.cos(theta); // % from center
    const y = 50 + 35 * Math.sin(theta); // % from center
    const z = -800 - progress * 1500;    // depth into screen
    const scale = 1 - progress * 0.9;

    // Opacity fades in last 0.5s (last ~12% of animation)
    const fadeStart = 0.88;
    const opacity = progress < fadeStart ? 1 : 1 - (progress - fadeStart) / (1 - fadeStart);

    return { x, y, z, scale, opacity };
}

/**
 * Trigger pack-away animation
 * Called at t-30s when playlist is empty, or manually via shrinkwrap click
 */
export function triggerPackAwayAnimation() {
    if (animationInProgress) {
        console.log('Pack-away animation already in progress');
        return;
    }

    console.log('Starting pack-away animation');
    animationInProgress = true;

    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    const nowPlayingCard = document.getElementById('nowPlayingCard');
    const nextTrackCard = deckContainer?.querySelector('.dimension-card.next-track');
    const clockElement = document.getElementById('playbackClock');

    if (!deckContainer) {
        console.warn('No deck container found for pack-away animation');
        animationInProgress = false;
        return;
    }

    // Get current next track info for tray
    const nextTrack = state.latestExplorerData?.nextTrack?.track ||
                      state.previousNextTrack ||
                      state.pendingLiveTrackCandidate?.track;

    // Phase 1: Cards stack behind next-track card (0.8s)
    animateCardsStack(deckContainer, nextTrackCard, () => {
        // Phase 2: Parallel animations - clock zoom + album cover slide (4.2s)
        const clockZoomPromise = animateClockZoomOut(clockElement, nowPlayingCard, deckContainer);
        const coverSlidePromise = animateAlbumCoverSlide(nextTrackCard, nextTrack);

        Promise.all([clockZoomPromise, coverSlidePromise]).then(() => {
            // Animation complete
            animationInProgress = false;
            console.log('Pack-away animation complete');

            // Clear deck and clock elements
            if (deckContainer) {
                deckContainer.innerHTML = '';
                deckContainer.style.opacity = '';
                deckContainer.style.transform = '';
            }

            // Add next track to playlist queue if available
            if (nextTrack) {
                addToPlaylist({
                    trackId: nextTrack.identifier || nextTrack.trackMd5,
                    albumCover: nextTrack.albumCover,
                    title: nextTrack.title,
                    artist: nextTrack.artist,
                    directionKey: state.latestExplorerData?.nextTrack?.directionKey,
                    explorerData: state.latestExplorerData
                });
            }
        });
    });
}

/**
 * Animate cards stacking behind the next-track card
 */
function animateCardsStack(deckContainer, nextTrackCard, onComplete) {
    const cards = Array.from(deckContainer.querySelectorAll('.dimension-card'));
    const otherCards = cards.filter(c => c !== nextTrackCard);

    if (otherCards.length === 0) {
        onComplete?.();
        return;
    }

    // Get center position (where cards should stack)
    const centerRect = nextTrackCard?.getBoundingClientRect() || {
        left: window.innerWidth / 2 - 100,
        top: window.innerHeight / 2 - 100
    };

    otherCards.forEach((card, index) => {
        const cardRect = card.getBoundingClientRect();
        const dx = centerRect.left - cardRect.left;
        const dy = centerRect.top - cardRect.top;

        card.style.transition = `transform ${CARD_STACK_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${CARD_STACK_DURATION}ms ease`;
        card.style.zIndex = String(100 - index);

        requestAnimationFrame(() => {
            card.style.transform = `translate(${dx}px, ${dy}px) scale(0.8)`;
            card.style.opacity = '0';
        });
    });

    setTimeout(onComplete, CARD_STACK_DURATION);
}

/**
 * Animate clock and remaining cards zooming out along ellipsoidal arc
 */
function animateClockZoomOut(clockElement, nowPlayingCard, deckContainer) {
    return new Promise((resolve) => {
        const startTime = performance.now();

        // Elements to animate
        const elementsToAnimate = [clockElement, nowPlayingCard, deckContainer].filter(Boolean);

        if (elementsToAnimate.length === 0) {
            resolve();
            return;
        }

        // Store original styles
        const originalStyles = elementsToAnimate.map(el => ({
            element: el,
            transform: el.style.transform,
            opacity: el.style.opacity,
            transition: el.style.transition
        }));

        // Set up for animation
        elementsToAnimate.forEach(el => {
            el.style.transition = 'none';
            el.style.transformOrigin = 'center center';
        });

        function animate() {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(1, elapsed / CLOCK_ZOOM_DURATION);
            const eased = easeOutCubic(progress);

            const pos = calculateArcPosition(eased);

            // Apply transform to each element
            elementsToAnimate.forEach(el => {
                el.style.transform = `
                    translate(${(pos.x - 50) * 2}vw, ${(pos.y - 50) * 2}vh)
                    scale(${pos.scale})
                `;
                el.style.opacity = String(pos.opacity);
            });

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Animation complete - hide elements
                elementsToAnimate.forEach(el => {
                    el.style.opacity = '0';
                    el.style.visibility = 'hidden';
                });
                resolve();
            }
        }

        requestAnimationFrame(animate);
    });
}

/**
 * Animate album cover sliding from center to tray position
 */
function animateAlbumCoverSlide(nextTrackCard, nextTrack) {
    return new Promise((resolve) => {
        if (!nextTrack?.albumCover) {
            resolve();
            return;
        }

        // Create clone of album cover
        const coverClone = document.createElement('div');
        coverClone.className = 'album-cover-slide-clone';
        const escapedCover = nextTrack.albumCover.replace(/'/g, "\\'");
        coverClone.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            width: 200px;
            height: 200px;
            background-image: url('${escapedCover}');
            background-size: cover;
            background-position: center;
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
            transform: translate(-50%, -50%);
            z-index: 250;
            pointer-events: none;
            transition: all ${COVER_SLIDE_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1);
        `;
        document.body.appendChild(coverClone);

        // Get tray target position (left stack, top of pile)
        const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
        const leftStack = trayRoot?.querySelector('.playlist-left-stack');
        const targetRect = leftStack?.getBoundingClientRect() || {
            left: window.innerWidth * 0.25 - 40,
            top: window.innerHeight * 0.7
        };

        // Trigger animation on next frame
        requestAnimationFrame(() => {
            coverClone.style.transform = `translate(${targetRect.left - window.innerWidth / 2 + 50}px, ${targetRect.top - window.innerHeight / 2 + 50}px)`;
            coverClone.style.width = '100px';
            coverClone.style.height = '100px';
        });

        setTimeout(() => {
            coverClone.remove();
            renderPlaylistTray();
            resolve();
        }, COVER_SLIDE_DURATION);
    });
}

/**
 * Easing function - cubic ease out
 */
function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

// Track if we've already reaffirmed for this track
let lastReaffirmTrackId = null;

/**
 * Check if pack-away animation should be triggered
 * Called from progress animation tick
 * @param {number} remainingSeconds - Seconds remaining in track
 */
export function checkPackAwayTrigger(remainingSeconds) {
    // Trigger at t-30s
    if (remainingSeconds <= TRIGGER_SECONDS_REMAINING && remainingSeconds > (TRIGGER_SECONDS_REMAINING - 1)) {
        // Reaffirm next track to server (once per track)
        const currentTrackId = state.latestCurrentTrack?.identifier;
        if (currentTrackId && currentTrackId !== lastReaffirmTrackId) {
            lastReaffirmTrackId = currentTrackId;
            reaffirmNextTrack();
        }

        // Only trigger pack-away animation if playlist is empty
        if (!playlistHasItems() && !animationInProgress) {
            triggerPackAwayAnimation();
        }
    }
}

/**
 * Reaffirm next track to server when track nears end
 * Uses playlist head if available, otherwise explorer suggestion
 */
function reaffirmNextTrack() {
    const playlistNext = typeof window.getPlaylistNext === 'function' ? window.getPlaylistNext() : null;

    let trackId, directionKey;

    if (playlistNext) {
        // Use playlist head
        trackId = playlistNext.trackId;
        directionKey = playlistNext.directionKey;
        console.log(`🎯 Track ending: reaffirming playlist head ${trackId?.substring(0, 8)}`);
    } else {
        // Use explorer suggestion
        const explorerNext = state.latestExplorerData?.nextTrack;
        trackId = explorerNext?.track?.identifier || explorerNext?.identifier || state.selectedIdentifier;
        directionKey = explorerNext?.directionKey || state.manualNextDirectionKey;
        console.log(`🎯 Track ending: reaffirming explorer suggestion ${trackId?.substring(0, 8)}`);
    }

    if (trackId && typeof window.sendNextTrack === 'function') {
        window.sendNextTrack(trackId, directionKey, 'user');
    }
}

/**
 * Cancel any pending pack-away animation
 */
export function cancelPackAwayAnimation() {
    if (packAwayTimer) {
        clearTimeout(packAwayTimer);
        packAwayTimer = null;
    }
    if (triggerTimeoutId) {
        clearTimeout(triggerTimeoutId);
        triggerTimeoutId = null;
    }
    animationInProgress = false;
}

/**
 * Check if animation is currently in progress
 */
export function isPackAwayInProgress() {
    return animationInProgress;
}

/**
 * Animate track change - fast zoom out for old content, then allow new content
 * Different from pack-away: faster, no tray animation, immediate replacement
 * @param {Function} onMidpoint - Called at animation midpoint (update now-playing card)
 * @param {Function} onComplete - Called when animation finishes (render new cards)
 */
export function animateTrackChange(onMidpoint, onComplete) {
    const deckContainer = document.getElementById('dimensionCards');
    const clockElement = document.getElementById('playbackClock');

    // If no deck container or already animating pack-away, skip animation
    if (!deckContainer || animationInProgress) {
        onMidpoint?.();
        onComplete?.();
        return;
    }

    console.log('🔄 Starting track change animation');

    // Collect elements to animate
    const elementsToAnimate = [deckContainer, clockElement].filter(Boolean);

    if (elementsToAnimate.length === 0) {
        onMidpoint?.();
        onComplete?.();
        return;
    }

    // Store original styles for restoration
    const originalStyles = elementsToAnimate.map(el => ({
        element: el,
        transform: el.style.transform,
        opacity: el.style.opacity,
        transition: el.style.transition,
        visibility: el.style.visibility
    }));

    // Apply zoom-out animation
    elementsToAnimate.forEach(el => {
        el.style.transition = 'transform 600ms ease-in, opacity 600ms ease-in';
        el.style.transform = 'translateZ(-800px) scale(0.3)';
        el.style.opacity = '0';
    });

    // Midpoint: update now-playing card while old cards still animating out
    setTimeout(() => {
        onMidpoint?.();
    }, 300);

    // Complete: clear old content and restore styles for new content
    setTimeout(() => {
        // Clear deck container
        if (deckContainer) {
            deckContainer.innerHTML = '';
        }

        // Restore styles so new cards render normally
        originalStyles.forEach(({ element, transform, opacity, transition, visibility }) => {
            element.style.transition = '';
            element.style.transform = transform || '';
            element.style.opacity = opacity || '';
            element.style.visibility = visibility || '';
        });

        console.log('🔄 Track change animation complete');
        onComplete?.();
    }, 600);
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.triggerPackAwayAnimation = triggerPackAwayAnimation;
    window.checkPackAwayTrigger = checkPackAwayTrigger;
    window.cancelPackAwayAnimation = cancelPackAwayAnimation;
    window.isPackAwayInProgress = isPackAwayInProgress;
    window.animateTrackChange = animateTrackChange;
}
