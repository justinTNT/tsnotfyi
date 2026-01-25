// Deck state management - staleness flags, explorer snapshot timing, backup restoration
// Dependencies: globals.js (state, elements, rootElement, DECK_STALE_FAILSAFE_MS, PENDING_EXPLORER_FORCE_MS, debugLog)
// Dependencies: explorer-utils.js (cloneExplorerData)

import { state, elements, rootElement, DECK_STALE_FAILSAFE_MS, PENDING_EXPLORER_FORCE_MS, debugLog } from './globals.js';
import { cloneExplorerData } from './explorer-utils.js';

export function setDeckStaleFlag(active, context = {}) {
  if (state.staleExplorerDeck === active) {
    if (active && context.reason && context.reason !== state.deckStaleContext) {
      state.deckStaleContext = context.reason;
      debugLog('deck', `🧭 Deck stale context updated → ${context.reason}`);
    }
    return;
  }
  state.staleExplorerDeck = active;
  state.deckStaleContext = active ? (context.reason || null) : null;
  if (rootElement) {
    rootElement.classList.toggle('deck-stale', Boolean(active));
  }
  if (active) {
    debugLog('deck', '🧭 Deck marked stale; waiting for explorer payload', context);
    if (state.deckStaleFailsafeTimer) {
      clearTimeout(state.deckStaleFailsafeTimer);
    }
    state.deckStaleFailsafeTimer = setTimeout(() => {
      state.deckStaleFailsafeTimer = null;
      if (!state.staleExplorerDeck) {
        return;
      }
      const deckContainer = elements.dimensionCards || document.getElementById('dimensionCards');
      const hasCards = Boolean(deckContainer && deckContainer.children && deckContainer.children.length > 0);
      if (hasCards) {
        console.warn('🛟 Deck stale failsafe clearing overlay after timeout', {
          reason: state.deckStaleContext
        });
        setDeckStaleFlag(false, { reason: 'failsafe-timeout' });
      }
    }, DECK_STALE_FAILSAFE_MS);
  } else {
    if (state.deckStaleFailsafeTimer) {
      clearTimeout(state.deckStaleFailsafeTimer);
      state.deckStaleFailsafeTimer = null;
    }
    debugLog('deck', '🧭 Deck stale cleared', context);
  }
}

export function clearExplorerSnapshotTimer(resolvedTrackId = null) {
  if (state.pendingExplorerTimer) {
    clearTimeout(state.pendingExplorerTimer);
    state.pendingExplorerTimer = null;
  }
  if (!state.pendingExplorerSnapshot) {
    return;
  }
  if (!resolvedTrackId || state.pendingExplorerSnapshot.trackId === resolvedTrackId) {
    state.pendingExplorerSnapshot = null;
    setDeckStaleFlag(false, { reason: 'snapshot-timer-cleared' });
  }
}

export function armExplorerSnapshotTimer(trackId, context = {}) {
  if (!trackId) {
    return;
  }
  const timeoutMs = context.timeoutMs || state.explorerSnapshotTimeoutMs || PENDING_EXPLORER_FORCE_MS;
  if (state.pendingExplorerTimer) {
    clearTimeout(state.pendingExplorerTimer);
  }
  state.pendingExplorerSnapshot = {
    trackId,
    queuedAt: Date.now(),
    reason: context.reason || 'unknown'
  };
  setDeckStaleFlag(true, {
    reason: context.reason || 'waiting-explorer-snapshot'
  });
  state.pendingExplorerTimer = setTimeout(() => {
    handleExplorerSnapshotTimeout();
  }, timeoutMs);
}

function handleExplorerSnapshotTimeout() {
  const pending = state.pendingExplorerSnapshot;
  state.pendingExplorerTimer = null;
  if (!pending) {
    return;
  }
  console.warn('🧭 Explorer snapshot delayed; keeping previous directions', {
    trackId: pending.trackId,
    waitedMs: Date.now() - pending.queuedAt,
    reason: pending.reason
  });
  state.pendingExplorerSnapshot = null;
  if (!useExplorerBackupDeck(pending)) {
    setDeckStaleFlag(false, { reason: 'backup-missing' });
    const now = Date.now();
    if ((now - (state.lastExplorerTimeoutRefreshTs || 0)) > 3000) {
      state.lastExplorerTimeoutRefreshTs = now;
      console.warn('🛰️ Explorer snapshot missing with no backup; requesting SSE refresh');
      if (typeof window.requestSSERefresh === 'function') {
        window.requestSSERefresh({ escalate: false, stage: 'explorer-timeout' }).catch((error) => {
          console.error('❌ SSE refresh after explorer-timeout failed', error);
        });
      }
    }
  }
}

function useExplorerBackupDeck(pendingContext = {}) {
  const backup = state.lastExplorerPayload ? cloneExplorerData(state.lastExplorerPayload) : null;
  if (!backup || !backup.directions) {
    console.warn('⚠️ Explorer backup unavailable; no directions to display');
    return false;
  }
  try {
    setDeckStaleFlag(true, { reason: 'backup-deck' });
    state.latestExplorerData = backup;
    if (typeof window.createDimensionCards === 'function') {
      window.createDimensionCards(backup, { skipExitAnimation: true, forceRedraw: true });
    }
    state.lastExplorerPayload = cloneExplorerData(backup) || backup;
    console.log('🧭 Restored deck from explorer backup', {
      trackId: pendingContext.trackId || null
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to render explorer backup deck', error);
    return false;
  }
}

export function clearPendingExplorerLookahead(context = {}) {
  if (state.pendingExplorerLookaheadTimer) {
    clearTimeout(state.pendingExplorerLookaheadTimer);
    state.pendingExplorerLookaheadTimer = null;
  }
  if (state.pendingExplorerLookaheadTrackId && context.reason) {
    debugLog('deck', '🧭 Clearing pending explorer lookahead', {
      trackId: state.pendingExplorerLookaheadTrackId,
      reason: context.reason
    });
  }
  state.pendingExplorerLookaheadTrackId = null;
  state.pendingExplorerLookaheadSnapshot = null;
}

export function forceApplyPendingExplorerSnapshot(reason = 'forced') {
  const pending = state.pendingExplorerLookaheadSnapshot;
  const trackId = state.pendingExplorerLookaheadTrackId || pending?.currentTrack?.identifier || null;
  clearPendingExplorerLookahead({ reason: `force-${reason}` });
  if (!pending) {
    return;
  }
  debugLog('deck', '🧭 Force-applying pending explorer snapshot', { trackId, reason });
  setTimeout(() => {
    if (typeof window.__handleExplorerSnapshot === 'function') {
      window.__handleExplorerSnapshot(pending, { forced: true });
    } else {
      console.warn('🧭 handleExplorerSnapshot not yet available, snapshot discarded');
    }
  }, 0);
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.setDeckStaleFlag = setDeckStaleFlag;
  window.clearExplorerSnapshotTimer = clearExplorerSnapshotTimer;
  window.armExplorerSnapshotTimer = armExplorerSnapshotTimer;
  window.clearPendingExplorerLookahead = clearPendingExplorerLookahead;
  window.forceApplyPendingExplorerSnapshot = forceApplyPendingExplorerSnapshot;
}
