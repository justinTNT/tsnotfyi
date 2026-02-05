#!/usr/bin/env node

// Update beets_meta artpath for tracks in directories containing artist.jpeg
// Usage: node update-artpath-from-artist-images.js [--dry-run] [directory-pattern]

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DIR_PATTERN = args.find(a => a.startsWith('/') && !a.includes('node')) || null;

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/tsnotfyi';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== UPDATING DATABASE ===');
  if (DIR_PATTERN) console.log(`Filtering to: ${DIR_PATTERN}`);

  // Find all directories with artist.jpeg/jpg/png
  const imageQuery = `
    SELECT DISTINCT regexp_replace(convert_from(bt_path::bytea, 'UTF8'), '/[^/]+$', '') as dir
    FROM music_analysis
    WHERE bt_path IS NOT NULL
    ${DIR_PATTERN ? `AND convert_from(bt_path::bytea, 'UTF8') LIKE '${DIR_PATTERN}%'` : ''}
  `;

  const { rows: dirs } = await client.query(imageQuery);
  console.log(`Checking ${dirs.length} directories for artist images...`);

  let updated = 0;
  let skipped = 0;

  for (const { dir } of dirs) {
    // Check for artist image in this directory
    const imageFile = ['artist.jpeg', 'artist.jpg', 'artist.png']
      .map(f => path.join(dir, f))
      .find(f => fs.existsSync(f));

    if (!imageFile) {
      continue;
    }

    // Get tracks in this directory that are missing artpath
    const tracksQuery = `
      SELECT identifier, beets_meta
      FROM music_analysis
      WHERE regexp_replace(convert_from(bt_path::bytea, 'UTF8'), '/[^/]+$', '') = $1
      AND (beets_meta IS NULL
           OR beets_meta::jsonb->'album'->>'artpath' IS NULL
           OR beets_meta::jsonb->'album'->>'artpath' = '')
    `;

    const { rows: tracks } = await client.query(tracksQuery, [dir]);

    if (tracks.length === 0) {
      skipped++;
      continue;
    }

    console.log(`${dir}: ${tracks.length} tracks <- ${path.basename(imageFile)}`);

    if (!DRY_RUN) {
      for (const track of tracks) {
        let meta = {};
        try {
          meta = track.beets_meta ? JSON.parse(track.beets_meta) : {};
        } catch (e) {
          meta = {};
        }

        if (!meta.album) meta.album = {};
        meta.album.artpath = imageFile;

        await client.query(
          'UPDATE music_analysis SET beets_meta = $1 WHERE identifier = $2',
          [JSON.stringify(meta), track.identifier]
        );
      }
      updated += tracks.length;
    } else {
      updated += tracks.length;
    }
  }

  await client.end();

  console.log('---');
  console.log(`Updated: ${updated} tracks`);
  console.log(`Skipped: ${skipped} directories (already have artpath)`);
  if (DRY_RUN) console.log('(dry run - no changes made)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
