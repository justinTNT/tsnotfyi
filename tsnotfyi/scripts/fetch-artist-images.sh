#!/usr/bin/env node

// Fetch artist images from Discogs for directories missing covers
// Usage: node fetch-artist-images.sh [input_file]

const fs = require('fs');
const https = require('https');
const path = require('path');

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || 'bFtjySJptZxHBqGYRyJpBFBtHwKKdOOJoAIOVqgX';
const INPUT_FILE = process.argv[2] || '/tmp/missing-cover-dirs-artists.txt';
const CACHE_DIR = '/tmp/artist-images';
const USER_AGENT = 'MusicLibraryCoverFetcher/1.0';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': USER_AGENT,
        'Authorization': `Discogs token=${DISCOGS_TOKEN}`,
        ...headers
      }
    };
    https.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function searchArtist(name) {
  const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(name)}&type=artist&per_page=1`;
  const res = await fetch(url);
  if (res.status !== 200) return null;
  const json = JSON.parse(res.data.toString());
  return json.results?.[0]?.resource_url || null;
}

async function getArtistImage(resourceUrl) {
  const res = await fetch(resourceUrl);
  if (res.status !== 200) return null;
  const json = JSON.parse(res.data.toString());
  return json.images?.[0]?.uri || null;
}

async function downloadImage(url, dest) {
  const res = await fetch(url, { Authorization: '' }); // No auth for images
  if (res.status !== 200) return false;
  fs.writeFileSync(dest, res.data);
  return true;
}

async function main() {
  const lines = fs.readFileSync(INPUT_FILE, 'utf8').trim().split('\n');

  // Build artist -> directories mapping
  const artistDirs = new Map();
  for (const line of lines) {
    const [dir, artist] = line.split('\t');
    if (!artist || !dir) continue;
    if (!artistDirs.has(artist)) artistDirs.set(artist, []);
    artistDirs.get(artist).push(dir);
  }

  console.log(`Found ${artistDirs.size} unique artists`);

  let success = 0, failed = 0, skipped = 0;
  const artists = [...artistDirs.keys()];

  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i];

    // Skip noise
    if (/^[0-9]{1,2}\s*[-_]/.test(artist) || /^[\(\*\.\+\-\:]/.test(artist)) {
      skipped++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${artists.length}] ${artist}: `);

    try {
      const resourceUrl = await searchArtist(artist);
      await sleep(1000); // Rate limit

      if (!resourceUrl) {
        console.log('not found');
        failed++;
        continue;
      }

      const imageUrl = await getArtistImage(resourceUrl);
      await sleep(1000);

      if (!imageUrl) {
        console.log('no image');
        failed++;
        continue;
      }

      // Check cache
      const safeName = artist.replace(/[/<>:"|?*]/g, '_');
      const ext = imageUrl.match(/\.(jpe?g|png)/i)?.[1] || 'jpg';
      const cachePath = path.join(CACHE_DIR, `${safeName}.${ext}`);

      if (!fs.existsSync(cachePath)) {
        await downloadImage(imageUrl, cachePath);
        await sleep(500);
      }

      if (!fs.existsSync(cachePath)) {
        console.log('download failed');
        failed++;
        continue;
      }

      // Copy to directories
      const dirs = artistDirs.get(artist);
      let copied = 0;
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const dest = path.join(dir, `artist.${ext}`);
        try {
          fs.copyFileSync(cachePath, dest);
          copied++;
        } catch (e) {}
      }

      console.log(`OK -> ${copied} dirs`);
      success++;
    } catch (e) {
      console.log(`error: ${e.message}`);
      failed++;
    }
  }

  console.log('---');
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
}

main().catch(console.error);
