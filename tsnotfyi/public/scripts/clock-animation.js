// Clock animation - track change animations
// Dependencies: globals.js (state, elements)

import { createLogger } from './log.js';
const log = createLogger('deck');

// Animation state
let animationInProgress = false;
let packAwayTimer = null;
let triggerTimeoutId = null;

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

    log.info('🔄 Starting track change animation');

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

        log.info('🔄 Track change animation complete');
        onComplete?.();
    }, 600);
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.cancelPackAwayAnimation = cancelPackAwayAnimation;
    window.animateTrackChange = animateTrackChange;
}
