// Search handler — loads pre-built token index from R2, searches in memory
import { json } from '../router.js';

let searchIndex = null;

async function loadSearchIndex(env) {
  if (searchIndex) return searchIndex;

  console.log('Loading search index from R2... LIBRARY binding:', typeof env.LIBRARY);
  const obj = await env.LIBRARY.get('search.json');
  console.log('R2 get result:', obj ? `${obj.size} bytes` : 'null');
  if (!obj) throw new Error('search.json not found in R2');

  const data = await obj.json();
  console.log(`Search index parsed: ${data.sortedTokens?.length} tokens, ${data.tracks?.length} tracks`);
  searchIndex = {
    sortedTokens: data.sortedTokens,
    postings: data.postings,
    tracks: data.tracks
  };
  return searchIndex;
}

function normalize(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalize(text).split(/[^a-z0-9]+/).filter(t => t.length >= 2);
}

// Binary search for first token with given prefix
function prefixLowerBound(sorted, prefix) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function prefixMatch(index, prefix) {
  const results = [];
  const start = prefixLowerBound(index.sortedTokens, prefix);
  for (let i = start; i < index.sortedTokens.length; i++) {
    const token = index.sortedTokens[i];
    if (!token.startsWith(prefix)) break;
    const posting = index.postings[token];
    if (posting) {
      for (const idx of posting) results.push(idx);
    }
  }
  return results;
}

function search(index, query, limit = 20) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // AND semantics: intersect posting lists for each query token
  let candidates = null;
  for (const qt of queryTokens) {
    const hits = new Set(prefixMatch(index, qt));
    if (candidates === null) {
      candidates = hits;
    } else {
      candidates = new Set([...candidates].filter(i => hits.has(i)));
    }
    if (candidates.size === 0) return [];
  }

  // Score by field matches (title > artist > album)
  const scored = [];
  for (const idx of candidates) {
    const track = index.tracks[idx];
    const titleTokens = new Set(tokenize(track.title));
    const artistTokens = new Set(tokenize(track.artist));
    const albumTokens = new Set(tokenize(track.album));

    let score = 0;
    for (const qt of queryTokens) {
      for (const tt of titleTokens) { if (tt.startsWith(qt)) { score += 10; break; } }
      for (const at of artistTokens) { if (at.startsWith(qt)) { score += 5; break; } }
      for (const al of albumTokens) { if (al.startsWith(qt)) { score += 2; break; } }
    }
    scored.push({ idx, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function handleSearch({ url, env }) {
  const query = (url.searchParams.get('q') || '').trim();
  if (query.length < 2) {
    return json({ results: [], query, total: 0, hasMore: false });
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);

  const index = await loadSearchIndex(env);
  const hits = search(index, query, limit);

  const results = hits.map(({ idx, score }) => {
    const track = index.tracks[idx];
    return {
      identifier: track.identifier,
      md5: track.identifier,
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      displayText: `${track.artist || ''} - ${track.title || ''}`.replace(/^ - | - $/g, ''),
      score
    };
  });

  return json({ results, query, total: results.length, hasMore: results.length === limit });
}
