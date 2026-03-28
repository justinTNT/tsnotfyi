#!/usr/bin/env node
// Build R2 blob projections from PostgreSQL
// Usage: node scripts/build-blobs.js [--output-dir ./blobs]
//
// Produces 4 files:
//   features.json    — [[id,bpm,danceability,...,loved,playCount]] header + rows
//   tracks.json      — [[id,path,length]] header + rows
//   search.json      — Pre-built token index
//   metadata.json    — {identifier: {title,artist,album,year,duration,path,albumCover}}

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const config = require('../tsnotfyi-config.json');
const outputDir = process.argv.includes('--output-dir')
  ? process.argv[process.argv.indexOf('--output-dir') + 1]
  : path.join(__dirname, '..', 'blobs');

const DIMENSIONS = [
  'bpm', 'danceability', 'onset_rate', 'beat_punch',
  'tonal_clarity', 'tuning_purity', 'fifths_strength', 'chord_strength', 'chord_change_rate',
  'crest', 'entropy',
  'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis', 'spectral_energy', 'spectral_flatness',
  'sub_drive', 'air_sizzle',
  'opb', 'pulse_cohesion', 'spectral_slope'
];

const PCA_COLS = [
  'primary_d',
  'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
  'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
  'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
];

const VAE_COLS = [
  'vae_latent_0', 'vae_latent_1', 'vae_latent_2', 'vae_latent_3',
  'vae_latent_4', 'vae_latent_5', 'vae_latent_6', 'vae_latent_7'
];

// Feature blob column order: identifier, 21 dims, 10 PCA, 8 VAE, loved, playCount
const FEATURE_HEADER = ['identifier', ...DIMENSIONS, ...PCA_COLS, ...VAE_COLS, 'loved', 'play_count'];

function decodePath(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string' && value.startsWith('\\x')) {
    try { return Buffer.from(value.slice(2), 'hex').toString('utf8'); }
    catch { return value; }
  }
  return String(value);
}

async function main() {
  const pool = new Pool({ connectionString: config.database.postgresql.connectionString });
  console.log('📦 Connecting to PostgreSQL...');

  const query = `
    SELECT
      ma.identifier,
      ma.bt_title AS title,
      ma.bt_artist AS artist,
      ma.bt_album AS bt_album,
      ma.bt_path AS path,
      ma.bt_length AS length,
      ma.bt_track, ma.bt_disc,
      ${DIMENSIONS.map(d => 'ma.' + d).join(', ')},
      ${PCA_COLS.map(c => 'ma.' + c).join(', ')},
      ${VAE_COLS.map(c => 'ma.' + c).join(', ')},
      ma.beets_meta,
      r.rating AS love_rating,
      ps.completion_count AS play_count
    FROM music_analysis ma
    LEFT JOIN ratings r ON ma.identifier = r.identifier
    LEFT JOIN play_stats ps ON ma.identifier = ps.identifier
    WHERE ma.bpm IS NOT NULL
      AND ma.spectral_centroid IS NOT NULL
      AND ma.primary_d IS NOT NULL
      AND (r.rating IS NULL OR r.rating != -1)
    ORDER BY ma.identifier
  `;

  console.log('📦 Querying tracks...');
  const { rows } = await pool.query(query);
  console.log(`📦 ${rows.length} tracks loaded`);

  // ─── Feature blob: array of arrays ───
  const featureRows = [FEATURE_HEADER];
  for (const row of rows) {
    featureRows.push([
      row.identifier,
      ...DIMENSIONS.map(d => row[d] || 0),
      ...PCA_COLS.map(c => row[c] || 0),
      ...VAE_COLS.map(c => row[c] ?? null),
      row.love_rating === 1 ? 1 : 0,
      row.play_count || 0
    ]);
  }

  // ─── Track index blob: array of arrays ───
  const trackRows = [['identifier', 'path']];
  for (const row of rows) {
    trackRows.push([row.identifier, decodePath(row.path)]);
  }

  // ─── Search index ───
  console.log('📦 Building search index...');
  const searchInput = rows.map(row => {
    let meta = null;
    try { meta = row.beets_meta ? JSON.parse(row.beets_meta) : null; } catch {}
    const album = meta?.album?.album || meta?.item?.album || row.bt_album || '';
    return {
      identifier: row.identifier,
      title: row.title || '',
      artist: row.artist || '',
      album,
      path: decodePath(row.path) || ''
    };
  });
  const searchIndex = buildSearchIndex(searchInput);

  // ─── Metadata blob: array of arrays (destined for KV, one entry per identifier) ───
  const metadataRows = [['identifier', 'title', 'artist', 'album', 'duration', 'albumCover', 'path']];
  for (const row of rows) {
    let meta = null;
    try { meta = row.beets_meta ? JSON.parse(row.beets_meta) : null; } catch {}
    const artPath = meta?.album?.artpath?.length > 0 ? meta.album.artpath : '/images/albumcover.png';
    const album = meta?.album?.album || meta?.item?.album || row.bt_album || '';
    metadataRows.push([
      row.identifier,
      row.title || '',
      row.artist || '',
      album,
      row.length || null,
      artPath,
      decodePath(row.path) || ''
    ]);
  }

  // ─── Write ───
  fs.mkdirSync(outputDir, { recursive: true });

  const write = (name, data) => {
    const filePath = path.join(outputDir, name);
    const json = JSON.stringify(data);
    fs.writeFileSync(filePath, json);
    const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${name}: ${sizeMB} MB (${name === 'features.json' || name === 'tracks.json' ? data.length - 1 + ' rows' : ''})`);
  };

  console.log('📦 Writing blobs...');
  write('features.json', featureRows);
  write('tracks.json', trackRows);
  write('search.json', searchIndex);
  write('metadata.json', metadataRows);

  await pool.end();
  console.log('📦 Done!');
}

// ─── Search index builder (mirrors services/text-search.js) ───

function normalizeText(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeText(text).split(/[^a-z0-9]+/).filter(t => t.length >= 2);
}

function buildSearchIndex(tracks) {
  const tokenMap = new Map();

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const allTokens = new Set([
      ...tokenize(t.title), ...tokenize(t.artist),
      ...tokenize(t.album), ...tokenize(t.path)
    ]);
    for (const token of allTokens) {
      if (!tokenMap.has(token)) tokenMap.set(token, []);
      tokenMap.get(token).push(i);
    }
  }

  const sortedTokens = Array.from(tokenMap.keys()).sort();
  const postings = {};
  for (const token of sortedTokens) {
    postings[token] = tokenMap.get(token);
  }

  return {
    sortedTokens,
    postings,
    tracks: tracks.map(t => ({
      identifier: t.identifier,
      title: t.title,
      artist: t.artist,
      album: t.album
    }))
  };
}

main().catch(err => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
