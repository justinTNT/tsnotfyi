// Deck state management - staleness flags, explorer snapshot timing, backup restoration
// Dependencies: globals.js (state, elements, rootElement, DECK_STALE_FAILSAFE_MS, PENDING_EXPLORER_FORCE_MS, debugLog)
// Dependencies: explorer-utils.js (cloneExplorerData)
// Dependencies: explorer-fetch.js (fetchExplorerWithPlaylist) - loaded dynamically to avoid circular imports

import { state, elements, rootElement, DECK_STALE_FAILSAFE_MS, PENDING_EXPLORER_FORCE_MS, debugLog } from './globals.js';
import { cloneExplorerData } from './explorer-utils.js';

// Dynamic import to avoid potential circular dependency issues
async function loadExplorerFetch() {
  const module = await import('./explorer-fetch.js');
  return module.fetchExplorerWithPlaylist;
}

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
  if (state.pendingExplorerTimer) {
    clearTimeout(state.pendingExplorerTimer);
  }
  state.pendingExplorerSnapshot = {
    trackId,
    queuedAt: Date.now(),
    reason: context.reason || 'unknown'
  };
  setDeckStaleFlag(true, {
    reason: context.reason || 'fetching-explorer'
  });

  // Fetch explorer data via POST /explorer (replaces SSE-based explorer snapshots)
  console.log(`🎯 Fetching explorer for track ${trackId.substring(0, 8)}...`);

  // Use async wrapper to handle dynamic import
  (async () => {
    try {
      const fetchExplorerWithPlaylist = await loadExplorerFetch();
      const data = await fetchExplorerWithPlaylist(trackId);

      if (!data) {
        console.warn('🧭 Explorer fetch returned no data');
        handleExplorerSnapshotTimeout();
        return;
      }

      // Check if we're still waiting for this track's data
      if (state.pendingExplorerSnapshot?.trackId !== trackId) {
        console.log('🧭 Explorer data arrived for stale track, ignoring');
        return;
      }

      // Apply the explorer data
      console.log(`🎯 Explorer data received for ${trackId.substring(0, 8)}: ${Object.keys(data.directions || {}).length} directions, nextTrack: ${data.nextTrack?.track?.title || 'none'}`);
      state.pendingExplorerSnapshot = null;
      state.latestExplorerData = {
        ...data,
        currentTrack: data.currentTrack,
        directions: data.directions,
        nextTrack: data.nextTrack || null // Server's recommendation
      };
      state.lastExplorerPayload = cloneExplorerData(state.latestExplorerData);
      setDeckStaleFlag(false, { reason: 'explorer-fetched' });

      // Render the dimension cards
      if (typeof window.createDimensionCards === 'function') {
        window.createDimensionCards(state.latestExplorerData, { skipExitAnimation: false, forceRedraw: true });
      }
    } catch (error) {
      console.error('🧭 Explorer fetch failed:', error);
      handleExplorerSnapshotTimeout();
    }
  })();

  // Set a timeout fallback in case fetch hangs
  const timeoutMs = context.timeoutMs || state.explorerSnapshotTimeoutMs || PENDING_EXPLORER_FORCE_MS;
  state.pendingExplorerTimer = setTimeout(() => {
    if (state.pendingExplorerSnapshot?.trackId === trackId) {
      console.warn('🧭 Explorer fetch timed out');
      handleExplorerSnapshotTimeout();
    }
  }, timeoutMs);
}

function handleExplorerSnapshotTimeout() {
  const pending = state.pendingExplorerSnapshot;
  state.pendingExplorerTimer = null;
  if (!pending) {
    return;
  }
  console.warn('🧭 Explorer fetch timeout; using backup if available', {
    trackId: pending.trackId,
    waitedMs: Date.now() - pending.queuedAt,
    reason: pending.reason
  });
  state.pendingExplorerSnapshot = null;
  if (!useExplorerBackupDeck(pending)) {
    setDeckStaleFlag(false, { reason: 'backup-missing' });
    // Retry fetch after a delay
    const now = Date.now();
    if ((now - (state.lastExplorerTimeoutRefreshTs || 0)) > 3000) {
      state.lastExplorerTimeoutRefreshTs = now;
      console.warn('🧭 Retrying explorer fetch after timeout');
      setTimeout(() => {
        if (pending.trackId && !state.pendingExplorerSnapshot) {
          armExplorerSnapshotTimer(pending.trackId, { reason: 'retry-after-timeout' });
        }
      }, 1000);
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
