// Tunnel proxy — forwards session commands to audio server
// Translates web server routes into audio server command dispatch
import { json } from '../router.js';
import { resolveSession } from '../services/session.js';

// Map web server route → audio server command action
const COMMAND_MAP = {
  '/session/force-next': 'forceTransition',
  '/session/skip-to-crossfade': 'skipToCrossfade',
  '/session/reset-drift': 'resetDrift',
  '/session/random': 'playRandom',
  '/refresh-sse': 'broadcastHeartbeat',
  '/refresh-sse-simple': 'broadcastHeartbeat'
};

export async function proxyToAudio({ request, url, params, env }) {
  const audioUrl = env.AUDIO_SERVER_URL || 'https://audio.tsnot.fyi';

  let body = {};
  try { body = await request.json(); } catch {}

  const resolved = await resolveSession(request, url, env, { body });
  if (!resolved) return json({ error: 'No session' }, 400);
  const sessionId = resolved.sessionId;

  async function dispatch(action, extra = {}) {
    const resp = await fetch(`${audioUrl}/internal/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body, ...extra })
    });
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: resp.status, headers });
  }

  // Simple command map
  const action = COMMAND_MAP[url.pathname];
  if (action) return dispatch(action);

  // Flow with direction param
  if (url.pathname.startsWith('/session/flow/')) {
    const direction = params?.direction || url.pathname.split('/').pop();
    return dispatch('triggerDirectionalFlow', { direction });
  }

  // Zoom with mode param
  if (url.pathname.startsWith('/session/zoom/')) {
    const mode = params?.mode || url.pathname.split('/').pop();
    return dispatch('setResolution', { resolution: mode });
  }

  // Seek
  if (url.pathname === '/session/seek') {
    return dispatch('seek');
  }

  // Create session
  if (url.pathname === '/create-session') {
    try {
      const resp = await fetch(`${audioUrl}/internal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const headers = new Headers(resp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(resp.body, { status: resp.status, headers });
    } catch {
      return json({ error: 'Audio server unreachable' }, 503);
    }
  }

  return json({ error: 'Unknown command' }, 404);
}
