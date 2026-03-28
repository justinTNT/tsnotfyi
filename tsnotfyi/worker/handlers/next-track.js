// Next-track handler — full port of server.js /next-track
// 3 branches: seed override, deck selection, normal selection
import { json } from '../router.js';
import { resolveSession } from '../services/session.js';

async function audioCommand(audioUrl, sessionId, action, params = {}) {
  const resp = await fetch(`${audioUrl}/internal/sessions/${sessionId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params })
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Audio command ${action} failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

async function getFullState(audioUrl, sessionId) {
  const resp = await fetch(`${audioUrl}/internal/sessions/${sessionId}/full-state`);
  if (!resp.ok) return null;
  return resp.json();
}

export async function handleNextTrack({ request, url, env }) {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  const body = await request.json();
  const {
    trackMd5,
    direction,
    source = 'user',
    origin = null,
    seedOverride = false,
    clientBufferSecs
  } = body;

  if (!trackMd5) return json({ error: 'Track MD5 is required' }, 400);

  const normalizedSource = typeof source === 'string' ? source.toLowerCase() : 'user';
  const normalizedOrigin = typeof origin === 'string' ? origin.toLowerCase() : null;
  const advertisedDirection = typeof direction === 'string' ? direction : null;
  const isDeckSelection = normalizedSource === 'user' && normalizedOrigin === 'deck';

  const resolved = await resolveSession(request, url, env, { body });
  if (!resolved) return json({ error: 'Session not found' }, 404);
  const sessionId = resolved.sessionId;

  if (Number.isFinite(clientBufferSecs) && clientBufferSecs >= 0) {
    try {
      await audioCommand(audioUrl, sessionId, 'setClientBuffer', { bufferSecs: clientBufferSecs });
    } catch {}
  }

  try {
    // Branch 1: Seed override
    if (seedOverride && normalizedSource === 'user') {
      console.log(`🌱 Seed override: ${trackMd5.substring(0, 8)}`);
      try {
        await audioCommand(audioUrl, sessionId, 'replaceSeedTrack', {
          trackMd5,
          direction: advertisedDirection
        });
        const state = await getFullState(audioUrl, sessionId);
        return json({
          status: 'seed_replaced',
          sessionId,
          currentTrack: state?.currentTrack?.identifier || null,
          nextTrack: state?.nextTrack?.identifier || null
        });
      } catch (e) {
        console.warn(`⚠️ Seed override failed: ${e.message}`);
      }
    }

    // Branch 2: Deck selection
    if (isDeckSelection) {
      try {
        await audioCommand(audioUrl, sessionId, 'prepareNextCrossfade', {
          forceRefresh: true,
          reason: 'deck-selection',
          overrideTrackId: trackMd5,
          overrideDirection: advertisedDirection
        });
        await audioCommand(audioUrl, sessionId, 'clearPendingSelection');
        await audioCommand(audioUrl, sessionId, 'broadcastSelection', {
          event: 'selection_ack',
          payload: {
            status: 'promoted',
            trackId: trackMd5,
            direction: advertisedDirection,
            origin: 'deck'
          }
        });

        const state = await getFullState(audioUrl, sessionId);
        console.log(`📤 Deck promotion: ${trackMd5.substring(0, 8)} via ${advertisedDirection || 'unknown'}`);

        return json({
          status: 'deck_ack',
          origin: 'deck',
          sessionId,
          trackId: trackMd5,
          direction: advertisedDirection,
          currentTrack: state?.currentTrack?.identifier || null,
          nextTrack: state?.nextTrack?.identifier || null
        });
      } catch (e) {
        console.warn(`⚠️ Deck selection failed: ${e.message}`);
      }
    }

    // Branch 3: Normal selection
    console.log(`🎵 Next track: ${trackMd5.substring(0, 8)} (${normalizedSource}, ${advertisedDirection || 'none'})`);
    const result = await audioCommand(audioUrl, sessionId, 'selectNextTrack', {
      trackMd5,
      direction: advertisedDirection,
      origin: normalizedSource
    });

    return json({
      status: 'ack',
      sessionId,
      trackId: trackMd5,
      direction: advertisedDirection,
      currentTrack: result?.currentTrack || null,
      nextTrack: result?.nextTrack || null
    });

  } catch (e) {
    console.error('next-track error:', e.message);
    return json({ error: e.message }, 500);
  }
}
