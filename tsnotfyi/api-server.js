/**
 * API Server — The Mathematical Oracle (port 3001)
 *
 * Owns the KD-tree, RadialSearch, explorer computation, and VAE service.
 * Stateless: no sessions, no audio, no DB writes.
 * Loads track data from PostgreSQL at startup (temporary; future: fetches from Web/Edge).
 */

require('./utils/logTimestamps');
require('./server-logger').setServerName('api');
const express = require('express');
const path = require('path');
const fs = require('fs');
const RadialSearchService = require('./radial-search');
const VAEService = require('./services/vaeService');
const { runExplorerComputation } = require('./services/explorer-service');
const serverLogger = require('./server-logger');

const startupLog = serverLogger.createLogger('startup');
const searchLog = serverLogger.createLogger('search');
const serverLog = serverLogger.createLogger('server');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.logging?.channels) {
  serverLogger.configureFromSpec(config.logging.channels);
}

const app = express();
const port = config.api?.port || 3001;

app.use(express.json({ limit: '8mb' }));

// ─── Service Initialization ─────────────────────────────────────────────────

const radialSearch = new RadialSearchService();

const vaeService = new VAEService({
  modelPath: config.vae?.modelPath || path.join(__dirname, 'models/music_vae.pt'),
  pythonPath: config.vae?.pythonPath || 'python3',
  scriptPath: path.join(__dirname, 'scripts/vae_inference.py')
});

let kdTreeReady = false;

async function initializeServices() {
  try {
    await radialSearch.initialize();
    kdTreeReady = true;
    searchLog.info('✅ RadialSearch + KD-tree initialized');

    try {
      await vaeService.initialize();
      serverLog.info('✅ VAE service initialized');
    } catch (vaeError) {
      serverLog.warn('⚠️ VAE service initialization failed (continuing without VAE):', vaeError.message);
    }
  } catch (err) {
    startupLog.error('Failed to initialize services:', err);
    process.exit(1);
  }
}

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: kdTreeReady ? 'ok' : 'warming',
    trackCount: radialSearch.kdTree?.tracks?.length || 0,
    kdTreeReady,
    vaeReady: vaeService?.isReady || false
  });
});

// ─── Track Lookup ───────────────────────────────────────────────────────────

app.get('/track/:id', (req, res) => {
  const track = radialSearch.kdTree?.getTrack(req.params.id);
  if (!track) {
    return res.status(404).json({ error: 'Track not found' });
  }
  res.json(track);
});

// ─── Internal: Bulk Track Index (for Audio server bootstrap) ────────────────

app.get('/internal/track-index', (req, res) => {
  if (!kdTreeReady) {
    return res.status(503).json({ error: 'KD-tree not ready' });
  }

  const tracks = radialSearch.kdTree.tracks.map(t => ({
    identifier: t.identifier,
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumCover: t.albumCover,
    length: t.length,
    loved: t.loved || false,
    track: t.track || null,
    disc: t.disc || null,
    features: t.features,
    pca: t.pca
  }));

  res.json({ trackCount: tracks.length, tracks });
});

// ─── Internal: Update in-memory state ────────────────────────────────────────

app.post('/internal/track-loved', (req, res) => {
  const { identifier, loved } = req.body;
  if (!identifier) return res.status(400).json({ error: 'identifier required' });

  const track = radialSearch.kdTree?.getTrack(identifier);
  if (track) {
    track.loved = loved;
  }
  res.json({ ok: true });
});

// ─── Explorer ───────────────────────────────────────────────────────────────

