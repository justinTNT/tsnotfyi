// Playlist CRUD handlers — D1
import { json } from '../router.js';

export async function handlePlaylistTree({ env }) {
  const folders = await env.DB.prepare('SELECT * FROM playlist_folders ORDER BY position').all();
  const playlists = await env.DB.prepare(
    'SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) as track_count FROM playlists p ORDER BY p.position'
  ).all();

  return json({
    folders: folders.results,
    playlists: playlists.results.map(p => ({
      ...p,
      trackCount: p.track_count
    }))
  });
}

export async function handlePlaylists({ request, env }) {
  if (request.method === 'POST') {
    const body = await request.json();
    const { name, description, folderId } = body;
    if (!name) return json({ error: 'name required' }, 400);

    const result = await env.DB.prepare(
      'INSERT INTO playlists (name, description, folder_id) VALUES (?1, ?2, ?3) RETURNING *'
    ).bind(name, description || null, folderId || null).first();

    return json(result, 201);
  }

  // GET
  const playlists = await env.DB.prepare('SELECT * FROM playlists ORDER BY position').all();
  return json(playlists.results);
}

export async function handlePlaylistById({ params, env }) {
  const { id } = params;
  const playlist = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?1').bind(id).first();
  if (!playlist) return json({ error: 'not found' }, 404);

  const items = await env.DB.prepare(
    'SELECT * FROM playlist_items WHERE playlist_id = ?1 ORDER BY position'
  ).bind(id).all();

  // Enrich items with metadata from KV
  const enriched = await Promise.all(items.results.map(async (item) => {
    const raw = await env.METADATA.get(item.identifier);
    const meta = raw ? JSON.parse(raw) : {};
    return {
      ...item,
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      albumCover: meta.albumCover || '/images/albumcover.png',
      duration: meta.duration || null
    };
  }));

  return json({ ...playlist, tracks: enriched, items: enriched });
}

export async function handleAddTracks({ request, params, env }) {
  const { id } = params;
  const body = await request.json();
  const tracks = body.tracks || [body]; // accept single or array

  const existing = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_items WHERE playlist_id = ?1'
  ).bind(id).first();
  let pos = (existing?.maxPos ?? -1) + 1;

  for (const track of tracks) {
    await env.DB.prepare(
      'INSERT INTO playlist_items (playlist_id, identifier, direction, scope, position) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(id, track.identifier, track.direction || null, track.scope || 'magnify', pos++).run();
  }

  return json({ ok: true, added: tracks.length });
}

export async function handleFolders({ request, env }) {
  const body = await request.json();
  const { name, parentId } = body;
  if (!name) return json({ error: 'name required' }, 400);

  const result = await env.DB.prepare(
    'INSERT INTO playlist_folders (name, parent_id) VALUES (?1, ?2) RETURNING *'
  ).bind(name, parentId || null).first();

  return json(result, 201);
}

export async function handleReorder({ request, env }) {
  const body = await request.json();
  const { folders, playlists } = body;

  if (Array.isArray(folders)) {
    for (const f of folders) {
      await env.DB.prepare('UPDATE playlist_folders SET position = ?1, parent_id = ?2 WHERE id = ?3')
        .bind(f.position || 0, f.parentId || null, f.id).run();
    }
  }

  if (Array.isArray(playlists)) {
    for (const p of playlists) {
      await env.DB.prepare('UPDATE playlists SET position = ?1, folder_id = ?2 WHERE id = ?3')
        .bind(p.position || 0, p.folderId || null, p.id).run();
    }
  }

  return json({ ok: true });
}
