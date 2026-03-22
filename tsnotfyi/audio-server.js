/**
 * Audio Server — The Heavy Muscle (port 3002)
 *
 * Owns DriftAudioMixer, AdvancedAudioMixer, FFmpeg, PCM streaming, SSE.
 * Stateless session management: receives commands from Web server via REST.
 * Track metadata loaded from API server at startup via TrackLookup.
 */

require('./utils/logTimestamps');
require('./server-logger').setServerName('audio');
const express = require('express');
const path = require('path');
const fs = require('fs');
const DriftAudioMixer = require('./drift-audio-mixer');
const TrackLookup = require('./services/track-lookup');
const ExplorerCache = require('./services/explorer-cache');
const SessionState = require('./services/session-state');
const { SSEManager } = require('./services/sse-manager');
const fingerprintRegistry = require('./fingerprint-registry');
const serverLogger = require('./server-logger');
const { ExplorerResponse, validateOrWarn } = require('./contracts-zod');

const startupLog = serverLogger.createLogger('startup');
const serverLog = serverLogger.createLogger('server');
const sessionLog = serverLogger.createLogger('session');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.logging?.channels) {
  serverLogger.configureFromSpec(config.logging.channels);
}

const app = express();
const port = config.audioServer?.port || 3002;
const apiUrl = config.api?.url || 'http://localhost:3001';
const webUrl = config.server?.url || 'http://localhost:3001';

app.use(express.json({ limit: '8mb' }));

// CORS — browser connects directly from Web server origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Track Index ────────────────────────────────────────────────────────────

const trackLookup = new TrackLookup();

// ─── Session Management ─────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { mixer, created, lastAccess }

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const sessionList = [];
  for (const [id, s] of sessions) {
    sessionList.push({
      sessionId: id,
      isActive: s.mixer?.isActive || false,
      audioClients: s.mixer?.clients?.size || 0,
      eventClients: s.mixer?.eventClients?.size || 0,
      currentTrack: s.mixer?.state?.currentTrack?.identifier?.substring(0, 8) || null
    });
  }

  res.json({
    status: 'ok',
    trackIndexReady: trackLookup.initialized,
    trackCount: trackLookup.trackCount,
    sessions: sessionList
  });
});

// ─── Internal: Session Lifecycle ────────────────────────────────────────────