app.post('/explorer', async (req, res) => {
  const { trackId, sessionContext, config: explorerConfig } = req.body;

  if (!trackId) {
    return res.status(400).json({ error: 'trackId is required' });
  }

  if (!kdTreeReady) {
    return res.status(503).json({ error: 'KD-tree not ready' });
  }

  try {
    const result = await runExplorerComputation(
      radialSearch,
      trackId,
      sessionContext || {},
      explorerConfig || {}
    );

    res.json({
      explorerData: result.explorerData,
      radiusUsed: result.radiusUsed,
      neighborhoodSize: result.neighborhoodSize,
      dynamicRadiusState: result.dynamicRadiusState,
      computeTimeMs: result.computeTimeMs
    });
  } catch (error) {
    console.error('Explorer computation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Radial Search ──────────────────────────────────────────────────────────

app.post('/radial-search', async (req, res) => {
  try {
    const { trackId, config: searchConfig = {} } = req.body;
    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }
    const result = await radialSearch.exploreFromTrack(trackId, searchConfig);
    res.json(result);
  } catch (error) {
    console.error('Radial search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/directional-search', async (req, res) => {
  try {
    const { trackId, direction, config: searchConfig = {} } = req.body;
    if (!trackId || !direction) {
      return res.status(400).json({ error: 'trackId and direction are required' });
    }
    const result = await radialSearch.getDirectionalCandidates(trackId, direction, searchConfig);
    res.json(result);
  } catch (error) {
    console.error('Directional search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/radial-search/stats', (req, res) => {
  try {
    res.json(radialSearch.getStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── KD-Tree Search ─────────────────────────────────────────────────────────

app.get('/kd-tree/neighbors/:id', async (req, res) => {
  const { id } = req.params;
  const { embedding = 'auto', include_distances = false } = req.query;
  const resolution = req.query.resolution || 'magnifying_glass';
  const radiusSupplied = Object.prototype.hasOwnProperty.call(req.query, 'radius');
  const limitSupplied = Object.prototype.hasOwnProperty.call(req.query, 'limit');
  const parsedRadius = radiusSupplied ? parseFloat(req.query.radius) : null;
  const radiusValue = Number.isFinite(parsedRadius) ? parsedRadius : null;
  const parsedLimit = limitSupplied ? parseInt(req.query.limit, 10) : 100;
  const limitValue = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;

  try {
    const centerTrack = radialSearch.kdTree.getTrack(id);
    if (!centerTrack) {
      return res.status(404).json({ error: 'Track not found' });
    }

    let neighbors = [];
    let appliedRadius = radiusValue ?? 0.3;
    let calibrationMeta = null;

    if (embedding === 'auto' || embedding === 'pca') {
      neighbors = radialSearch.kdTree.radiusSearch(centerTrack, radiusValue ?? 0.3, null, limitValue);
      appliedRadius = radiusValue ?? 0.3;
    } else if (embedding === 'vae') {
      try {
        if (radiusSupplied) {
          neighbors = radialSearch.kdTree.vaeRadiusSearch(centerTrack, radiusValue, limitValue);
          appliedRadius = radiusValue;
        } else {
          const { neighbors: calibrated, appliedRadius: calRadius, calibration } =
            radialSearch.kdTree.vaeCalibratedSearch(centerTrack, resolution, limitValue);
          neighbors = calibrated;
          appliedRadius = calRadius;
          calibrationMeta = calibration;
        }
      } catch (vaeError) {
        console.warn('VAE search failed, falling back to PCA:', vaeError.message);
        neighbors = radialSearch.kdTree.radiusSearch(centerTrack, radiusValue ?? 0.3, null, limitValue);
      }
    }

    const includeDist = include_distances === 'true' || include_distances === true;

    res.json({
      center: {
        identifier: centerTrack.identifier,
        title: centerTrack.title,
        artist: centerTrack.artist,
        album: centerTrack.album
      },
      neighbors: neighbors.map(n => {
        const base = { identifier: n.identifier, title: n.title, artist: n.artist, album: n.album };
        if (includeDist && n.distance !== undefined) base.distance = n.distance;
        return base;
      }),
      meta: { embedding, resolution, appliedRadius, count: neighbors.length, calibration: calibrationMeta }
    });
  } catch (error) {
    console.error('KD-tree search error:', error);
    res.status(500).json({ error: 'Failed to search neighbors' });
  }
});

app.post('/kd-tree/batch-neighbors', async (req, res) => {
  const { identifiers, embedding = 'auto', radius, limit = 50 } = req.body;

  if (!identifiers || !Array.isArray(identifiers)) {
    return res.status(400).json({ error: 'identifiers array is required' });
  }
  if (identifiers.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 identifiers per batch' });
  }

  try {
    const results = {};
    for (const id of identifiers) {
      const centerTrack = radialSearch.kdTree.getTrack(id);
      if (!centerTrack) { results[id] = { error: 'Track not found' }; continue; }

      let neighbors = [];
      const searchRadius = radius ?? 0.3;
      if (embedding === 'vae') {
        try { neighbors = radialSearch.kdTree.vaeRadiusSearch(centerTrack, searchRadius, limit); }
        catch (e) { neighbors = radialSearch.kdTree.radiusSearch(centerTrack, searchRadius, null, limit); }
      } else {
        neighbors = radialSearch.kdTree.radiusSearch(centerTrack, searchRadius, null, limit);
      }
      results[id] = { neighbors: neighbors.map(n => ({ identifier: n.identifier, distance: n.distance })) };
    }
    res.json({ results, meta: { embedding, radius: radius ?? 0.3, limit } });
  } catch (error) {
    console.error('Batch neighbors error:', error);
    res.status(500).json({ error: 'Failed to search neighbors' });
  }
});

app.get('/kd-tree/random-tracks', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 10, 100);
  try {
    const randomTracks = radialSearch.kdTree.getRandomTracks(count);
    res.json({
      tracks: randomTracks.map(t => ({ identifier: t.identifier, title: t.title, artist: t.artist, album: t.album })),
      count: randomTracks.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get random tracks' });
  }
});

// ─── PCA ────────────────────────────────────────────────────────────────────

app.get('/pca/directions', (req, res) => {
  try {
    res.json(radialSearch.getPCADirections());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/pca/resolutions', (req, res) => {
  try {
    res.json(radialSearch.getResolutionSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/pca/directional-search', async (req, res) => {
  try {
    const { trackId, pcaDomain, pcaComponent, direction, config: searchConfig = {} } = req.body;
    if (!trackId || !pcaDomain || !direction) {
      return res.status(400).json({ error: 'trackId, pcaDomain, and direction are required' });
    }
    const result = await radialSearch.getPCADirectionalCandidates(
      trackId, pcaDomain, pcaComponent || 'pc1', direction, searchConfig
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── VAE ────────────────────────────────────────────────────────────────────

const { setupVaeRoutes } = require('./routes/vae');
setupVaeRoutes(app, { vaeService, radialSearch });

// ─── Startup ────────────────────────────────────────────────────────────────

let serverInstance = null;

async function start() {
  await initializeServices();

  serverInstance = app.listen(port, () => {
    startupLog.info(`🧮 API Server listening on port ${port}`);
    startupLog.info(`📊 ${radialSearch.kdTree?.tracks?.length || 0} tracks indexed`);
  });

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      startupLog.error(`❌ Port ${port} already in use`);
      process.exit(1);
    }
    startupLog.error('API Server error:', err);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  console.log('API Server shutting down...');
  radialSearch.close();
  if (vaeService && typeof vaeService.shutdown === 'function') {
    vaeService.shutdown().catch(console.error);
  }
  if (serverInstance) {
    serverInstance.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

if (require.main === module) {
  start();
}

module.exports = { app, start, radialSearch };
