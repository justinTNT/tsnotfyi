const HEX_32 = /^[a-f0-9]{32}$/i;

function cleanString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function coerceNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function nonNegative(value) {
  if (value === null) return null;
  return value < 0 ? 0 : value;
}

function sanitizeTrackRef(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }
  const identifier = cleanString(track.identifier);
  return identifier
    ? {
        identifier: identifier.toLowerCase(),
        title: cleanString(track.title),
        artist: cleanString(track.artist),
        direction: cleanString(track.direction) || null
      }
    : null;
}

function normalizeNowPlayingSession(record = {}) {
  const sessionId = cleanString(record.sessionId);
  const md5Candidate = cleanString(record.md5);
  const md5 = md5Candidate && HEX_32.test(md5Candidate)
    ? md5Candidate.toLowerCase()
    : null;

  const durationMs = nonNegative(coerceNumber(record.durationMs));
  let elapsedMs = nonNegative(coerceNumber(record.elapsedMs));
  if (durationMs !== null && elapsedMs !== null && elapsedMs > durationMs) {
    elapsedMs = durationMs;
  }
  const remainingMs = durationMs !== null && elapsedMs !== null
    ? Math.max(durationMs - elapsedMs, 0)
    : null;

  const clients = Number.isInteger(record.clients) && record.clients >= 0
    ? record.clients
    : 0;

  return {
    sessionId,
    md5,
    title: cleanString(record.title),
    artist: cleanString(record.artist),
    nextTrack: sanitizeTrackRef(record.nextTrack),
    durationMs,
    elapsedMs,
    remainingMs,
    clients,
    isEphemeral: Boolean(record.isEphemeral)
  };
}

function normalizeHeartbeatEvent(event = {}) {
  const type = 'heartbeat';
  const timestamp = nonNegative(coerceNumber(event.timestamp));
  const reason = cleanString(event.reason) || 'status';
  const fingerprint = cleanString(event.fingerprint);

  const currentTrackRaw = event.currentTrack || {};
  const currentId = cleanString(currentTrackRaw.identifier);
  const currentTrack = currentId
    ? {
        identifier: currentId.toLowerCase(),
        title: cleanString(currentTrackRaw.title),
        artist: cleanString(currentTrackRaw.artist),
        startTime: coerceNumber(currentTrackRaw.startTime),
        durationMs: nonNegative(coerceNumber(currentTrackRaw.durationMs))
      }
    : null;

  const timingRaw = event.timing || {};
  const elapsedMs = nonNegative(coerceNumber(timingRaw.elapsedMs));
  const remainingMs = nonNegative(coerceNumber(timingRaw.remainingMs));

  const nextTrackBlock = event.nextTrack && event.nextTrack.track
    ? {
        track: sanitizeTrackRef(event.nextTrack.track),
        direction: cleanString(event.nextTrack.direction) || null
      }
    : null;

  const overrideRaw = event.override || null;
  const override = overrideRaw && cleanString(overrideRaw.identifier) && cleanString(overrideRaw.status)
    ? {
        identifier: cleanString(overrideRaw.identifier).toLowerCase(),
        status: cleanString(overrideRaw.status),
        direction: cleanString(overrideRaw.direction) || null
      }
    : null;

  const sessionRaw = event.session || {};
  const session = {
    id: cleanString(sessionRaw.id),
    audioClients: Number.isInteger(sessionRaw.audioClients) ? Math.max(sessionRaw.audioClients, 0) : 0,
    eventClients: Number.isInteger(sessionRaw.eventClients) ? Math.max(sessionRaw.eventClients, 0) : 0
  };

  const drift = {
    currentDirection: cleanString(event.drift && event.drift.currentDirection) || null
  };

  return {
    type,
    timestamp,
    reason,
    fingerprint,
    currentTrack,
    timing: {
      elapsedMs,
      remainingMs
    },
    nextTrack: nextTrackBlock,
    override,
    session,
    drift
  };
}

const normalizers = {
  now_playing_session: normalizeNowPlayingSession,
  heartbeat_event: normalizeHeartbeatEvent
};

module.exports = {
  normalizeNowPlayingSession,
  normalizeHeartbeatEvent,
  normalizers
};