app.post('/internal/sessions', async (req, res) => {
  const { sessionId, autoStart = false, ephemeral = false } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  if (sessions.has(sessionId)) {
    return res.json({ sessionId, status: 'exists' });
  }

  try {
    const mixer = new DriftAudioMixer(sessionId, trackLookup);

    // Record completion via callback to Web server
    mixer.onHalfwayReached = async (identifier) => {
      try {
        await fetch(`${webUrl}/internal/track-completed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier })
        });
        sessionLog.info(`🎵 Halfway completion sent to Web for ${identifier.substring(0, 8)}`);
      } catch (err) {
        sessionLog.error(`Failed to send completion for ${identifier}:`, err.message);
      }
    };

    // Explorer computation via API server
    mixer.onExplorerNeeded = async (trackId, opts) => {
      try {
        const sessionContext = {
          seenArtists: Array.from(mixer.state.seenArtists || []),
          seenAlbums: Array.from(mixer.state.seenAlbums || []),
          sessionHistoryIds: (mixer.state.sessionHistory || []).map(e => e.identifier),
          currentTrackId: mixer.state.currentTrack?.identifier || null,
          noArtist: mixer.state.noArtist,
          noAlbum: mixer.state.noAlbum,
          failedTrackIds: Array.from(mixer.state.failedTrackAttempts || new Map())
            .filter(([_, count]) => count >= 3).map(([id]) => id)
        };
        const workerConfig = {
          explorerResolution: mixer.state.explorerResolution || 'adaptive',
          stackTotalCount: mixer.state.stackTotalCount || 0,
          stackRandomCount: mixer.state.stackRandomCount || 0,
          cachedRadius: mixer.adaptiveRadiusCache?.get(trackId)?.radius ?? null,
          dynamicRadiusHint: Number.isFinite(mixer.dynamicRadiusState?.currentRadius)
            ? mixer.dynamicRadiusState.currentRadius : null
        };

        const resp = await fetch(`${apiUrl}/explorer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId, sessionContext, config: workerConfig })
        });

        if (!resp.ok) throw new Error(`API explorer returned ${resp.status}`);
        const result = await resp.json();

        // Update mixer bookkeeping from results
        if (result.radiusUsed != null) {
          mixer.adaptiveRadiusCache.set(trackId, {
            radius: result.radiusUsed,
            count: result.neighborhoodSize,
            updatedAt: Date.now()
          });
          mixer.currentAdaptiveRadius = {
            radius: result.radiusUsed,
            count: result.neighborhoodSize,
            cachedRadiusReused: false
          };
        }
        if (result.dynamicRadiusState && Number.isFinite(result.dynamicRadiusState.currentRadius)) {
          mixer.dynamicRadiusState.currentRadius = result.dynamicRadiusState.currentRadius;
        }
        if (result.explorerData) {
          const resolution = mixer.state.explorerResolution || 'adaptive';
          mixer.explorerDataCache.set(trackId, resolution, result.explorerData);
          mixer.recordExplorerSummary(result.explorerData,
            result.explorerData.diagnostics?.radius || null,
            result.neighborhoodSize || 0);
        }

        return result.explorerData || null;
      } catch (err) {
        serverLog.warn(`⚠️ API explorer failed: ${err.message}`);
        return null;
      }
    };

    if (autoStart) {
      await mixer.startDriftPlayback();
      sessionLog.info(`✅ Audio session ${sessionId} started with initial track`);
    }

    const session = {
      sessionId,
      mixer,
      created: new Date(),
      lastAccess: new Date(),
      isEphemeral: ephemeral
    };

    sessions.set(sessionId, session);
    sessionLog.info(`🎯 Audio session created: ${sessionId}`);

    res.json({ sessionId, status: 'created' });
  } catch (error) {
    sessionLog.error(`❌ Failed to create audio session ${sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/internal/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.mixer && typeof session.mixer.destroy === 'function') {
    session.mixer.destroy();
  }
  sessions.delete(req.params.id);
  sessionLog.info(`🗑️ Audio session destroyed: ${req.params.id}`);
  res.json({ ok: true });
});

// ─── Internal: Playback Commands ────────────────────────────────────────────

app.post('/internal/play', async (req, res) => {
  const { sessionId, track } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    session.mixer.resetForJourney(track);
    session.lastAccess = new Date();
    res.json({ status: 'playing', trackId: track?.identifier });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/internal/next-track', async (req, res) => {
  const { sessionId, trackMd5, direction, origin } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    await session.mixer.selectNextTrack(trackMd5, { direction, origin });
    session.lastAccess = new Date();

    res.json({
      status: 'queued',
      currentTrack: session.mixer.state.currentTrack?.identifier || null,
      nextTrack: session.mixer.nextTrack?.identifier || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/internal/force-next', async (req, res) => {
  const { sessionId } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    if (session.mixer.triggerGaplessTransition) {
      session.mixer.triggerGaplessTransition();
    }
    res.json({ status: 'forced' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/internal/explorer-recommendation', (req, res) => {
  const { sessionId, recommendation } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (recommendation) {
    session.mixer.explorerRecommendedNext = recommendation;
  }
  res.json({ ok: true });
});

// ─── Internal: Mixer State ──────────────────────────────────────────────────

app.get('/internal/mixer-state/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const mixer = session.mixer;
  res.json({
    sessionId: req.params.id,
    isActive: mixer.isActive,
    currentTrack: mixer.state.currentTrack ? {
      identifier: mixer.state.currentTrack.identifier,
      title: mixer.state.currentTrack.title,
      artist: mixer.state.currentTrack.artist,
      albumCover: mixer.state.currentTrack.albumCover
    } : null,
    nextTrack: mixer.nextTrack ? {
      identifier: mixer.nextTrack.identifier,
      title: mixer.nextTrack.title,
      artist: mixer.nextTrack.artist
    } : null,
    trackStartTime: mixer.state.trackStartTime,
    audioClients: mixer.clients?.size || 0,
    eventClients: mixer.eventClients?.size || 0
  });
});

// ─── Internal: Full State ────────────────────────────────────────────────────

app.get('/internal/sessions/:id/full-state', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const mixer = session.mixer;
  const s = mixer.state;

  res.json({
    sessionId: s.sessionId,
    sessionType: s.sessionType,
    sessionName: s.sessionName,
    ephemeral: s.ephemeral,
    isActive: mixer.isActive,
    currentTrack: s.currentTrack || null,
    nextTrack: mixer.nextTrack || null,
    pendingCurrentTrack: mixer.pendingCurrentTrack || null,
    trackStartTime: s.trackStartTime,
    audioClients: mixer.clients?.size || 0,
    eventClients: mixer.eventClients?.size || 0,
    sessionHistory: s.sessionHistory || [],
    seenArtists: Array.from(s.seenArtists || []),
    seenAlbums: Array.from(s.seenAlbums || []),
    explorerResolution: s.explorerResolution,
    stackTotalCount: s.stackTotalCount || 0,
    stackRandomCount: s.stackRandomCount || 0,
    noArtist: s.noArtist,
    noAlbum: s.noAlbum,
    failedTrackAttempts: Array.from(s.failedTrackAttempts || new Map()),
    pendingClientBootstrap: mixer.pendingClientBootstrap || false,
    pendingUserOverrideTrackId: mixer.pendingUserOverrideTrackId || null,
    pendingUserOverrideDirection: mixer.pendingUserOverrideDirection || null,
    isUserSelectionPending: mixer.isUserSelectionPending || false,
    lockedNextTrackIdentifier: mixer.lockedNextTrackIdentifier || null,
    clientBufferSecs: mixer.clientBufferSecs || null,
    lastTrackEventPayload: mixer.lastTrackEventPayload || null,
    lastTrackEventTimestamp: mixer.lastTrackEventTimestamp || null,
    lastExplorerSnapshotPayload: mixer.lastExplorerSnapshotPayload || null,
    adaptiveRadiusCache: mixer.adaptiveRadiusCache ? Object.fromEntries(mixer.adaptiveRadiusCache) : {},
    dynamicRadiusState: mixer.dynamicRadiusState || null,
    currentAdaptiveRadius: mixer.currentAdaptiveRadius || null,
    sessionEvents: mixer.sessionEvents || []
  });
});

// ─── Internal: Command Dispatch ──────────────────────────────────────────────

app.post('/internal/sessions/:id/command', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const mixer = session.mixer;
  const { action } = req.body;

  try {
    switch (action) {
      case 'initializeSession': {
        const { type, name, stack } = req.body;
        mixer.initializeSession(type, name, stack);
        return res.json({ ok: true });
      }

      case 'resetForJourney': {
        const { track } = req.body;
        mixer.resetForJourney(track);
        return res.json({ ok: true });
      }

      case 'resetStack':
        mixer.resetStack();
        return res.json({ ok: true });

      case 'resetDrift':
        mixer.resetDrift();
        return res.json({ ok: true });

      case 'getStackState':
        return res.json(mixer.getStackState());

      case 'loadStackState': {
        const { state } = req.body;
        mixer.loadStackState(state);
        return res.json({ ok: true });
      }

      case 'jumpToStackPosition': {
        const { index, position } = req.body;
        await mixer.jumpToStackPosition(index, position);
        return res.json({ ok: true });
      }

      case 'setResolution': {
        const { resolution } = req.body;
        mixer.setExplorerResolution(resolution);
        return res.json({ ok: true });
      }

      case 'broadcastHeartbeat': {
        const { reason, force } = req.body;
        await mixer.broadcastHeartbeat(reason, { force: force || false });
        return res.json({ ok: true });
      }

      case 'broadcastSelection': {
        const { event, payload } = req.body;
        mixer.broadcastSelectionEvent(event, payload);
        return res.json({ ok: true });
      }

      case 'clearPendingSelection':
        mixer.clearPendingUserSelection();
        return res.json({ ok: true });

      case 'triggerDirectionalFlow': {
        const { direction } = req.body;
        mixer.triggerDirectionalFlow(direction);
        return res.json({ ok: true });
      }

      case 'updateMetadata': {
        const { metadata } = req.body;
        if (metadata.sessionId !== undefined) mixer.state.sessionId = metadata.sessionId;
        if (metadata.sessionType !== undefined) mixer.state.sessionType = metadata.sessionType;
        if (metadata.sessionName !== undefined) mixer.state.sessionName = metadata.sessionName;
        if (metadata.ephemeral !== undefined) mixer.state.ephemeral = metadata.ephemeral;
        return res.json({ ok: true });
      }

      case 'setOnIdle': {
        const { callbackUrl } = req.body;
        if (callbackUrl) {
          mixer.onIdle = async () => {
            try {
              await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            } catch (err) {
              serverLog.warn(`onIdle callback failed: ${err.message}`);
            }
          };
        } else {
          mixer.onIdle = null;
        }
        return res.json({ ok: true });
      }

      case 'selectNextTrack': {
        const { trackMd5, direction, origin } = req.body;
        await mixer.selectNextTrack(trackMd5, { direction, origin });
        return res.json({
          ok: true,
          currentTrack: mixer.state.currentTrack?.identifier || null,
          nextTrack: mixer.nextTrack?.identifier || null
        });
      }

      case 'hydrateTrack': {
        const { track: trackIdOrObj, annotations } = req.body;
        const result = mixer.hydrateTrackRecord(trackIdOrObj, annotations);
        return res.json({ track: result });
      }

      case 'prepareNextCrossfade': {
        const opts = { ...req.body };
        delete opts.action;
        await mixer.prepareNextTrackForCrossfade(opts);
        return res.json({
          ok: true,
          nextTrack: mixer.nextTrack?.identifier || null,
          pendingCurrentTrack: mixer.pendingCurrentTrack?.identifier || null
        });
      }

      case 'getExplorerData': {
        const { trackId, forceFresh } = req.body;
        const data = await mixer.getComprehensiveExplorerData({ trackId, forceFresh });
        return res.json({ explorerData: data });
      }

      case 'setClientBuffer': {
        const { clientBufferSecs } = req.body;
        mixer.clientBufferSecs = clientBufferSecs;
        return res.json({ ok: true });
      }

      case 'startDriftPlayback':
        await mixer.startDriftPlayback();
        return res.json({
          ok: true,
          currentTrack: mixer.state.currentTrack?.identifier || null
        });

      case 'getStats': {
        const stats = mixer.getStats();
        const heartbeat = mixer.buildHeartbeatPayload ? mixer.buildHeartbeatPayload('api') : null;
        return res.json({ stats, heartbeat });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    serverLog.error(`Command ${action} failed for session ${req.params.id}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Stream Endpoint ────────────────────────────────────────────────────────

app.get('/stream', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    // Find any active session
    for (const [id, s] of sessions) {
      if (s.mixer?.isActive) {
        s.mixer.addClient(res);
        s.lastAccess = new Date();
        serverLog.info(`🎵 Stream client attached to session ${id}`);
        return;
      }
    }
    return res.status(404).json({ error: 'No active session' });
  }

  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.mixer.addClient(res);
  session.lastAccess = new Date();
  serverLog.info(`🎵 Stream client attached to session ${sessionId}`);
});

