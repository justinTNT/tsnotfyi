// Card dormant state management
// Handles visual states for when cards should be de-emphasized
// Dependencies: globals.js (state, elements)

import { state, elements } from './globals.js';

// No-op stub for backward compatibility - danger zone visual state no longer exists

// Exit cards dormant state
export function exitCardsDormantState({ immediate = false } = {}) {
    if (state.cardsDormant) {
        const container = elements.dimensionCards || document.getElementById('dimensionCards');
        if (container) {
            container.classList.remove('cards-dormant');
            elements.dimensionCards = container;
        }
    }
    state.cardsDormant = false;
    if (typeof window.hideNextTrackPreview === 'function') {
        window.hideNextTrackPreview({ immediate });
    }
}

// Safely exit cards dormant state (wrapper for compatibility)
export function safelyExitCardsDormantState(options = {}) {
    exitCardsDormantState(options);
}

// Ensure deck is hydrated after track change
export function ensureDeckHydratedAfterTrackChange(reason = 'unknown') {
    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    if (deckContainer && deckContainer.querySelector('.dimension-card')) {
        return;
    }
    const payload = state.latestExplorerData;
    if (payload && typeof window.createDimensionCards === 'function') {
        console.log(`🔄 Hydrating deck after track change (reason: ${reason})`);
        window.createDimensionCards(payload, { skipExitAnimation: true, forceRedraw: true });
    }
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.safelyExitCardsDormantState = safelyExitCardsDormantState;
    window.ensureDeckHydratedAfterTrackChange = ensureDeckHydratedAfterTrackChange;
    window.exitCardsDormantState = exitCardsDormantState;
}
