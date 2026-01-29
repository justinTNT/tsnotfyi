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
    reason: context.reason || 'unknown',
    retryCount: context.retryCount || 0
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

      // Update now-playing card with explorer's album cover (fixes first track cover delay)
      if (data.currentTrack?.albumCover && typeof window.updateNowPlayingCard === 'function') {
        window.updateNowPlayingCard(state.latestCurrentTrack || data.currentTrack, null);
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

  const retryCount = pending.retryCount || 0;
  const maxRetries = 3;

  console.warn('🧭 Explorer fetch timeout; retrying', {
    trackId: pending.trackId?.substring(0, 8),
    waitedMs: Date.now() - pending.queuedAt,
    reason: pending.reason,
    retryCount
  });

  state.pendingExplorerSnapshot = null;

  // Retry immediately rather than using stale backup
  if (retryCount < maxRetries && pending.trackId) {
    // Verify this is still the current track before retrying
    const currentTrackId = state.latestCurrentTrack?.identifier;
    if (pending.trackId === currentTrackId) {
      console.log(`🧭 Retrying explorer fetch (attempt ${retryCount + 1}/${maxRetries})`);
      armExplorerSnapshotTimer(pending.trackId, {
        reason: 'retry-after-timeout',
        retryCount: retryCount + 1
      });
      return;
    } else {
      console.log('🧭 Skipping retry - track has changed', {
        pendingTrackId: pending.trackId.substring(0, 8),
        currentTrackId: currentTrackId?.substring(0, 8)
      });
    }
  }

  // After max retries, try backup only if it matches current track
  if (!useExplorerBackupDeck(pending)) {
    // Backup rejected (wrong track) - schedule another retry with backoff
    const currentTrackId = state.latestCurrentTrack?.identifier;
    if (pending.trackId === currentTrackId) {
      console.log('🧭 Backup rejected; scheduling delayed retry');
      setTimeout(() => {
        // Re-check track hasn't changed
        if (state.latestCurrentTrack?.identifier === pending.trackId && !state.pendingExplorerSnapshot) {
          armExplorerSnapshotTimer(pending.trackId, {
            reason: 'retry-after-backup-rejected',
            retryCount: 0  // Reset retry count for new attempt cycle
          });
        }
      }, 2000);  // 2s backoff before next retry cycle
    }
    setDeckStaleFlag(false, { reason: 'backup-missing' });
  }
}

function useExplorerBackupDeck(pendingContext = {}) {
  const backup = state.lastExplorerPayload ? cloneExplorerData(state.lastExplorerPayload) : null;
  if (!backup || !backup.directions) {
    console.warn('⚠️ Explorer backup unavailable; no directions to display');
    return false;
  }

  // Don't use stale backup from a different track
  const backupTrackId = backup.currentTrack?.identifier || null;
  const wantedTrackId = pendingContext.trackId || state.latestCurrentTrack?.identifier || null;
  if (backupTrackId && wantedTrackId && backupTrackId !== wantedTrackId) {
    console.warn('⚠️ Explorer backup is for wrong track; ignoring stale data', {
      backupTrackId: backupTrackId.substring(0, 8),
      wantedTrackId: wantedTrackId.substring(0, 8)
    });
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
