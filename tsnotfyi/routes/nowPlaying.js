async function buildNowPlayingSessions(audioSessions = new Map(), ephemeralSessions = new Map(), { now = Date.now(), audioClient } = {}) {
  const sessions = [];

  const allSessions = [
    ...[...audioSessions.entries()].map(([id, s]) => ({ id, session: s, isEphemeral: false })),
    ...[...ephemeralSessions.entries()].map(([id, s]) => ({ id, session: s, isEphemeral: true }))
  ];

  // Fetch state from Audio server for each session
  for (const { id, session, isEphemeral } of allSessions) {
    try {
      const state = audioClient ? await audioClient.getFullState(id) : null;
      if (!state || !state.currentTrack || state.audioClients <= 0) continue;

      const currentTrack = state.currentTrack;
      const durationMs = currentTrack.length ? Math.round(currentTrack.length * 1000) : null;
      const elapsedMs = state.trackStartTime ? Math.max(now - state.trackStartTime, 0) : null;

      sessions.push({
        sessionId: id,
        md5: currentTrack.identifier || null,
        title: currentTrack.title || null,
        artist: currentTrack.artist || null,
        nextTrack: state.nextTrack ? {
          identifier: state.nextTrack.identifier || null,
          title: state.nextTrack.title || null,
          artist: state.nextTrack.artist || null,
          direction: state.nextTrack.direction || null
        } : null,
        elapsedMs,
        durationMs,
        clients: state.audioClients || 0,
        isEphemeral: isEphemeral || Boolean(session.isEphemeral)
      });
    } catch (e) {
      // Session not on Audio server
    }
  }

  return sessions;
}

module.exports = {
  buildNowPlayingSessions
};
