#!/usr/bin/env node
// Handler-level tests — test actual Worker route handlers with mocked dependencies
// Usage: node worker/tests/handlers.js

import { createMockEnv } from './mock-env.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

// Import the full Worker module
const worker = await import('../index.js');
const workerFetch = worker.default.fetch;

async function callWorker(path, options = {}, envOverrides = {}) {
  const env = createMockEnv(envOverrides);
  const method = options.method || 'GET';
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const req = new Request(`https://tsnot.fyi${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const resp = await workerFetch(req, env, {});
  return { resp, env };
}

// Helper: mock global fetch for audio server calls
function mockFetch(responses = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, opts });

    // Check if any mock pattern matches
    for (const [pattern, handler] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return typeof handler === 'function' ? handler(urlStr, opts) : handler;
      }
    }

    // Default: Pages fallback returns 404
    return new Response('Not found', { status: 404 });
  };
  return { restore: () => { globalThis.fetch = original; }, calls };
}

// ══════════════════════════════════════════
console.log('\n── GET /health ──');

await test('returns status ok with audio URL', async () => {
  const { resp } = await callWorker('/health');
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.status === 'ok');
  assert(data.audioServer.url === 'http://localhost:3002');
});

// ══════════════════════════════════════════
console.log('\n── POST /client-logs ──');

await test('accepts log entries', async () => {
  const { resp } = await callWorker('/client-logs', {
    method: 'POST',
    body: [{ level: 'error', channel: 'audio', message: 'test error' }]
  });
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.ok === true);
});

// ══════════════════════════════════════════
console.log('\n── GET /search ──');

await test('returns empty for short query', async () => {
  const { resp } = await callWorker('/search?q=a');
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.results.length === 0);
});

await test('searches from R2 index', async () => {
  const env = createMockEnv();
  env.LIBRARY._seed('search.json', JSON.stringify({
    sortedTokens: ['murcof', 'nurse', 'wound'],
    postings: { murcof: [0], nurse: [1], wound: [1] },
    tracks: [
      { identifier: 'aaa', title: 'Cosmos', artist: 'Murcof', album: 'Cosmos' },
      { identifier: 'bbb', title: 'Wound', artist: 'Nurse With Wound', album: 'NWW' }
    ]
  }));

  const req = new Request('https://tsnot.fyi/search?q=murcof&limit=5', { method: 'GET' });
  const resp = await workerFetch(req, env, {});
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.results.length === 1);
  assert(data.results[0].identifier === 'aaa');
  assert(data.results[0].artist === 'Murcof');
});

// ══════════════════════════════════════════
console.log('\n── GET /track/:id/meta ──');

await test('returns metadata from KV', async () => {
  const env = createMockEnv();
  await env.METADATA.put('abc123', JSON.stringify({
    title: 'Test Track', artist: 'Test Artist', album: 'Test Album',
    duration: 180, albumCover: '/images/albumcover.png'
  }));

  const req = new Request('https://tsnot.fyi/track/abc123/meta');
  const resp = await workerFetch(req, env, {});
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.track.title === 'Test Track');
  assert(data.track.identifier === 'abc123');
});

await test('returns 404 for unknown track', async () => {
  const { resp } = await callWorker('/track/unknown123/meta');
  assert(resp.status === 404);
});

// ══════════════════════════════════════════
console.log('\n── POST /api/track/:id/rate ──');

await test('accepts rating', async () => {
  const { resp } = await callWorker('/api/track/abc123/rate', {
    method: 'POST',
    body: { rating: 1 }
  });
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.ok === true);
  assert(data.rating === 1);
});

await test('rejects invalid rating', async () => {
  const { resp } = await callWorker('/api/track/abc123/rate', {
    method: 'POST',
    body: { rating: 5 }
  });
  assert(resp.status === 400);
});

// ══════════════════════════════════════════
console.log('\n── POST /internal/track-completed ──');

await test('records completion', async () => {
  const { resp } = await callWorker('/internal/track-completed', {
    method: 'POST',
    body: { identifier: 'track_xyz' }
  });
  assert(resp.status === 200);
  const data = await resp.json();
  assert(data.ok === true);
  assert(data.identifier === 'track_xyz');
});

await test('rejects missing identifier', async () => {
  const { resp } = await callWorker('/internal/track-completed', {
    method: 'POST',
    body: {}
  });
  assert(resp.status === 400);
});

// ══════════════════════════════════════════
console.log('\n── POST /session/bootstrap ──');

await test('creates session and returns sessionId', async () => {
  const env = createMockEnv();
  const mock = mockFetch({
    '/internal/sessions': new Response('{"ok":true}', { status: 200 }),
    '/health': new Response(JSON.stringify({ sessions: [] }), { status: 200 })
  });
  try {
    const req = new Request('https://tsnot.fyi/session/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const resp = await workerFetch(req, env, {});
    assert(resp.status === 200, `expected 200 got ${resp.status}`);
    const data = await resp.json();
    assert(data.sessionId.startsWith('session_'), `sessionId: ${data.sessionId}`);
    assert(!data.fingerprint, `fingerprint should not be returned`);
    assert(data.audioStreamUrl.includes('/stream'), `bad streamUrl: ${data.audioStreamUrl}`);
    assert(data.audioEventsUrl.includes('/events'), `bad eventsUrl: ${data.audioEventsUrl}`);
  } finally {
    mock.restore();
  }
});

// ══════════════════════════════════════════
console.log('\n── POST /next-track ──');

await test('rejects missing trackMd5', async () => {
  const { resp } = await callWorker('/next-track', {
    method: 'POST',
    body: { sessionId: 'session_test' }
  });
  assert(resp.status === 400);
});

await test('rejects missing session', async () => {
  const { resp } = await callWorker('/next-track', {
    method: 'POST',
    body: { trackMd5: 'abc123' }
  });
  assert(resp.status === 404);
});

await test('normal selection dispatches selectNextTrack', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({
      ok: true, currentTrack: 'current', nextTrack: 'abc123'
    }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/next-track', {
      method: 'POST',
      body: { trackMd5: 'abc123', sessionId: 'session_test', direction: 'bpm_positive' }
    });
    assert(resp.status === 200);
    const data = await resp.json();
    assert(data.status === 'ack');
    assert(data.trackId === 'abc123');

    // Verify the audio server was called with selectNextTrack
    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    assert(cmdCall, 'no command call made');
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'selectNextTrack');
    assert(cmdBody.trackMd5 === 'abc123');
  } finally {
    mock.restore();
  }
});

await test('seed override dispatches replaceSeedTrack', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({ ok: true }), { status: 200 }),
    '/full-state': new Response(JSON.stringify({
      currentTrack: { identifier: 'abc123' }, nextTrack: null
    }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/next-track', {
      method: 'POST',
      body: { trackMd5: 'abc123', sessionId: 'session_test', seedOverride: true, source: 'user' }
    });
    assert(resp.status === 200);
    const data = await resp.json();
    assert(data.status === 'seed_replaced');

    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'replaceSeedTrack');
  } finally {
    mock.restore();
  }
});

await test('deck selection dispatches prepareNextCrossfade', async () => {
  const cmdCalls = [];
  const mock = mockFetch({
    '/command': (url, opts) => {
      const body = JSON.parse(opts.body);
      cmdCalls.push(body.action);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    '/full-state': new Response(JSON.stringify({
      currentTrack: { identifier: 'current' },
      nextTrack: { identifier: 'abc123' }
    }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/next-track', {
      method: 'POST',
      body: { trackMd5: 'abc123', sessionId: 'session_test', source: 'user', origin: 'deck' }
    });
    assert(resp.status === 200);
    const data = await resp.json();
    assert(data.status === 'deck_ack');
    assert(data.origin === 'deck');

    assert(cmdCalls.includes('prepareNextCrossfade'), `expected prepareNextCrossfade, got ${cmdCalls}`);
    assert(cmdCalls.includes('clearPendingSelection'), `expected clearPendingSelection`);
    assert(cmdCalls.includes('broadcastSelection'), `expected broadcastSelection`);
  } finally {
    mock.restore();
  }
});

await test('resolves session from body sessionId', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/next-track', {
      method: 'POST',
      body: { trackMd5: 'abc123', sessionId: 'session_from_body' }
    });
    assert(resp.status === 200);
    const data = await resp.json();
    assert(data.status === 'ack');
    assert(data.sessionId === 'session_from_body');
  } finally {
    mock.restore();
  }
});

// ══════════════════════════════════════════
console.log('\n── GET /current-track ──');

await test('returns enriched track from audio server', async () => {
  const env = createMockEnv();
  await env.METADATA.put('track_abc', JSON.stringify({
    title: 'Test Song', artist: 'Test Artist', album: 'Test Album',
    duration: 240, albumCover: '/Volumes/music/cover.jpg'
  }));

  const mock = mockFetch({
    '/full-state': new Response(JSON.stringify({
      currentTrack: { identifier: 'track_abc', startTime: 1234, durationMs: 240000 }
    }), { status: 200 })
  });
  try {
    const req = new Request('https://tsnot.fyi/current-track?sessionId=session_test');
    const resp = await workerFetch(req, env, {});
    assert(resp.status === 200);
    const data = await resp.json();
    assert(data.currentTrack.identifier === 'track_abc');
    assert(data.currentTrack.title === 'Test Song');
    assert(data.currentTrack.albumCover.includes('covers.tsnot.fyi'), 'cover URL not rewritten');
  } finally {
    mock.restore();
  }
});

await test('returns 204 when no track playing', async () => {
  const mock = mockFetch({
    '/full-state': new Response(JSON.stringify({ currentTrack: null }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/current-track?sessionId=session_test');
    assert(resp.status === 204);
  } finally {
    mock.restore();
  }
});

// ══════════════════════════════════════════
console.log('\n── Session Commands (tunnel proxy) ──');

await test('force-next dispatches forceTransition', async () => {
  const mock = mockFetch({
    '/command': (url, opts) => {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ action: body.action }), { status: 200 });
    }
  });
  try {
    const { resp } = await callWorker('/session/force-next', {
      method: 'POST',
      body: { sessionId: 'session_test' }
    });
    assert(resp.status === 200);
    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'forceTransition');
  } finally {
    mock.restore();
  }
});

await test('skip-to-crossfade dispatches skipToCrossfade', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/session/skip-to-crossfade', {
      method: 'POST',
      body: { sessionId: 'session_test' }
    });
    assert(resp.status === 200);
    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'skipToCrossfade');
  } finally {
    mock.restore();
  }
});

await test('flow/:direction dispatches triggerDirectionalFlow', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/session/flow/brighter', {
      method: 'POST',
      body: { sessionId: 'session_test' }
    });
    assert(resp.status === 200);
    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'triggerDirectionalFlow');
    assert(cmdBody.direction === 'brighter');
  } finally {
    mock.restore();
  }
});

await test('zoom/:mode dispatches setResolution', async () => {
  const mock = mockFetch({
    '/command': new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  try {
    const { resp } = await callWorker('/session/zoom/microscope', {
      method: 'POST',
      body: { sessionId: 'session_test' }
    });
    assert(resp.status === 200);
    const cmdCall = mock.calls.find(c => c.url.includes('/command'));
    const cmdBody = JSON.parse(cmdCall.opts.body);
    assert(cmdBody.action === 'setResolution');
    assert(cmdBody.resolution === 'microscope');
  } finally {
    mock.restore();
  }
});

await test('rejects missing session', async () => {
  const { resp } = await callWorker('/session/force-next', {
    method: 'POST',
    body: {}
  });
  assert(resp.status === 400);
});

// ══════════════════════════════════════════
console.log('\n── Results ──');
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
