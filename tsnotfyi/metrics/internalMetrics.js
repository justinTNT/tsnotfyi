const os = require('os');

const MAX_RECENT_LOGS = 400;
const MAX_ROUTE_COUNT = 50;

const httpState = {
  bootTime: Date.now(),
  total: 0,
  totalTimeMs: 0,
  byRoute: new Map()
};

const logState = {
  counts: new Map(),
  recent: []
};

function normalizeRouteKey(method, path) {
  const safeMethod = (method || 'GET').toUpperCase();
  const safePath = path || '/unknown';
  return `${safeMethod} ${safePath}`;
}

function normalizeChannel(channel) {
  return channel || 'general';
}

function normalizeLevel(level) {
  return (level || 'INFO').toUpperCase();
}

function recordHttpRequest({ method, path, statusCode, durationMs }) {
  const routeKey = normalizeRouteKey(method, path);
  const entry = httpState.byRoute.get(routeKey) || {
    count: 0,
    totalTimeMs: 0,
    maxMs: 0,
    statusBuckets: {}
  };
  entry.count += 1;
  const safeDuration = Number.isFinite(durationMs) ? durationMs : 0;
  entry.totalTimeMs += safeDuration;
  entry.maxMs = Math.max(entry.maxMs, safeDuration);
  const statusBucket = Number.isFinite(statusCode)
    ? `${Math.floor(statusCode / 100) * 100}s`
    : 'unknown';
  entry.statusBuckets[statusBucket] = (entry.statusBuckets[statusBucket] || 0) + 1;
  httpState.byRoute.set(routeKey, entry);
  httpState.total += 1;
  httpState.totalTimeMs += safeDuration;
}

function recordLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return;
  }
  const channel = normalizeChannel(entry.channel);
  const level = normalizeLevel(entry.level);
  const key = `${channel}:${level}`;
  logState.counts.set(key, (logState.counts.get(key) || 0) + 1);
  logState.recent.push({
    timestamp: entry.timestamp || new Date().toISOString(),
    channel,
    level,
    message: entry.message || ''
  });
  if (logState.recent.length > MAX_RECENT_LOGS) {
    logState.recent.shift();
  }
}

function summarizeLogs() {
  const summary = {};
  for (const [key, count] of logState.counts.entries()) {
    const [channel, level] = key.split(':');
    if (!summary[channel]) {
      summary[channel] = {};
    }
    summary[channel][level] = count;
  }
  return summary;
}

function getRecentLogs(filter = {}) {
  const { channel, level, limit = 100 } = filter;
  const normalizedChannel = channel ? normalizeChannel(channel) : null;
  const normalizedLevel = level ? normalizeLevel(level) : null;
  const matched = [];
  for (let i = logState.recent.length - 1; i >= 0; i -= 1) {
    const entry = logState.recent[i];
    if (
      (normalizedChannel && entry.channel !== normalizedChannel) ||
      (normalizedLevel && entry.level !== normalizedLevel)
    ) {
      continue;
    }
    matched.push(entry);
    if (matched.length >= limit) {
      break;
    }
  }
  return matched;
}

function summarizeHttp() {
  const routes = Array.from(httpState.byRoute.entries()).map(([routeKey, info]) => {
    const avg = info.count ? info.totalTimeMs / info.count : 0;
    return {
      route: routeKey,
      count: info.count,
      avgMs: Number(avg.toFixed(2)),
      maxMs: Number(info.maxMs.toFixed(2)),
      status: info.statusBuckets
    };
  });
  routes.sort((a, b) => b.count - a.count);
  return {
    total: httpState.total,
    avgMs: httpState.total ? Number((httpState.totalTimeMs / httpState.total).toFixed(2)) : 0,
    routes: routes.slice(0, MAX_ROUTE_COUNT)
  };
}

function summarizeProcess() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    nodeVersion: process.version,
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    loadAverage: os.loadavg()
  };
}

function buildSessionSummary(sessionId, session) {
  if (!session) {
    return null;
  }
  const mixer = session.mixer || null;
  const driftPlayer = mixer?.driftPlayer || null;
  const history = mixer?.sessionHistory || [];
  const currentTrack = mixer?.currentTrack || null;
  const nextTrack = mixer?.nextTrack || null;
  return {
    sessionId,
    createdAt: session.created || null,
    lastAccess: session.lastAccess || null,
    awaitingClient: Boolean(session.awaitingAudioClient),
    clients: mixer?.clients ? mixer.clients.size : 0,
    isActive: Boolean(mixer?.isActive),
    currentDirection: driftPlayer?.currentDirection || null,
    trackStartTime: mixer?.trackStartTime || null,
    currentTrack: currentTrack
      ? {
          identifier: currentTrack.identifier || null,
          title: currentTrack.title || '',
          artist: currentTrack.artist || '',
          direction: currentTrack.direction || driftPlayer?.currentDirection || null
        }
      : null,
    nextTrack: nextTrack
      ? {
          identifier: nextTrack.identifier || null,
          title: nextTrack.title || '',
          artist: nextTrack.artist || '',
          direction: nextTrack.direction || mixer?.pendingUserOverrideDirection || null
        }
      : null,
    historyCount: history.length,
    explorer: mixer?.currentExplorerSummary ? {
      timestamp: mixer.currentExplorerSummary.timestamp,
      trackId: mixer.currentExplorerSummary.trackId,
      resolution: mixer.currentExplorerSummary.resolution,
      neighborhoodSize: mixer.currentExplorerSummary.neighborhoodSize,
      nextDirection: mixer.currentExplorerSummary.nextDirection,
      diversity: mixer.currentExplorerSummary.diversity || null,
      topDirections: mixer.currentExplorerSummary.topDirections || [],
      radius: mixer.currentExplorerSummary.radius || null
    } : null,
    explorerHistory: Array.isArray(mixer?.explorerHistory)
      ? mixer.explorerHistory.slice(-3).map(entry => ({
          timestamp: entry.timestamp,
          trackId: entry.trackId,
          neighborhoodSize: entry.neighborhoodSize,
          nextDirection: entry.nextDirection,
          radius: entry.radius,
          diversity: entry.diversity
        }))
      : [],
    events: Array.isArray(mixer?.sessionEvents)
      ? mixer.sessionEvents.slice(-10)
      : [],
    metrics: projectSessionEvents(mixer?.sessionEvents || [])
  };
}

