#!/usr/bin/env node
/**
 * Import XSPF playlists from ~/Playlists into the database.
 *
 * Matching strategy:
 *   1. Exact match on LOWER(bt_title) + LOWER(bt_artist)
 *   2. Trigram similarity fallback (title similarity > 0.4, artist similarity > 0.3)
 *   3. Unmatched tracks are logged and skipped
 *
 * Usage: node scripts/import-xspf-playlists.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/tsnotfyi';
const PLAYLISTS_DIR = path.join(require('os').homedir(), 'Playlists');
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({ connectionString: DB_URL, max: 5 });

// Simple XML tag extractor — XSPF is regular enough that we don't need a full parser
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function parseXspf(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const tracks = [];
  const trackBlocks = xml.split('<track>').slice(1); // skip preamble
  for (const block of trackBlocks) {
    const end = block.indexOf('</track>');
    const trackXml = block.substring(0, end);
    tracks.push({
      title: extractTag(trackXml, 'title'),
      artist: extractTag(trackXml, 'creator'),
      album: extractTag(trackXml, 'album'),
      duration: extractTag(trackXml, 'duration'),
    });
  }
  return tracks;
}

async function matchTrack(client, title, artist) {
  if (!title) return null;

  // 1. Exact match (case-insensitive)
  if (artist) {
    const exact = await client.query(
      `SELECT identifier, bt_title, bt_artist
       FROM music_analysis
       WHERE LOWER(bt_title) = LOWER($1)
         AND LOWER(bt_artist) = LOWER($2)
       LIMIT 1`,
      [title, artist]
    );
    if (exact.rows.length > 0) return { ...exact.rows[0], method: 'exact' };
  } else {
    const exact = await client.query(
      `SELECT identifier, bt_title, bt_artist
       FROM music_analysis
       WHERE LOWER(bt_title) = LOWER($1)
       LIMIT 1`,
      [title]
    );
    if (exact.rows.length > 0) return { ...exact.rows[0], method: 'exact' };
  }

  // 2. Exact title only (artist may differ due to "feat." variants, etc.)
  if (artist) {
    const titleOnly = await client.query(
      `SELECT identifier, bt_title, bt_artist
       FROM music_analysis
       WHERE LOWER(bt_title) = LOWER($1)
       ORDER BY similarity(LOWER(bt_artist), LOWER($2)) DESC
       LIMIT 1`,
      [title, artist]
    );
    if (titleOnly.rows.length > 0) return { ...titleOnly.rows[0], method: 'exact_title' };
  }

  // 3. Trigram fuzzy match
  const fuzzy = await client.query(
    `SELECT identifier, bt_title, bt_artist,
            similarity(LOWER(bt_title), LOWER($1)) AS title_sim,
            similarity(LOWER(COALESCE(bt_artist, '')), LOWER(COALESCE($2, ''))) AS artist_sim
     FROM music_analysis
     WHERE similarity(LOWER(bt_title), LOWER($1)) > 0.4
     ORDER BY
       similarity(LOWER(bt_title), LOWER($1)) +
       similarity(LOWER(COALESCE(bt_artist, '')), LOWER(COALESCE($2, ''))) DESC
     LIMIT 1`,
    [title, artist || '']
  );
  if (fuzzy.rows.length > 0 && fuzzy.rows[0].title_sim > 0.4) {
    return { ...fuzzy.rows[0], method: 'fuzzy' };
  }

  return null;
}

async function importPlaylist(client, filePath, stats) {
  const name = path.basename(filePath, '.xspf');
  const tracks = parseXspf(filePath);

  // Check if playlist already exists
  const existing = await client.query('SELECT id FROM playlists WHERE name = $1', [name]);
  if (existing.rows.length > 0) {
    console.log(`  ⏭  "${name}" already exists (id=${existing.rows[0].id}), skipping`);
    stats.skipped++;
    return;
  }

  const matched = [];
  const unmatched = [];

  for (const track of tracks) {
    const match = await matchTrack(client, track.title, track.artist);
    if (match) {
      matched.push({ ...track, identifier: match.identifier, method: match.method,
                      dbTitle: match.bt_title, dbArtist: match.bt_artist });
    } else {
      unmatched.push(track);
    }
  }

  if (DRY_RUN) {
    console.log(`  📋 "${name}": ${matched.length}/${tracks.length} matched`);
    if (unmatched.length > 0) {
      for (const t of unmatched) {
        console.log(`     ✗ "${t.title}" by ${t.artist}`);
      }
    }
    stats.totalTracks += tracks.length;
    stats.matchedTracks += matched.length;
    stats.unmatchedTracks += unmatched.length;
    return;
  }

  // Insert playlist
  const res = await client.query(
    `INSERT INTO playlists (name, description, cursor_position)
     VALUES ($1, $2, 0)
     RETURNING id`,
    [name, `Imported from ${path.basename(filePath)}`]
  );
  const playlistId = res.rows[0].id;

  // Insert items
  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    await client.query(
      `INSERT INTO playlist_items (playlist_id, identifier, position)
       VALUES ($1, $2, $3)`,
      [playlistId, m.identifier, i]
    );
  }

  const methods = {};
  for (const m of matched) {
    methods[m.method] = (methods[m.method] || 0) + 1;
  }
  const methodStr = Object.entries(methods).map(([k, v]) => `${k}:${v}`).join(' ');

  console.log(`  ✓ "${name}": ${matched.length}/${tracks.length} tracks imported (${methodStr})`);
  if (unmatched.length > 0) {
    for (const t of unmatched) {
      console.log(`     ✗ "${t.title}" by ${t.artist}`);
    }
  }

  stats.totalTracks += tracks.length;
  stats.matchedTracks += matched.length;
  stats.unmatchedTracks += unmatched.length;
  stats.imported++;
}

async function main() {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Importing XSPF playlists from ${PLAYLISTS_DIR}\n`);

  const files = fs.readdirSync(PLAYLISTS_DIR)
    .filter(f => f.endsWith('.xspf'))
    .sort();

  if (files.length === 0) {
    console.log('No .xspf files found.');
    return;
  }

  console.log(`Found ${files.length} playlists\n`);

  const client = await pool.connect();
  try {
    // Ensure pg_trgm is available
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    const stats = { imported: 0, skipped: 0, totalTracks: 0, matchedTracks: 0, unmatchedTracks: 0 };

    for (const file of files) {
      await importPlaylist(client, path.join(PLAYLISTS_DIR, file), stats);
    }

    console.log(`\n--- Summary ---`);
    console.log(`Playlists: ${stats.imported} imported, ${stats.skipped} skipped`);
    console.log(`Tracks: ${stats.matchedTracks}/${stats.totalTracks} matched (${stats.unmatchedTracks} unmatched)`);
    if (stats.totalTracks > 0) {
      console.log(`Match rate: ${(100 * stats.matchedTracks / stats.totalTracks).toFixed(1)}%`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