// ─── SSE Endpoint ───────────────────────────────────────────────────────────

app.get('/events', async (req, res) => {
  const sessionId = req.query.sessionId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let session = sessionId ? getSession(sessionId) : null;

  // Find any active session if none specified
  if (!session) {
    for (const [id, s] of sessions) {
      if (s.mixer?.isActive || s.mixer?.clients?.size > 0) {
        session = s;
        break;
      }
    }
  }

  if (!session) {
    res.write('data: {"type":"error","message":"no_active_session"}\n\n');
    return res.end();
  }

  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId: session.sessionId })}\n\n`);

  session.mixer.addEventClient(res);
  session.lastAccess = new Date();
  serverLog.info(`📡 SSE client connected to session ${session.sessionId}`);

  // Send initial heartbeat
  if (session.mixer.state.currentTrack && session.mixer.isActive) {
    await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
  }

  req.on('close', () => {
    if (session?.mixer?.removeEventClient) {
      session.mixer.removeEventClient(res);
    }
  });
});

// ─── Startup ────────────────────────────────────────────────────────────────

let serverInstance = null;

async function start() {
  // Load track index from API server
  try {
    await trackLookup.loadFromApi(apiUrl);
  } catch (err) {
    startupLog.error(`❌ Failed to load track index from API server: ${err.message}`);
    startupLog.error('Make sure the API server is running on ' + apiUrl);
    process.exit(1);
  }

  serverInstance = app.listen(port, () => {
    startupLog.info(`🎵 Audio Server listening on port ${port}`);
    startupLog.info(`📊 ${trackLookup.trackCount} tracks in index`);
  });

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      startupLog.error(`❌ Port ${port} already in use`);
      process.exit(1);
    }
    startupLog.error('Audio Server error:', err);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  console.log('Audio Server shutting down...');
  for (const [id, session] of sessions) {
    if (session.mixer && typeof session.mixer.destroy === 'function') {
      session.mixer.destroy();
    }
  }
  sessions.clear();
  if (serverInstance) {
    serverInstance.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

if (require.main === module) {
  start();
}

module.exports = { app, start };
