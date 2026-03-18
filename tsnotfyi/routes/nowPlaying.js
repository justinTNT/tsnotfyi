function normalizeTrack(track) {
  return track || null;
}

function buildNowPlayingSessions(audioSessions = new Map(), ephemeralSessions = new Map(), { now = Date.now() } = {}) {
  const sessions = [];

  const collectSessions = (collection, isEphemeral = false) => {
    for (const [sessionId, session] of collection) {
      const mixer = session?.mixer;
      const currentTrack = mixer?.state?.currentTrack;
      const clientCount = mixer?.clients instanceof Set || Array.isArray(mixer?.clients)
        ? mixer.clients.size ?? mixer.clients.length
        : Number(mixer?.clients) || 0;
      if (!mixer || !currentTrack || clientCount <= 0) continue;

      const durationSeconds = typeof mixer.getAdjustedTrackDuration === 'function'
        ? Number(mixer.getAdjustedTrackDuration()) || null
        : typeof currentTrack.length === 'number'
          ? currentTrack.length
          : null;

      const durationMs = durationSeconds != null ? Math.max(Math.round(durationSeconds * 1000), 0) : null;
      const elapsedMs = mixer.state.trackStartTime ? Math.max(now - mixer.state.trackStartTime, 0) : null;
      const liveState = typeof mixer.getLiveStreamState === 'function'
        ? mixer.getLiveStreamState()
        : null;
      const hasMismatch = liveState?.trackId && currentTrack?.identifier && liveState.trackId !== currentTrack.identifier;

      sessions.push({
        sessionId,
        md5: currentTrack.identifier || null,
        title: currentTrack.title || null,
        artist: currentTrack.artist || null,
        nextTrack: mixer.nextTrack ? {
          identifier: mixer.nextTrack.identifier || null,
          title: mixer.nextTrack.title || null,
          artist: mixer.nextTrack.artist || null,
          direction: mixer.nextTrack.direction || null
        } : null,
        elapsedMs,
        durationMs,
        clients: clientCount,
        isEphemeral: isEphemeral || Boolean(session.isEphemeral),
        live: liveState ? {
          trackId: liveState.trackId,
          title: liveState.title,
          artist: liveState.artist,
          startedAt: liveState.startedAt,
          lastChunkAt: liveState.lastChunkAt
        } : null,
        liveMismatch: Boolean(hasMismatch)
      });
    }
  };

  collectSessions(audioSessions, false);
  collectSessions(ephemeralSessions, true);
  return sessions;
}

module.exports = {
  buildNowPlayingSessions
};
