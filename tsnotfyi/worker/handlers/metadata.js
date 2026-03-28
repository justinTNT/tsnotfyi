// Metadata handlers — KV lookups for track metadata and folder tracks
import { json } from '../router.js';
import { rewriteCoverUrl } from '../index.js';

async function getTrackMeta(env, identifier) {
  const raw = await env.METADATA.get(identifier);
  if (!raw) return null;
  const meta = JSON.parse(raw);
  meta.albumCover = rewriteCoverUrl(meta.albumCover, env);
  return { identifier, ...meta };
}

export async function handleTrackMeta({ params, env }) {
  const { identifier } = params;
  if (!identifier) return json({ error: 'missing identifier' }, 400);

  const track = await getTrackMeta(env, identifier);
  if (!track) return json({ error: 'track not found' }, 404);

  return json({ track });
}

export async function handleFolderTracks({ params, env }) {
  const { id } = params;
  if (!id) return json({ error: 'missing identifier' }, 400);

  // Look up the source track to get its folder path
  const source = await getTrackMeta(env, id);
  if (!source || !source.path) return json({ error: 'track not found' }, 404);

  const folder = source.path.replace(/\/[^/]+$/, '');

  // KV doesn't support prefix scans, so we need to find folder tracks differently.
  // Strategy: use the search index to find tracks with the same folder path prefix.
  // For now, return just the source track — full folder scan requires R2 metadata blob.
  // TODO: build a folder→tracks index in KV or use list from metadata blob

  // Temporary: load metadata blob from R2 and scan for matching paths
  const obj = await env.LIBRARY.get('metadata.json');
  if (!obj) return json({ error: 'metadata blob not available' }, 503);

  // Stream-parse would be better, but metadata blob is ~16MB — acceptable for cold start cache
  const data = await obj.json();
  // data is [[header], [row], ...] — find path column
  // But metadata blob doesn't have path... wait, we added it back!
  const header = data[0];
  const pathCol = header.indexOf('path');
  const titleCol = header.indexOf('title');
  const artistCol = header.indexOf('artist');
  const albumCol = header.indexOf('album');
  const durationCol = header.indexOf('duration');
  const coverCol = header.indexOf('albumCover');
  const idCol = header.indexOf('identifier');

  if (pathCol === -1) return json({ error: 'path not in metadata' }, 500);

  const tracks = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const trackPath = row[pathCol];
    if (trackPath && trackPath.startsWith(folder + '/')) {
      tracks.push({
        identifier: row[idCol],
        title: row[titleCol] || '',
        artist: row[artistCol] || '',
        album: row[albumCol] || '',
        albumCover: rewriteCoverUrl(row[coverCol] || '/images/albumcover.png', env),
        duration: row[durationCol] || null,
        path: trackPath
      });
    }
  }

  // Sort by filename (approximate track order)
  tracks.sort((a, b) => a.path.localeCompare(b.path));

  return json({ folder, tracks });
}