function collectSessions(audioSessions, ephemeralSessions) {
  const summaries = [];
  if (audioSessions && typeof audioSessions.forEach === 'function') {
    audioSessions.forEach((session, sessionId) => {
      const summary = buildSessionSummary(sessionId, session);
      if (summary) {
        summaries.push(summary);
      }
    });
  }
  if (ephemeralSessions && typeof ephemeralSessions.forEach === 'function') {
    ephemeralSessions.forEach((session, sessionId) => {
      const summary = buildSessionSummary(sessionId, session);
      if (summary) {
        summary.ephemeral = true;
        summaries.push(summary);
      }
    });
  }
  summaries.sort((a, b) => {
    const timeA = a.lastAccess || 0;
    const timeB = b.lastAccess || 0;
    return timeB - timeA;
  });
  return summaries;
}

function summarizeAdaptiveRadius(audioSessions, ephemeralSessions) {
  const result = {
    sampleCount: 0,
    adaptiveCount: 0,
    fallbackCount: 0,
    averageRadius: null,
    latest: []
  };

  let radiusSum = 0;
  let radiusSampleCount = 0;

  const inspect = (collection) => {
    if (!collection || typeof collection.forEach !== 'function') {
      return;
    }
    collection.forEach((session, sessionId) => {
      const summary = session?.mixer?.currentExplorerSummary;
      const radius = summary?.radius;
      if (!radius) {
        return;
      }
      result.sampleCount += 1;
      if (radius.mode === 'adaptive') {
        result.adaptiveCount += 1;
      } else {
        result.fallbackCount += 1;
      }
      if (Number.isFinite(radius.radius)) {
        radiusSum += radius.radius;
        radiusSampleCount += 1;
      }
      if (result.latest.length < 10) {
        result.latest.push({
          sessionId,
          mode: radius.mode || 'unknown',
          radius: radius.radius ?? null,
          count: radius.count ?? null,
          withinTarget: radius.withinTarget ?? null,
          iterations: radius.iterations ?? null,
          timestamp: summary.timestamp
        });
      }
    });
  };

  inspect(audioSessions);
  inspect(ephemeralSessions);

  if (radiusSampleCount > 0) {
    result.averageRadius = radiusSum / radiusSampleCount;
  }

  return result;
}

function projectSessionEvents(events = []) {
  const metrics = {
    radiusAdjustments: { expand: 0, shrink: 0 },
    radiusRetries: 0,
    manualOverrides: { requested: 0, prepared: 0 },
    nextTrackSelections: { explorer: 0, manual: 0, other: 0 },
    lastExplorerSnapshot: null,
    lastTrackStart: null
  };

  events.forEach((event) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    const type = event.type;
    const data = event.data || {};
    switch (type) {
      case 'radius_adjustment':
        if (data.action === 'expand') {
          metrics.radiusAdjustments.expand += 1;
        } else if (data.action === 'shrink') {
          metrics.radiusAdjustments.shrink += 1;
        }
        break;
      case 'radius_retry':
        metrics.radiusRetries += 1;
        break;
      case 'manual_override_requested':
        metrics.manualOverrides.requested += 1;
        break;
      case 'manual_override_prepared':
        metrics.manualOverrides.prepared += 1;
        break;
      case 'next_track_selected': {
        const reason = (data.transitionReason || '').toLowerCase();
        if (reason === 'explorer') {
          metrics.nextTrackSelections.explorer += 1;
        } else if (reason === 'user' || reason === 'user-selection') {
          metrics.nextTrackSelections.manual += 1;
        } else {
          metrics.nextTrackSelections.other += 1;
        }
        break;
      }
      case 'explorer_snapshot':
        metrics.lastExplorerSnapshot = {
          timestamp: event.timestamp,
          trackId: data.trackId || null,
          nextDirection: data.nextDirection || null,
          neighborhoodSize: data.neighborhoodSize || null
        };
        break;
      case 'track_started':
        metrics.lastTrackStart = {
          timestamp: event.timestamp,
          trackId: data.trackId || null,
          reason: data.reason || null
        };
        break;
      default:
        break;
    }
  });

  return metrics;
}

function getMetricsSnapshot(extra = {}) {
  return {
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - httpState.bootTime,
    process: summarizeProcess(),
    http: summarizeHttp(),
    logs: summarizeLogs(),
    ...extra
  };
}

module.exports = {
  recordHttpRequest,
  recordLogEntry,
  getMetricsSnapshot,
  getRecentLogs,
  collectSessions,
  summarizeAdaptiveRadius,
  projectSessionEvents
};
