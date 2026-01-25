// Danger zone visual state management - end-of-track UI transitions
// Dependencies: globals.js (state, elements, rootElement)
// Dependencies: explorer-utils.js (cloneExplorerData)
// Dependencies: beets-ui.js (hideBeetsSegments)

import { state, elements, rootElement } from './globals.js';
import { cloneExplorerData } from './explorer-utils.js';
import { hideBeetsSegments } from './beets-ui.js';

export function exitDangerZoneVisualState({ reason = 'reset' } = {}) {
    console.log('🟢 DIAG: exitDangerZoneVisualState called', {
        reason,
        wasActive: state.dangerZoneVisualActive,
        wasCollapsed: state.dangerZoneDeckCollapsed
    });
    if (!state.dangerZoneVisualActive && !state.dangerZoneDeckCollapsed) {
        console.log('🟢 DIAG: exitDangerZoneVisualState early return - already inactive');
        return;
    }
    state.dangerZoneVisualActive = false;
    console.log('🟢 DIAG: exitDangerZoneVisualState cleared flag');
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

    if (typeof window.hideNextTrackPreview === 'function') {
        window.hideNextTrackPreview({ immediate: true });
    }

    state.dangerZoneDeferredExplorer = null;
    state.dangerZoneBackupExplorer = null;

    console.log('🔴 DIAG: exitDangerZone scheduling render', { reason });
    setTimeout(() => {
        const payload = state.latestExplorerData;
        if (payload) {
            const payloadTrackId = payload.currentTrack?.identifier || 'unknown';
            console.log('🔴 DIAG: exitDangerZone setTimeout firing', { payloadTrackId });
            if (typeof window.createDimensionCards === 'function') {
                window.createDimensionCards(payload, { skipExitAnimation: true, forceRedraw: true, forceDangerZoneRender: true });
            }
        } else {
            console.warn('🔴 DIAG: exitDangerZone setTimeout - no payload available');
        }
    }, 0);

    ensureDeckHydratedAfterTrackChange('exit-danger-zone');
    if (typeof window.publishInteractionState === 'function') {
        window.publishInteractionState();
    }
}

export function safelyExitCardsDormantState(options = {}) {
    exitCardsDormantState(options);
}

export function ensureTrayPreviewForDangerZone() {
    const track =
        state.pendingLiveTrackCandidate?.track
        || state.latestExplorerData?.nextTrack?.track
        || state.latestExplorerData?.nextTrack
        || state.previousNextTrack
        || null;

    console.log('🎫 DIAG: ensureTrayPreviewForDangerZone', {
        hasTrack: !!track,
        trackTitle: track?.title,
        pendingLive: !!state.pendingLiveTrackCandidate?.track,
        explorerNextTrack: !!state.latestExplorerData?.nextTrack,
        previousNextTrack: !!state.previousNextTrack
    });

    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (trayRoot) {
        elements.nextTrackTray = trayRoot;
        trayRoot.classList.add('danger-zone-active');
    }

    if (track) {
        if (typeof window.showNextTrackPreview === 'function') {
            window.showNextTrackPreview(track);
        }
    } else {
        if (typeof window.hideNextTrackPreview === 'function') {
            window.hideNextTrackPreview({ immediate: true });
        }
    }
}

export function collapseDeckForDangerZone(deckContainer) {
    if (!deckContainer || state.dangerZoneDeckCollapsed) {
        if (deckContainer) {
            deckContainer.style.pointerEvents = 'none';
        }
        return;
    }
    state.dangerZoneDeckCollapsed = true;
    deckContainer.classList.add('danger-zone-empty');
    deckContainer.style.pointerEvents = 'none';
    state.hasRenderedDeck = false;
    state.directionLayout = {};
    state.lastDirectionSignature = null;
    state.pendingCenterPromotionKey = null;
    state.pendingCenterPromotionOptions = null;
}

export function enterDangerZoneVisualState() {
    console.log('🔴 DIAG: enterDangerZoneVisualState called', {
        alreadyActive: state.dangerZoneVisualActive,
        isRenderingDeck: state.isRenderingDeck,
        pendingDeckHydration: state.pendingDeckHydration
    });
    if (state.isRenderingDeck || state.pendingDeckHydration) {
        console.log('🔴 DIAG: enterDangerZoneVisualState BLOCKED - deck render in progress');
        return;
    }
    if (state.dangerZoneVisualActive) {
        ensureTrayPreviewForDangerZone();
        return;
    }
    state.dangerZoneVisualActive = true;
    console.log('🔴 DIAG: dangerZoneVisualActive SET TO TRUE');
    state.dangerZoneDeferredExplorer = null;
    state.dangerZoneBackupExplorer = cloneExplorerData(state.latestExplorerData);

    hideBeetsSegments();

    if (rootElement) {
        rootElement.classList.add('danger-zone-active');
    }

    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    if (deckContainer) {
        elements.dimensionCards = deckContainer;
        collapseDeckForDangerZone(deckContainer);
    } else {
        state.hasRenderedDeck = false;
    }

    ensureTrayPreviewForDangerZone();
    if (typeof window.publishInteractionState === 'function') {
        window.publishInteractionState();
    }
}

export function ensureDeckHydratedAfterTrackChange(reason = 'unknown') {
    if (state.dangerZoneVisualActive) {
        return;
    }
    const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
    if (deckContainer && deckContainer.querySelector('.dimension-card')) {
        return;
    }
    const payload = state.latestExplorerData || state.dangerZoneBackupExplorer || null;
    if (!payload) {
        return;
    }
    const cloned = payload === state.latestExplorerData ? payload : cloneExplorerData(payload) || payload;
    if (cloned) {
        state.latestExplorerData = cloned;
        if (typeof window.createDimensionCards === 'function') {
            window.createDimensionCards(cloned, { skipExitAnimation: true, forceRedraw: true });
        }
    }
}

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

    if (typeof window.resolveNextTrackData === 'function') {
        const nextInfo = window.resolveNextTrackData();
        if (nextInfo && nextInfo.track) {
            if (typeof window.showNextTrackPreview === 'function') {
                window.showNextTrackPreview(nextInfo.track);
            }
        } else {
            if (typeof window.hideNextTrackPreview === 'function') {
                window.hideNextTrackPreview({ immediate: true });
            }
        }
    }
}

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
    hideBeetsSegments();
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
