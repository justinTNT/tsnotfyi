const { buildNowPlayingSessions } = require('../../routes/nowPlaying');

function createMixer(overrides = {}) {
  return {
    currentTrack: overrides.currentTrack || {
      identifier: 'track-md5',
      title: 'Mock Track',
      artist: 'Mock Artist',
      length: 200
    },
    nextTrack: overrides.nextTrack || {
      identifier: 'next-track-md5',
      title: 'Next Track',
      artist: 'Next Artist',
      direction: 'beat_punch_positive'
    },
    clients: overrides.clients || new Set(['client']),
    trackStartTime: overrides.trackStartTime || (Date.now() - 5000),
    getAdjustedTrackDuration: overrides.getAdjustedTrackDuration || (() => 180)
  };
}

function createSession(overrides = {}) {
  return {
    mixer: createMixer(overrides.mixer || {}),
    isEphemeral: Boolean(overrides.isEphemeral)
  };
}

describe('buildNowPlayingSessions', () => {
  test('includes timing and metadata for active sessions', () => {
    const now = Date.now();
    const audioSessions = new Map([
      ['session-a', createSession({
        mixer: createMixer({
          trackStartTime: now - 30_000,
          getAdjustedTrackDuration: () => 240
        })
      })]
    ]);

    const result = buildNowPlayingSessions(audioSessions, new Map(), { now });
    expect(result).toHaveLength(1);

    const session = result[0];
    expect(session.sessionId).toBe('session-a');
    expect(session.md5).toBe('track-md5');
    expect(session.durationMs).toBe(240 * 1000);
    expect(session.elapsedMs).toBe(30_000);
    expect(session.clients).toBe(1);
    expect(session.isEphemeral).toBe(false);
    expect(session.nextTrack).toMatchObject({
      identifier: 'next-track-md5',
      direction: 'beat_punch_positive'
    });
  });

  test('marks ephemeral sessions from secondary collection', () => {
    const now = Date.now();
    const ephemeralSessions = new Map([
      ['session-b', createSession({ isEphemeral: true })]
    ]);

    const result = buildNowPlayingSessions(new Map(), ephemeralSessions, { now });
    expect(result).toHaveLength(1);
    expect(result[0].isEphemeral).toBe(true);
  });
});
