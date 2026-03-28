// Session handlers — bootstrap, current track, health
import { json } from '../router.js';
import { resolveSession } from '../services/session.js';
import { rewriteCoverUrl } from '../index.js';

export async function handleBootstrap({ request, url, env }) {
  const body = await request.json().catch(() => ({}));
  const resolved = await resolveSession(request, url, env, { createIfMissing: true, body });
  const sessionId = resolved.sessionId;
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';

  // Create session on audio server if new
  let mixerReady = false;
  if (resolved.isNew) {
    try {
      const resp = await fetch(`${audioUrl}/internal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      mixerReady = resp.ok;
    } catch {}
  } else {
    try {
      const resp = await fetch(`${audioUrl}/health`);
      if (resp.ok) {
        const health = await resp.json();
        const session = (health.sessions || []).find(s => s.sessionId === sessionId);
        mixerReady = session?.isActive || false;
      }
    } catch {}
  }

  return json({
    sessionId,
    mixerReady,
    createdAt: new Date().toISOString(),
    audioStreamUrl: `${audioUrl}/stream?sessionId=${sessionId}`,
    audioEventsUrl: `${audioUrl}/events?sessionId=${sessionId}`
  });
}

export async function handleCurrentTrack({ request, url, env }) {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  const body = await request.clone().json().catch(() => ({}));
  const resolved = await resolveSession(request, url, env, { body });
  if (!resolved) return new Response(null, { status: 204 });

  try {
    const resp = await fetch(`${audioUrl}/internal/sessions/${resolved.sessionId}/full-state`);
    if (!resp.ok) return new Response(null, { status: 204 });

    const result = await resp.json();
    const currentTrackId = result?.currentTrack?.identifier || (typeof result?.currentTrack === 'string' ? result.currentTrack : null);
    if (!currentTrackId) return new Response(null, { status: 204 });

    const currentTrack = {
      identifier: currentTrackId,
      ...(typeof result.currentTrack === 'object' ? result.currentTrack : {}),
      startTime: result.currentTrack?.startTime || null,
      durationMs: result.currentTrack?.durationMs || null
    };

    const raw = await env.METADATA.get(currentTrackId);
    if (raw) {
      const meta = JSON.parse(raw);
      Object.assign(currentTrack, {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        albumCover: rewriteCoverUrl(meta.albumCover, env),
        duration: meta.duration
      });
    }

    return json({ currentTrack });
  } catch {
    return json({ error: 'Audio server unavailable' }, 503);
  }
}

export async function handleHealth({ env }) {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  return json({
    status: 'ok',
    audioServer: { url: audioUrl, publicUrl: audioUrl }
  });
}
