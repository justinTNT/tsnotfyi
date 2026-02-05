#!/usr/bin/env node

// Audit album cover availability
// Reports how many tracks/albums would gain covers via directory tree lookup

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || './music.db';

const COVER_FILENAMES = [
  'cover.jpg', 'cover.png', 'folder.jpg', 'folder.png',
  'album.jpg', 'album.png', 'front.jpg', 'front.png',
  'artwork.jpg', 'artwork.png', 'Cover.jpg', 'Cover.png',
  'Folder.jpg', 'Folder.png'
];

// Walk up from track directory looking for cover art
function findCoverInTree(trackPath, maxDepth = 6) {
  let dir = path.dirname(trackPath);
  let depth = 0;

  while (dir && dir.length > 1 && depth < maxDepth) {
    // Stop at volume root
    if (dir.match(/^\/Volumes\/[^/]+$/)) break;

    for (const filename of COVER_FILENAMES) {
      const coverPath = path.join(dir, filename);
      try {
        if (fs.existsSync(coverPath)) {
          return { found: true, path: coverPath, depth };
        }
      } catch (e) {
        // Permission error or similar, skip
      }
    }
    dir = path.dirname(dir);
    depth++;
  }

  return { found: false, path: null, depth };
}

function parseBeetsArtpath(beetsMetaJson) {
  if (!beetsMetaJson) return null;
  try {
    const meta = JSON.parse(beetsMetaJson);
    const artpath = meta?.album?.artpath;
    if (artpath && artpath.length > 0) {
      return artpath;
    }
  } catch (e) {
    // Invalid JSON
  }
  return null;
}

function main() {
  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true });

  // Get all tracks with their paths and beets metadata
  const rows = db.prepare(`
    SELECT identifier, path, beets_meta
    FROM tracks
    WHERE path IS NOT NULL
  `).all();

  console.log(`Total tracks: ${rows.length}\n`);

  const stats = {
    total: rows.length,
    hasBeetsArtpath: 0,
    beetsArtpathExists: 0,
    beetsArtpathMissing: 0,
    noBeetsArtpath: 0,
    foundViaTreeLookup: 0,
    wouldGainCover: 0,
    stillMissing: 0,
    byDepth: {},
    byTranche: {},
    sampleFinds: [],
    sampleMissing: []
  };

  for (const row of rows) {
    const trackPath = row.path;
    const beetsArtpath = parseBeetsArtpath(row.beets_meta);

    // Extract tranche from path: /Volumes/VOL/YEAR/TRANCHE/...
    const trancheMatch = trackPath.match(/^\/Volumes\/[^/]+\/\d{4}\/([^/]+)\//);
    const tranche = trancheMatch ? trancheMatch[1] : 'unknown';

    if (!stats.byTranche[tranche]) {
      stats.byTranche[tranche] = { total: 0, hasCover: 0, wouldGain: 0, missing: 0 };
    }
    stats.byTranche[tranche].total++;

    if (beetsArtpath) {
      stats.hasBeetsArtpath++;
      // Check if beets artpath actually exists
      try {
        if (fs.existsSync(beetsArtpath)) {
          stats.beetsArtpathExists++;
          stats.byTranche[tranche].hasCover++;
          continue; // Already has valid cover
        } else {
          stats.beetsArtpathMissing++;
        }
      } catch (e) {
        stats.beetsArtpathMissing++;
      }
    } else {
      stats.noBeetsArtpath++;
    }

    // Track is missing cover — try tree lookup
    const result = findCoverInTree(trackPath);

    if (result.found) {
      stats.foundViaTreeLookup++;
      stats.wouldGainCover++;
      stats.byTranche[tranche].wouldGain++;

      stats.byDepth[result.depth] = (stats.byDepth[result.depth] || 0) + 1;

      if (stats.sampleFinds.length < 10) {
        stats.sampleFinds.push({
          track: trackPath,
          cover: result.path,
          depth: result.depth
        });
      }
    } else {
      stats.stillMissing++;
      stats.byTranche[tranche].missing++;

      if (stats.sampleMissing.length < 10) {
        stats.sampleMissing.push(trackPath);
      }
    }
  }

  db.close();

  // Report
  console.log('=== BEETS ARTPATH STATUS ===');
  console.log(`Has beets artpath:        ${stats.hasBeetsArtpath}`);
  console.log(`  - File exists:          ${stats.beetsArtpathExists}`);
  console.log(`  - File missing:         ${stats.beetsArtpathMissing}`);
  console.log(`No beets artpath:         ${stats.noBeetsArtpath}`);
  console.log();

  console.log('=== TREE LOOKUP RESULTS ===');
  console.log(`Tracks needing lookup:    ${stats.noBeetsArtpath + stats.beetsArtpathMissing}`);
  console.log(`Would gain cover:         ${stats.wouldGainCover}`);
  console.log(`Still missing:            ${stats.stillMissing}`);
  console.log();

  console.log('=== COVERS FOUND BY DEPTH ===');
  for (const [depth, count] of Object.entries(stats.byDepth).sort((a, b) => a[0] - b[0])) {
    const label = depth === '0' ? 'same dir' : `${depth} level${depth === '1' ? '' : 's'} up`;
    console.log(`  ${label}: ${count}`);
  }
  console.log();

  console.log('=== BY TRANCHE (top 20) ===');
  const sortedTranches = Object.entries(stats.byTranche)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);

  for (const [tranche, data] of sortedTranches) {
    const coverRate = ((data.hasCover + data.wouldGain) / data.total * 100).toFixed(1);
    console.log(`  ${tranche}: ${data.total} tracks, ${data.hasCover} have cover, +${data.wouldGain} would gain (${coverRate}% coverage)`);
  }
  console.log();

  if (stats.sampleFinds.length > 0) {
    console.log('=== SAMPLE FINDS ===');
    for (const sample of stats.sampleFinds) {
      console.log(`  Track: ${sample.track}`);
      console.log(`  Cover: ${sample.cover} (depth ${sample.depth})`);
      console.log();
    }
  }

  if (stats.sampleMissing.length > 0) {
    console.log('=== SAMPLE STILL MISSING ===');
    for (const sample of stats.sampleMissing) {
      console.log(`  ${sample}`);
    }
  }
}

main();
