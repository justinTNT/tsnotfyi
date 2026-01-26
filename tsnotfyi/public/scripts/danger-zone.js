// Danger zone state management - DEPRECATED
// This module is being replaced by the new clock-animation.js system
// Functions are kept as stubs for backward compatibility during transition
// Dependencies: globals.js (state, elements, rootElement)

import { state, elements, rootElement } from './globals.js';

// Exit danger zone visual state - now a no-op stub
// The new animation system handles visual transitions via clock-animation.js
export function exitDangerZoneVisualState({ reason = 'reset' } = {}) {
    state.dangerZoneVisualActive = false;
    state.dangerZoneDeckCollapsed = false;

    if (rootElement) {
        rootElement.classList.remove('danger-zone-active');
    }

    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    if (deckContainer) {
        elements.dimensionCards = deckContainer;
        deckContainer.classList.remove('danger-zone-empty');
        deckContainer.style.pointerEvents = '';
        deckContainer.style.opacity = '';
    }

    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (trayRoot) {
        elements.nextTrackTray = trayRoot;
        trayRoot.classList.remove('danger-zone-active');
    }

    state.dangerZoneDeferredExplorer = null;
    state.dangerZoneBackupExplorer = null;
}

// Safely exit cards dormant state
export function safelyExitCardsDormantState(options = {}) {
    exitCardsDormantState(options);
}

// Ensure tray preview - delegated to tray system
export function ensureTrayPreviewForDangerZone() {
    // No-op - tray preview now handled by playlist-tray.js
}

// Collapse deck - minimal stub
export function collapseDeckForDangerZone(deckContainer) {
    // No-op - deck collapse now handled by clock-animation.js
}

// Enter danger zone visual state - now triggers new animation system instead
export function enterDangerZoneVisualState() {
    // The new system triggers pack-away animation from progress-ui.js
    // This function is kept for backward compatibility
    state.dangerZoneVisualActive = true;
}

// Ensure deck is hydrated after track change
export function ensureDeckHydratedAfterTrackChange(reason = 'unknown') {
    if (state.dangerZoneVisualActive) {
        return;
    }
    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    if (deckContainer && deckContainer.querySelector('.dimension-card')) {
        return;
    }
    const payload = state.latestExplorerData;
    if (payload && typeof window.createDimensionCards === 'function') {
        window.createDimensionCards(payload, { skipExitAnimation: true, forceRedraw: true });
    }
}

// Enter cards dormant state - minimal stub
export function enterCardsDormantState() {
    if (state.cardsDormant) {
        return;
    }
    const container = elements.dimensionCards || document.getElementById('dimensionCards');
    if (container) {
        container.classList.add('cards-dormant');
        elements.dimensionCards = container;
    }
    state.cardsDormant = true;
}

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

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.exitDangerZoneVisualState = exitDangerZoneVisualState;
    window.safelyExitCardsDormantState = safelyExitCardsDormantState;
    window.ensureTrayPreviewForDangerZone = ensureTrayPreviewForDangerZone;
    window.collapseDeckForDangerZone = collapseDeckForDangerZone;
    window.enterDangerZoneVisualState = enterDangerZoneVisualState;
    window.ensureDeckHydratedAfterTrackChange = ensureDeckHydratedAfterTrackChange;
    window.enterCardsDormantState = enterCardsDormantState;
    window.exitCardsDormantState = exitCardsDormantState;
}
