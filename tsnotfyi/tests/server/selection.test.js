describe('Selection state logic', () => {
  let state;

  const TRACK_CHANGE_GRACE_MS = 1500;

  function setSelection(trackId, source, directionKey = null) {
    const isUser = source === 'user' || source === 'ack';
    if (!isUser && state.selection.source === 'user') return state.selection;
    state.selection = {
      trackId,
      directionKey: directionKey || (isUser ? null : state.selection.directionKey),
      pendingTrackId: isUser ? trackId : state.selection.pendingTrackId,
      source,
      generation: source === 'user' ? state.selection.generation + 1 : state.selection.generation,
      setAt: Date.now(),
    };
    return state.selection;
  }

  function clearSelection(reason) {
    if (state.selection.source === 'user') {
      const alwaysClear = reason === 'track_change' || reason === 'selection_failed'
        || reason === 'error' || reason === 'no_track' || reason === 'init'
        || reason === 'audio_restart';
      if (!alwaysClear) return false;
      if (reason === 'track_change' && state.selection.setAt
          && (Date.now() - state.selection.setAt) < TRACK_CHANGE_GRACE_MS) {
        return false;
      }
    }
    state.selection = {
      trackId: null,
      directionKey: null,
      pendingTrackId: null,
      source: null,
      generation: state.selection.generation,
      setAt: null,
    };
    return true;
  }

  function isUserSelection() {
    return state.selection.source === 'user' || state.selection.source === 'ack';
  }

  beforeEach(() => {
    jest.useFakeTimers();
    state = {
      selection: {
        trackId: null,
        directionKey: null,
        pendingTrackId: null,
        source: null,
        generation: 0,
        setAt: null,
      }
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setSelection', () => {
    test('user source sets trackId and bumps generation', () => {
      const result = setSelection('track1', 'user');
      expect(result.trackId).toBe('track1');
      expect(result.source).toBe('user');
      expect(result.generation).toBe(1);
    });

    test('server source after user selection is blocked', () => {
      setSelection('track1', 'user');
      const before = { ...state.selection };
      const result = setSelection('track2', 'server');

      expect(result.trackId).toBe('track1');
      expect(result.source).toBe('user');
      expect(state.selection).toEqual(before);
    });

    test('server source without active user selection works', () => {
      const result = setSelection('track2', 'server');
      expect(result.trackId).toBe('track2');
      expect(result.source).toBe('server');
    });

    test('ack source overwrites user selection', () => {
      setSelection('track1', 'user');
      const result = setSelection('track2', 'ack');

      expect(result.trackId).toBe('track2');
      expect(result.source).toBe('ack');
    });

    test('generation only bumps on user source, not server', () => {
      setSelection('t1', 'server');
      expect(state.selection.generation).toBe(0);

      setSelection('t2', 'user');
      expect(state.selection.generation).toBe(1);

      setSelection('t3', 'user');
      expect(state.selection.generation).toBe(2);
    });

    test('generation does not bump on ack source', () => {
      setSelection('t1', 'user');
      expect(state.selection.generation).toBe(1);

      setSelection('t2', 'ack');
      expect(state.selection.generation).toBe(1);
    });
  });

  describe('clearSelection', () => {
    test('watchdog with active user selection returns false', () => {
      setSelection('track1', 'user');
      const result = clearSelection('watchdog');

      expect(result).toBe(false);
      expect(state.selection.trackId).toBe('track1');
    });

    test('track_change with active user selection clears after grace period', () => {
      setSelection('track1', 'user');
      jest.advanceTimersByTime(TRACK_CHANGE_GRACE_MS);

      const result = clearSelection('track_change');

      expect(result).toBe(true);
      expect(state.selection.trackId).toBeNull();
    });

    test('track_change within grace period returns false', () => {
      setSelection('track1', 'user');
      jest.advanceTimersByTime(TRACK_CHANGE_GRACE_MS - 1);

      const result = clearSelection('track_change');

      expect(result).toBe(false);
      expect(state.selection.trackId).toBe('track1');
    });

    test('error always clears even user selections', () => {
      setSelection('track1', 'user');
      const result = clearSelection('error');

      expect(result).toBe(true);
      expect(state.selection.trackId).toBeNull();
    });

    test('selection_failed clears user selections', () => {
      setSelection('track1', 'user');
      const result = clearSelection('selection_failed');

      expect(result).toBe(true);
      expect(state.selection.trackId).toBeNull();
    });

    test('watchdog without user selection clears normally', () => {
      setSelection('track1', 'server');
      const result = clearSelection('watchdog');

      expect(result).toBe(true);
      expect(state.selection.trackId).toBeNull();
    });

    test('preserves generation counter after clear', () => {
      setSelection('track1', 'user');
      setSelection('track2', 'user');
      expect(state.selection.generation).toBe(2);

      clearSelection('error');

      expect(state.selection.generation).toBe(2);
      expect(state.selection.trackId).toBeNull();
    });
  });

  describe('isUserSelection', () => {
    test('returns true for source=user', () => {
      setSelection('track1', 'user');
      expect(isUserSelection()).toBe(true);
    });

    test('returns true for source=ack', () => {
      setSelection('track1', 'ack');
      expect(isUserSelection()).toBe(true);
    });

    test('returns false for source=server', () => {
      setSelection('track1', 'server');
      expect(isUserSelection()).toBe(false);
    });

    test('returns false for null source', () => {
      expect(isUserSelection()).toBe(false);
    });
  });
});
