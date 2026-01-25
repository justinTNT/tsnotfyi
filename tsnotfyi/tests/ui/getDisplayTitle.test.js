describe('getDisplayTitle', () => {
  beforeEach(() => {
    window.state.trackMetadataCache = {};
  });

  test('prefers direct title field when provided', () => {
    const track = {
      title: '  Midnight Sun  ',
      identifier: 'track-1'
    };

    expect(getDisplayTitle(track)).toBe('Midnight Sun');
  });

  test('falls back to cached metadata filename stem when title is missing', () => {
    const track = {
      identifier: 'track-2'
    };

    window.state.trackMetadataCache['track-2'] = {
      meta: {
        path: '/music/library/Unknown Artist/B-Sides/Secret Jam.mp3'
      }
    };

    expect(getDisplayTitle(track)).toBe('Secret Jam');
  });

  test('prefers cached details title when meta is missing', () => {
    const track = {
      identifier: 'track-4'
    };

    window.state.trackMetadataCache['track-4'] = {
      details: {
        title: 'Encoded Echoes',
        path: '/vault/encoded_echoes.flac'
      }
    };

    expect(getDisplayTitle(track)).toBe('Encoded Echoes');
  });

  test('falls back to local file stem when no metadata is available', () => {
    const track = {
      identifier: 'track-3',
      file: 'relative/path/From/Album/Cut 03.wav'
    };

    expect(getDisplayTitle(track)).toBe('Cut 03');
  });
});
