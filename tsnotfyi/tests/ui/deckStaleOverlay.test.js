describe('deck stale overlay helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    const root = document.documentElement;
    root.classList.remove('deck-stale');
    window.state.staleExplorerDeck = false;
    window.state.deckStaleContext = null;
    window.state.pendingExplorerSnapshot = null;
    if (window.state.deckStaleFailsafeTimer) {
      clearTimeout(window.state.deckStaleFailsafeTimer);
      window.state.deckStaleFailsafeTimer = null;
    }
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('setDeckStaleFlag toggles the root CSS class', () => {
    const hooks = window.__deckTestHooks;
    expect(hooks).toBeDefined();
    const { setDeckStaleFlag } = hooks;
    expect(typeof setDeckStaleFlag).toBe('function');

    setDeckStaleFlag(true, { reason: 'test' });
    expect(window.state.staleExplorerDeck).toBe(true);
    expect(document.documentElement.classList.contains('deck-stale')).toBe(true);

    setDeckStaleFlag(false, { reason: 'clear' });
    expect(window.state.staleExplorerDeck).toBe(false);
    expect(document.documentElement.classList.contains('deck-stale')).toBe(false);
  });

  test('armExplorerSnapshotTimer sets/clears deck stale state', () => {
    const hooks = window.__deckTestHooks;
    expect(hooks).toBeDefined();
    const { armExplorerSnapshotTimer, clearExplorerSnapshotTimer } = hooks;
    expect(typeof armExplorerSnapshotTimer).toBe('function');
    expect(typeof clearExplorerSnapshotTimer).toBe('function');

    armExplorerSnapshotTimer('track-xyz', { reason: 'test' });
    expect(window.state.pendingExplorerSnapshot).not.toBeNull();
    expect(document.documentElement.classList.contains('deck-stale')).toBe(true);

    clearExplorerSnapshotTimer('track-xyz');
    expect(window.state.pendingExplorerSnapshot).toBeNull();
    expect(document.documentElement.classList.contains('deck-stale')).toBe(false);
  });
});
