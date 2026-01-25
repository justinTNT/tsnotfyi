// Session utilities - fingerprint management, endpoint composition
// Dependencies: globals.js (state)

import { state } from './globals.js';

export function normalizeResolution(resolution) {
  if (!resolution) return null;
  const value = resolution.toLowerCase();
  if (value === 'magnifying_glass' || value === 'magnifying') {
    return 'magnifying';
  }
  if (value === 'microscope' || value === 'binoculars') {
    return value;
  }
  return value;
}

export function composeStreamEndpoint(fingerprint, cacheBust = false) {
  const base = state.streamUrlBase || '/stream';
  const params = [];
  if (fingerprint) {
    params.push(`fingerprint=${encodeURIComponent(fingerprint)}`);
  }
  if (cacheBust !== false) {
    const value = cacheBust === true ? Date.now() : cacheBust;
    params.push(`t=${value}`);
  }
  if (!params.length) {
    return base;
  }
  return `${base}?${params.join('&')}`;
}

export function composeEventsEndpoint(fingerprint) {
  const base = state.eventsEndpointBase || '/events';
  if (!fingerprint) {
    return base;
  }
  return `${base}?fingerprint=${encodeURIComponent(fingerprint)}`;
}

export function syncStreamEndpoint(fingerprint, { cacheBust = false } = {}) {
  const url = composeStreamEndpoint(fingerprint, cacheBust);
  state.streamUrl = url;
  window.streamUrl = url;
  return url;
}

export function syncEventsEndpoint(fingerprint) {
  const url = composeEventsEndpoint(fingerprint);
  state.eventsEndpoint = url;
  window.eventsUrl = url;
  return url;
}

const fingerprintWaiters = [];

function notifyFingerprintWaiters() {
  if (!fingerprintWaiters.length) {
    return;
  }

  const waiters = fingerprintWaiters.splice(0, fingerprintWaiters.length);
  for (const entry of waiters) {
    clearTimeout(entry.timer);
    entry.resolve(true);
  }
}

export function applyFingerprint(fingerprint) {
  if (!fingerprint) {
    return;
  }

  state.streamFingerprint = fingerprint;
  syncEventsEndpoint(fingerprint);
  notifyFingerprintWaiters();
}

export function clearFingerprint({ reason = 'unknown' } = {}) {
  if (state.streamFingerprint) {
    console.log(`🧹 Clearing fingerprint (${reason})`);
  }

  state.streamFingerprint = null;
  syncEventsEndpoint(null);
  syncStreamEndpoint(null, { cacheBust: false });
}

export function waitForFingerprint(timeoutMs = 8000) {
  if (state.streamFingerprint) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: null
    };

    entry.timer = setTimeout(() => {
      const index = fingerprintWaiters.indexOf(entry);
      if (index !== -1) {
        fingerprintWaiters.splice(index, 1);
      }
      resolve(false);
    }, timeoutMs);

    fingerprintWaiters.push(entry);
  });
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.normalizeResolution = normalizeResolution;
  window.composeStreamEndpoint = composeStreamEndpoint;
  window.composeEventsEndpoint = composeEventsEndpoint;
  window.syncStreamEndpoint = syncStreamEndpoint;
  window.syncEventsEndpoint = syncEventsEndpoint;
  window.applyFingerprint = applyFingerprint;
  window.clearFingerprint = clearFingerprint;
  window.waitForFingerprint = waitForFingerprint;
}
