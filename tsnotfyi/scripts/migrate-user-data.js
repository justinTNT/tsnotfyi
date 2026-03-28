#!/usr/bin/env node
// One-time migration: export user data from PostgreSQL for import into D1.
// Usage: node scripts/migrate-user-data.js [--output-dir ./blobs]
//
// Produces SQL files ready for D1 import:
//   user-data.sql — INSERT statements for all user data tables

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const config = require('../tsnotfyi-config.json');
const outputDir = process.argv.includes('--output-dir')
  ? process.argv[process.argv.indexOf('--output-dir') + 1]
  : path.join(__dirname, '..', 'blobs');

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function main() {
  const pool = new Pool({ connectionString: config.database.postgresql.connectionString });
  console.log('📦 Connecting to PostgreSQL...');

  const lines = [];

  // ─── Ratings ───
  const { rows: ratings } = await pool.query('SELECT identifier, rating, rated_at FROM ratings');
  console.log(`📦 ${ratings.length} ratings`);
  for (const r of ratings) {
    lines.push(`INSERT OR REPLACE INTO ratings (identifier, rating, rated_at) VALUES (${esc(r.identifier)}, ${r.rating}, ${esc(r.rated_at)});`);
  }

  // ─── Play stats ───
  const { rows: playStats } = await pool.query('SELECT identifier, completion_count, last_completed FROM play_stats');
  console.log(`📦 ${playStats.length} play_stats`);
  for (const r of playStats) {
    lines.push(`INSERT OR REPLACE INTO play_stats (identifier, completion_count, last_completed) VALUES (${esc(r.identifier)}, ${r.completion_count || 0}, ${esc(r.last_completed)});`);
  }

  // ─── Playlist folders ───
  const { rows: folders } = await pool.query('SELECT id, name, parent_id, position FROM playlist_folders ORDER BY id');
  console.log(`📦 ${folders.length} playlist_folders`);
  for (const r of folders) {
    lines.push(`INSERT OR REPLACE INTO playlist_folders (id, name, parent_id, position) VALUES (${r.id}, ${esc(r.name)}, ${r.parent_id || 'NULL'}, ${r.position || 0});`);
  }

  // ─── Playlists ───
  const { rows: playlists } = await pool.query('SELECT id, name, description, folder_id, position FROM playlists ORDER BY id');
  console.log(`📦 ${playlists.length} playlists`);
  for (const r of playlists) {
    lines.push(`INSERT OR REPLACE INTO playlists (id, name, description, folder_id, position) VALUES (${r.id}, ${esc(r.name)}, ${esc(r.description)}, ${r.folder_id || 'NULL'}, ${r.position || 0});`);
  }

  // ─── Playlist items ───
  const { rows: items } = await pool.query('SELECT id, playlist_id, identifier, direction, scope, position FROM playlist_items ORDER BY playlist_id, position');
  console.log(`📦 ${items.length} playlist_items`);
  for (const r of items) {
    lines.push(`INSERT OR REPLACE INTO playlist_items (id, playlist_id, identifier, direction, scope, position) VALUES (${r.id}, ${r.playlist_id}, ${esc(r.identifier)}, ${esc(r.direction)}, ${esc(r.scope)}, ${r.position || 0});`);
  }

  // ─── Named sessions ───
  const { rows: sessions } = await pool.query('SELECT name, state, updated_at FROM named_sessions');
  console.log(`📦 ${sessions.length} named_sessions`);
  for (const r of sessions) {
    const stateJson = typeof r.state === 'string' ? r.state : JSON.stringify(r.state);
    lines.push(`INSERT OR REPLACE INTO named_sessions (name, state_json, updated_at) VALUES (${esc(r.name)}, ${esc(stateJson)}, ${esc(r.updated_at)});`);
  }

  // ─── Write ───
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'user-data.sql');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`📦 Written ${lines.length} statements to ${outPath}`);

  await pool.end();
  console.log('📦 Done!');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
