#!/usr/bin/env node
// Simple test runner for Worker services
// Usage: node worker/tests/run.js

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

const { Router, json } = await import('../router.js');
const { resolveSession } = await import('../services/session.js');

// ══════════════════════════════════════════
console.log('\n── Router ──');

await test('matches exact path', async () => {
  const router = new Router();
  let called = false;
  router.get('/health', () => { called = true; return json({ ok: true }); });
  const req = new Request('https://test.com/health');
  await router.handle(req, {}, {});
  assert(called, 'handler not called');
});

await test('matches path with params', async () => {
  const router = new Router();
  let capturedParams;
  router.get('/track/:id/meta', ({ params }) => { capturedParams = params; return json({}); });
  const req = new Request('https://test.com/track/abc123/meta');
  await router.handle(req, {}, {});
  assert(capturedParams.id === 'abc123', `expected abc123 got ${capturedParams.id}`);
});

await test('returns null for no match', async () => {
  const router = new Router();
  router.get('/health', () => json({}));
  const req = new Request('https://test.com/other');
  const result = await router.handle(req, {}, {});
  assert(result === null, 'expected null');
});

await test('method mismatch returns null', async () => {
  const router = new Router();
  router.post('/health', () => json({}));
  const req = new Request('https://test.com/health', { method: 'GET' });
  const result = await router.handle(req, {}, {});
  assert(result === null, 'expected null for GET on POST route');
});

// ══════════════════════════════════════════
console.log('\n── Session Resolution ──');

await test('resolves from body sessionId', async () => {
  const env = createMockEnv();
  const req = new Request('https://test.com/next-track', { method: 'POST' });
  const url = new URL(req.url);
  const result = await resolveSession(req, url, env, { body: { sessionId: 'session_body' } });
  assert(result.sessionId === 'session_body');
  assert(result.source === 'body');
});

await test('resolves from query param', async () => {
  const env = createMockEnv();
  const req = new Request('https://test.com/current-track?sessionId=session_query');
  const url = new URL(req.url);
  const result = await resolveSession(req, url, env, {});
  assert(result.sessionId === 'session_query');
  assert(result.source === 'query');
});

await test('resolves from cookie', async () => {
  const env = createMockEnv();
  const req = new Request('https://test.com/test', {
    headers: { Cookie: 'tsnotfyi.sid=session_cookie; other=val' }
  });
  const url = new URL(req.url);
  const result = await resolveSession(req, url, env, {});
  assert(result.sessionId === 'session_cookie');
  assert(result.source === 'cookie');
});

await test('returns null when no session and createIfMissing=false', async () => {
  const env = createMockEnv();
  const req = new Request('https://test.com/test');
  const url = new URL(req.url);
  const result = await resolveSession(req, url, env, {});
  assert(result === null, 'expected null');
});

await test('creates new session when createIfMissing=true', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
  try {
    const env = createMockEnv();
    const req = new Request('https://test.com/test');
    const url = new URL(req.url);
    const result = await resolveSession(req, url, env, { createIfMissing: true });
    assert(result.sessionId.startsWith('session_'));
    assert(result.isNew === true);
    assert(result.source === 'created');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ══════════════════════════════════════════
console.log('\n── JSON Helper ──');

await test('json() returns correct content type', async () => {
  const resp = json({ hello: 'world' });
  assert(resp.headers.get('Content-Type') === 'application/json');
  const data = await resp.json();
  assert(data.hello === 'world');
});

await test('json() with status code', async () => {
  const resp = json({ error: 'nope' }, 404);
  assert(resp.status === 404);
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
