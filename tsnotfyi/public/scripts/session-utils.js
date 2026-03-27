// Session utilities - endpoint composition
// Dependencies: globals.js (state)

import { state } from './globals.js';

export function normalizeResolution(resolution) {
  if (!resolution) return null;
  const value = resolution.toLowerCase();
  if (value === 'magnifying_glass' || value === 'magnifying') {
    return 'magnifying';
  }
  return value;
}

export function composeStreamEndpoint(cacheBust = false) {
  const base = state.streamUrlBase || '/stream';
  const params = [];
  if (state.sessionId) {
    params.push(`sessionId=${encodeURIComponent(state.sessionId)}`);
  }
  if (cacheBust !== false) {
    const value = cacheBust === true ? Date.now() : cacheBust;
    params.push(`t=${value}`);
  }
  return params.length ? `${base}?${params.join('&')}` : base;
}

export function composeEventsEndpoint() {
  const base = state.eventsEndpointBase || '/events';
  const params = [];
  if (state.sessionId) {
    params.push(`sessionId=${encodeURIComponent(state.sessionId)}`);
  }
  return params.length ? `${base}?${params.join('&')}` : base;
}

export function syncStreamEndpoint({ cacheBust = false } = {}) {
  const url = composeStreamEndpoint(cacheBust);
  state.streamUrl = url;
  window.streamUrl = url;
  return url;
}

export function syncEventsEndpoint() {
  const url = composeEventsEndpoint();
  state.eventsEndpoint = url;
  window.eventsUrl = url;
  return url;
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.normalizeResolution = normalizeResolution;
  window.composeStreamEndpoint = composeStreamEndpoint;
  window.composeEventsEndpoint = composeEventsEndpoint;
  window.syncStreamEndpoint = syncStreamEndpoint;
  window.syncEventsEndpoint = syncEventsEndpoint;
}
