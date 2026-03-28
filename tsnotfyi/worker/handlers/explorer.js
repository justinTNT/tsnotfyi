// Explorer handler — proxy to API server, enrich results from KV metadata
import { json } from '../router.js';
import { rewriteCoverUrl } from '../index.js';

async function batchGetMeta(env, identifiers) {
  const results = new Map();
  // KV batch: fetch all in parallel
  const promises = identifiers.map(async (id) => {
    const raw = await env.METADATA.get(id);
    if (raw) results.set(id, JSON.parse(raw));
  });
  await Promise.all(promises);
  return results;
}

export async function handleExplorer({ request, env }) {
  const body = await request.json();
  const { trackId, playlistTrackIds = [] } = body;

  if (!trackId) return json({ error: 'trackId is required' }, 400);

  // Step 1: Call API server — pure math, returns IDs + distances
  const apiUrl = env.API_SERVER_URL || 'https://api.tsnot.fyi';
  const apiResp = await fetch(`${apiUrl}/explorer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId, sessionContext: {}, config: {} })
  });

  if (!apiResp.ok) {
    return json({ error: 'API server error' }, apiResp.status);
  }

  const { explorerData } = await apiResp.json();
  if (!explorerData) return json({ error: 'No explorer data' }, 500);

  // Step 2: Collect all track IDs
  const allIds = new Set([trackId]);
  for (const dir of Object.values(explorerData.directions || {})) {
    for (const s of (dir.sampleTracks || [])) {
      if (s.identifier) allIds.add(s.identifier);
    }
    if (dir.oppositeDirection) {
      for (const s of (dir.oppositeDirection.sampleTracks || [])) {
        if (s.identifier) allIds.add(s.identifier);
      }
    }
  }
  if (explorerData.nextTrack?.identifier) allIds.add(explorerData.nextTrack.identifier);

  // Step 3: Batch KV metadata lookup
  const metaMap = await batchGetMeta(env, Array.from(allIds));

  const sourceTrack = metaMap.get(trackId);
  if (!sourceTrack) return json({ error: 'Track not found' }, 404);

  // Step 4: Build playlist filter
  const playlistTrackSet = new Set(playlistTrackIds);
  const playlistArtists = new Set();
  const playlistAlbums = new Set();
  for (const pid of playlistTrackSet) {
    const meta = metaMap.get(pid);
    if (meta) {
      if (meta.artist) playlistArtists.add(meta.artist.toLowerCase());
      if (meta.album) playlistAlbums.add(meta.album.toLowerCase());
    }
  }

  // Step 5: Enrich and filter
  const enrichTrack = (sample) => {
    const meta = metaMap.get(sample.identifier);
    return {
      identifier: sample.identifier,
      title: meta?.title || '',
      artist: meta?.artist || '',
      album: meta?.album || '',
      albumCover: rewriteCoverUrl(meta?.albumCover || '/images/albumcover.png', env),
      duration: meta?.duration || null,
      distance: sample.distance
    };
  };

  const filteredDirections = {};
  const seenInDirection = new Set();
  for (const [dirKey, direction] of Object.entries(explorerData.directions || {})) {
    const samples = direction.sampleTracks || [];
    const prioritized = [];
    const deprioritized = [];
    seenInDirection.clear();
    const artistCounts = {};
    const albumCounts = {};

    for (const sample of samples) {
      if (playlistTrackSet.has(sample.identifier)) continue;
      if (seenInDirection.has(sample.identifier)) continue;
      seenInDirection.add(sample.identifier);
      const meta = metaMap.get(sample.identifier);
      const artistLower = (meta?.artist || '').toLowerCase();
      const albumLower = (meta?.album || '').toLowerCase();
      const albumKey = `${artistLower}::${albumLower}`;

      // Neighborhood quota: max 5 per artist, max 3 per album per direction
      artistCounts[artistLower] = (artistCounts[artistLower] || 0) + 1;
      albumCounts[albumKey] = (albumCounts[albumKey] || 0) + 1;
      if (artistCounts[artistLower] > 5 || albumCounts[albumKey] > 3) continue;

      if (playlistArtists.has(artistLower) || playlistAlbums.has(albumLower)) {
        deprioritized.push(enrichTrack(sample));
      } else {
        prioritized.push(enrichTrack(sample));
      }
    }

    let enrichedOpposite = null;
    if (direction.oppositeDirection) {
      const oppSamples = (direction.oppositeDirection.sampleTracks || []).map(enrichTrack);
      enrichedOpposite = {
        key: direction.oppositeDirection.key,
        direction: direction.oppositeDirection.direction,
        sampleTracks: oppSamples,
        trackCount: oppSamples.length
      };
    }

    filteredDirections[dirKey] = {
      key: direction.key,
      direction: direction.direction,
      sampleTracks: [...prioritized, ...deprioritized],
      trackCount: prioritized.length + deprioritized.length,
      oppositeDirection: enrichedOpposite
    };
  }

  // Enrich current and next track
  const enrichedCurrent = enrichTrack({ identifier: trackId, distance: 0 });
  let enrichedNext = null;
  if (explorerData.nextTrack) {
    enrichedNext = {
      ...enrichTrack(explorerData.nextTrack),
      directionKey: explorerData.nextTrack.directionKey
    };
  }

  return json({
    currentTrack: enrichedCurrent,
    directions: filteredDirections,
    nextTrack: enrichedNext
  });
}
