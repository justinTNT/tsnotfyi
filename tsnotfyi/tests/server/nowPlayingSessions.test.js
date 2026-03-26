const { buildNowPlayingSessions } = require('../../routes/nowPlaying');

function createMockAudioClient(sessionStates = {}) {
  return {
    async getFullState(sessionId) {
      const state = sessionStates[sessionId];
      if (!state) throw new Error('Session not found');
      return state;
    }
  };
}

describe('buildNowPlayingSessions', () => {
  test('includes timing and metadata for active sessions', async () => {
    const now = Date.now();
    const audioSessions = new Map([
      ['session-a', { isEphemeral: false }]
    ]);

    const audioClient = createMockAudioClient({
      'session-a': {
        currentTrack: {
          identifier: 'track-md5',
          title: 'Mock Track',
          artist: 'Mock Artist',
          length: 240
        },
        nextTrack: {
          identifier: 'next-track-md5',
          title: 'Next Track',
          artist: 'Next Artist',
          direction: 'beat_punch_positive'
        },
        trackStartTime: now - 30_000,
        audioClients: 1
      }
    });

    const result = await buildNowPlayingSessions(audioSessions, new Map(), { now, audioClient });
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

  test('marks ephemeral sessions from secondary collection', async () => {
    const now = Date.now();
    const ephemeralSessions = new Map([
      ['session-b', { isEphemeral: true }]
    ]);

    const audioClient = createMockAudioClient({
      'session-b': {
        currentTrack: { identifier: 'track-b', length: 200 },
        trackStartTime: now - 5000,
        audioClients: 1
      }
    });

    const result = await buildNowPlayingSessions(new Map(), ephemeralSessions, { now, audioClient });
    expect(result).toHaveLength(1);
    expect(result[0].isEphemeral).toBe(true);
  });

  test('skips sessions without connected clients', async () => {
    const audioSessions = new Map([
      ['session-empty', { isEphemeral: false }]
    ]);

    const audioClient = createMockAudioClient({
      'session-empty': {
        currentTrack: { identifier: 'track-c', length: 200 },
        trackStartTime: Date.now() - 5000,
        audioClients: 0
      }
    });

    const result = await buildNowPlayingSessions(audioSessions, new Map(), { audioClient });
    expect(result).toHaveLength(0);
  });
});
