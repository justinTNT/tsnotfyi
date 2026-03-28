// Session resolution — centralised session ID lookup
// Resolution order:
//   1. Request body sessionId
//   2. Query param ?sessionId=
//   3. Cookie tsnotfyi.sid
//   4. Create new (if createIfMissing)

export async function resolveSession(request, url, env, { createIfMissing = false, body = null } = {}) {
  // 1. Body sessionId
  if (body?.sessionId) {
    return { sessionId: body.sessionId, isNew: false, source: 'body' };
  }

  // 2. Query param
  const querySessionId = url.searchParams.get('sessionId');
  if (querySessionId) {
    return { sessionId: querySessionId, isNew: false, source: 'query' };
  }

  // 3. Cookie
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/tsnotfyi\.sid=([^;]+)/);
  if (match) {
    return { sessionId: match[1], isNew: false, source: 'cookie' };
  }

  // 4. Create new
  if (createIfMissing) {
    const sessionId = 'session_' + crypto.randomUUID().replace(/-/g, '').substring(0, 8);
    const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';

    try {
      await fetch(`${audioUrl}/internal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch {}

    await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
      created: new Date().toISOString()
    }), { expirationTtl: 86400 });

    return { sessionId, isNew: true, source: 'created' };
  }

  return null;
}
