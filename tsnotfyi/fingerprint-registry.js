const crypto = require('crypto');

const fingerprints = new Map(); // fingerprint -> entry
const sessionToFingerprint = new Map(); // sessionId -> fingerprint

function createFingerprintValue(trackId, startTime) {
  const nonce = crypto.randomBytes(3).toString('hex');
  const ts = Number(startTime) || Date.now();
  return `${trackId || 'unknown'}@${ts}@${nonce}`;
}

function normalizeArgs(trackOrOptions, maybeStartTime, maybeStreamIp) {
  if (trackOrOptions && typeof trackOrOptions === 'object' && !Array.isArray(trackOrOptions)) {
    const {
      trackId = null,
      startTime = null,
      streamIp = null,
      metadataIp = null
    } = trackOrOptions;

    return {
      trackId,
      startTime: startTime != null ? Number(startTime) : null,
      streamIp,
      metadataIp
    };
  }

  return {
    trackId: trackOrOptions || null,
    startTime: maybeStartTime != null ? Number(maybeStartTime) : Date.now(),
    streamIp: maybeStreamIp || null,
    metadataIp: null
  };
}

function registerFingerprint(sessionId, args) {
  const { trackId, startTime, streamIp, metadataIp } = normalizeArgs(args);
  const fingerprint = createFingerprintValue(trackId, startTime);
  const entry = {
    sessionId,
    trackId: trackId || null,
    startTime: startTime != null ? Number(startTime) : Date.now(),
    streamIp: streamIp || null,
    metadataIps: new Set(),
    lastTouch: Date.now()
  };
  if (metadataIp) {
    entry.metadataIps.add(metadataIp);
  }
  fingerprints.set(fingerprint, entry);
  sessionToFingerprint.set(sessionId, fingerprint);
  return fingerprint;
}

function ensureFingerprint(sessionId, trackOrOptions, maybeStartTime, maybeStreamIp) {
  if (!sessionId) return null;

  const { trackId, startTime, streamIp, metadataIp } = normalizeArgs(
    trackOrOptions,
    maybeStartTime,
    maybeStreamIp
  );

  let fingerprint = sessionToFingerprint.get(sessionId);
  if (!fingerprint) {
    return registerFingerprint(sessionId, { trackId, startTime, streamIp, metadataIp });
  }

  const entry = fingerprints.get(fingerprint);
  if (entry) {
    if (trackId) entry.trackId = trackId;
    if (startTime != null) entry.startTime = Number(startTime);
    if (streamIp) entry.streamIp = streamIp;
    if (metadataIp) entry.metadataIps.add(metadataIp);
    entry.lastTouch = Date.now();
  } else {
    fingerprint = registerFingerprint(sessionId, { trackId, startTime, streamIp, metadataIp });
  }
  return fingerprint;
}

function rotateFingerprint(sessionId, trackOrOptions, maybeStartTime, maybeStreamIp) {
  if (!sessionId) return null;
  const existing = sessionToFingerprint.get(sessionId);
  if (existing) {
    fingerprints.delete(existing);
    sessionToFingerprint.delete(sessionId);
  }
  return ensureFingerprint(sessionId, trackOrOptions, maybeStartTime, maybeStreamIp);
}

function lookup(fingerprint) {
  if (!fingerprint) return null;
  const entry = fingerprints.get(fingerprint);
  if (!entry) return null;
  entry.lastTouch = Date.now();
  return entry;
}

function touch(fingerprint, { streamIp, metadataIp } = {}) {
  const entry = lookup(fingerprint);
  if (!entry) return null;
  if (streamIp) {
    entry.streamIp = streamIp;
  }
  if (metadataIp) {
    entry.metadataIps.add(metadataIp);
  }
  entry.lastTouch = Date.now();
  return entry;
}

function getFingerprintForSession(sessionId) {
  if (!sessionId) return null;
  return sessionToFingerprint.get(sessionId) || null;
}

function removeBySession(sessionId) {
  const fingerprint = sessionToFingerprint.get(sessionId);
  if (fingerprint) {
    fingerprints.delete(fingerprint);
    sessionToFingerprint.delete(sessionId);
  }
}

function pruneStale(ttlMs) {
  const cutoff = Date.now() - ttlMs;
  for (const [fingerprint, entry] of fingerprints.entries()) {
    if (entry.lastTouch < cutoff) {
      fingerprints.delete(fingerprint);
      if (sessionToFingerprint.get(entry.sessionId) === fingerprint) {
        sessionToFingerprint.delete(entry.sessionId);
      }
    }
  }
}

module.exports = {
  ensureFingerprint,
  rotateFingerprint,
  lookup,
  touch,
  getFingerprintForSession,
  removeBySession,
  pruneStale
};
