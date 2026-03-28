// Cloudflare Worker — edge deployment of tsnotfyi web server
// Bindings: LIBRARY (R2), METADATA (KV), SESSIONS (KV), DB (D1)
// Env vars: AUDIO_SERVER_URL, API_SERVER_URL

import { Router, json } from './router.js';

// Rewrite local album cover paths to the covers tunnel URL
export function rewriteCoverUrl(albumCover, env) {
  if (!albumCover || albumCover === '/images/albumcover.png') return albumCover;
  if (albumCover.startsWith('/Volumes/')) {
    const coversUrl = env.COVERS_URL || 'https://covers.tsnot.fyi';
    return `${coversUrl}${albumCover}`;
  }
  return albumCover;
}
import { handleSearch } from './handlers/search.js';
import { handleTrackMeta, handleFolderTracks } from './handlers/metadata.js';
import { handleExplorer } from './handlers/explorer.js';
import { handleBootstrap, handleCurrentTrack, handleHealth } from './handlers/session.js';
import { handleRate, handleComplete, handleTrackStats, handleTrackCompleted } from './handlers/ratings.js';
import { handlePlaylistTree, handlePlaylists, handlePlaylistById, handleAddTracks, handleFolders, handleReorder } from './handlers/playlists.js';
import { handleClientLogs } from './handlers/client-logs.js';
import { proxyToAudio } from './handlers/tunnel-proxy.js';
import { handleNextTrack } from './handlers/next-track.js';

const router = new Router();

// ─── Static files (served from Worker assets / Pages) ───
// Handled by Cloudflare Pages — not in this Worker

// ─── Client logs ───
router.post('/client-logs', handleClientLogs);

// ─── Session ───
router.post('/session/bootstrap', handleBootstrap);
router.get('/current-track', handleCurrentTrack);
router.get('/health', handleHealth);

// ─── Search ───
router.get('/search', handleSearch);

// ─── Metadata ───
router.get('/track/:identifier/meta', handleTrackMeta);
router.get('/api/folder-tracks/:id', handleFolderTracks);

// ─── Explorer (proxy to API server, enrich from KV) ───
router.post('/explorer', handleExplorer);

// ─── Ratings & Play Stats (D1) ───
router.post('/api/track/:id/rate', handleRate);
router.post('/api/track/:id/complete', handleComplete);
router.get('/api/track/:id/stats', handleTrackStats);

// ─── Now playing ───
router.get('/sessions/now-playing', async ({ env }) => {
  const audioUrl = env.AUDIO_SERVER_URL || 'https://audio.tsnot.fyi';
  try {
    const resp = await fetch(`${audioUrl}/health`);
    if (!resp.ok) return json([], 200);
    const health = await resp.json();

    // Filter to active sessions with a current track
    const active = (health.sessions || []).filter(s => s.currentTrack && s.audioClients > 0);

    const results = await Promise.all(active.map(async (s) => {
      const trackId = typeof s.currentTrack === 'string' ? s.currentTrack : s.currentTrack?.identifier;
      let meta = null;
      if (trackId) {
        const raw = await env.METADATA.get(trackId);
        if (raw) meta = JSON.parse(raw);
      }
      return {
        sessionId: s.sessionId,
        currentTrack: trackId ? {
          identifier: trackId,
          title: meta?.title || '',
          artist: meta?.artist || '',
          album: meta?.album || '',
          albumCover: meta?.albumCover ? rewriteCoverUrl(meta.albumCover, env) : '/images/albumcover.png'
        } : null,
        listeners: s.audioClients || 0
      };
    }));

    return json(results);
  } catch {
    return json([], 200);
  }
});

// ─── Internal callbacks (from audio server) ───
router.post('/internal/track-completed', handleTrackCompleted);

// ─── SSE refresh (proxy to audio server) ───
router.post('/refresh-sse', proxyToAudio);
router.post('/refresh-sse-simple', proxyToAudio);

// ─── Status (proxy to audio server for mixer stats) ───
router.get('/status', async ({ request, url, env }) => {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  const body = {};
  const { resolveSession: resolve } = await import('./services/session.js');
  const resolved = await resolve(request, url, env, { body });
  if (!resolved) return json({ error: 'No session' }, 404);
  try {
    const resp = await fetch(`${audioUrl}/internal/sessions/${resolved.sessionId}/full-state`);
    if (!resp.ok) return json({ error: 'unavailable' }, resp.status);
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: resp.status, headers });
  } catch {
    return json({ error: 'Audio server unreachable' }, 503);
  }
});

// ─── Stream/SSE proxy (fallback when direct audio connection fails) ───
router.get('/stream', async ({ request, url, env }) => {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  const target = `${audioUrl}/stream${url.search}`;
  const resp = await fetch(target, { headers: request.headers });
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, headers });
});
router.get('/events', async ({ request, url, env }) => {
  const audioUrl = env.AUDIO_SERVER_URL || 'http://localhost:3002';
  const target = `${audioUrl}/events${url.search}`;
  const resp = await fetch(target, { headers: request.headers });
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, headers });
});

// ─── Session commands (proxy to audio server) ───
router.post('/next-track', handleNextTrack);
router.post('/create-session', proxyToAudio);
router.post('/session/force-next', proxyToAudio);
router.post('/session/skip-to-crossfade', proxyToAudio);
router.post('/session/flow/:direction', proxyToAudio);
router.post('/session/zoom/:mode', proxyToAudio);
router.post('/session/seek', proxyToAudio);
router.post('/session/reset-drift', proxyToAudio);
router.post('/session/random', proxyToAudio);

// ─── Playlists (D1) ───
router.get('/api/playlist-tree', handlePlaylistTree);
router.get('/api/playlists', handlePlaylists);
router.get('/api/playlists/:id', handlePlaylistById);
router.post('/api/playlists', handlePlaylists);
router.post('/api/playlists/:id/tracks', handleAddTracks);
router.post('/api/folders', handleFolders);
router.post('/api/reorder', handleReorder);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS for direct audio connection
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const response = await router.handle(request, env, ctx);
    if (response) {
      // Add CORS headers to all responses
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // Proxy /Volumes requests to covers server
    if (url.pathname.startsWith('/Volumes/')) {
      const coversUrl = env.COVERS_URL || 'http://localhost:3004';
      const target = `${coversUrl}${url.pathname}`;
      try {
        const resp = await fetch(target);
        if (resp.ok) {
          const headers = new Headers(resp.headers);
          headers.set('Access-Control-Allow-Origin', '*');
          return new Response(resp.body, { status: resp.status, headers });
        }
      } catch {}
      return new Response('Not found', { status: 404 });
    }

    // Fall through to static assets (served by wrangler assets binding)
    // The assets binding handles this automatically for configured directories.
    // If ASSETS binding exists, use it; otherwise fall back to Pages proxy.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Fallback: proxy to Cloudflare Pages (edge deployment without assets binding)
    const pagesUrl = `https://tsnotfyi-static.pages.dev${url.pathname}${url.search}`;
    const pagesResp = await fetch(pagesUrl, {
      headers: request.headers,
      method: request.method
    });
    if (pagesResp.ok || pagesResp.status === 304) {
      const headers = new Headers(pagesResp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(pagesResp.body, {
        status: pagesResp.status,
        headers
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
