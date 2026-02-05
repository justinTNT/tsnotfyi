const fs = require('fs');
const path = require('path');
const internalMetrics = require('./metrics/internalMetrics');

const AVAILABLE_CHANNELS = [
  'all',
  'general',
  'startup',
  'server',
  'session',
  'sse',
  'timing',
  'explorer',
  'search',
  'mixer',
  'vae',
  'database',
  'http',
  'heartbeat',
  'cache'
];

const DEFAULT_LOG_FLAGS = AVAILABLE_CHANNELS.reduce((acc, channel) => {
  acc[channel] = channel === 'all' ? true : true;
  return acc;
}, {});

let activeFlags = { ...DEFAULT_LOG_FLAGS };
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const DEFAULT_LOG_ROOT = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_DIRECTORIES = {
  server: path.join(DEFAULT_LOG_ROOT, 'server'),
  client: path.join(DEFAULT_LOG_ROOT, 'client')
};
const logStreams = new Map();
// Per-restart suffix so each server start gets its own log file
const RESTART_SUFFIX = new Date().toISOString().slice(11, 19).replace(/:/g, '');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getLogStream(type) {
  const dirPath = LOG_DIRECTORIES[type];
  if (!dirPath) {
    throw new Error(`Unknown log type: ${type}`);
  }
  ensureDirectory(dirPath);
  const dateKey = new Date().toISOString().slice(0, 10);
  const streamKey = `${type}:${dateKey}`;
  if (logStreams.has(streamKey)) {
    return logStreams.get(streamKey);
  }
  const filePath = path.join(dirPath, `${dateKey}_${RESTART_SUFFIX}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  logStreams.set(streamKey, stream);
  return stream;
}

function safeSerialize(value) {
  if (value === null || value === undefined) {
    return String(value);
  }
  const type = typeof value;
  if (type === 'string') {
    return value;
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint') {
    return String(value);
  }
  if (type === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') {
        return `${val.toString()}n`;
      }
      if (typeof val === 'function') {
        return `[Function ${val.name || 'anonymous'}]`;
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch (error) {
    return `<<unserializable: ${error?.message || error}>>`;
  }
}

function writeServerLogEntry(level, channel, args) {
  try {
    const stream = getLogStream('server');
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      channel: channel || 'general',
      message: (args || []).map(arg => safeSerialize(arg)).join(' ')
    };
    stream.write(`${JSON.stringify(entry)}\n`);
    internalMetrics.recordLogEntry(entry);
  } catch (error) {
    nativeConsole.error('[logger:error]', error);
  }
}

function writeClientLogBatch(sessionId, entries = [], extra = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  try {
    const stream = getLogStream('client');
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const line = {
        timestamp: entry.timestamp || new Date().toISOString(),
        level: (entry.level || 'log').toUpperCase(),
        sessionId: sessionId || null,
        message: entry.message || '',
        fragments: entry.fragments || [],
        reason: extra.reason || 'unspecified',
        clientTimestamp: extra.clientTimestamp || null
      };
      stream.write(`${JSON.stringify(line)}\n`);
    });
  } catch (error) {
    nativeConsole.error('[client-log:error]', error);
    throw error;
  }
}

function cloneFlags() {
  return { ...activeFlags };
}

function enableChannel(channel, enabled) {
  if (!channel) return;
  activeFlags[channel] = enabled;
}

function applyFlagSpec(spec) {
  if (!spec || typeof spec !== 'string') {
    return;
  }
  const tokens = spec
    .split(',')
    .map(token => token.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return;
  }

  // When explicit spec provided, default to all=false unless explicitly re-enabled
  activeFlags = { ...DEFAULT_LOG_FLAGS, all: false };

  tokens.forEach(token => {
    let enabled = true;
    let channel = token;
    if (token.startsWith('+')) {
      channel = token.slice(1);
      enabled = true;
    } else if (token.startsWith('-') || token.startsWith('!')) {
      channel = token.slice(1);
      enabled = false;
    }

    if (channel === 'all') {
      activeFlags.all = enabled;
    } else {
      activeFlags[channel] = enabled;
    }
  });
}

function configureLogFlags(overrides = {}) {
  if (!overrides || typeof overrides !== 'object') {
    return cloneFlags();
  }
  Object.entries(overrides).forEach(([channel, value]) => {
    if (channel in activeFlags && typeof value === 'boolean') {
      activeFlags[channel] = value;
    }
  });
  return cloneFlags();
}

function configureFromSpec(spec) {
  applyFlagSpec(spec);
  return cloneFlags();
}

const ENV_SPEC =
  process.env.SERVER_LOG_CHANNELS ||
  process.env.LOG_CHANNELS ||
  process.env.DEBUG_LOG_CHANNELS;
if (ENV_SPEC) {
  applyFlagSpec(ENV_SPEC);
}

function shouldLog(channel) {
  if (!channel) return activeFlags.all;
  return Boolean(activeFlags.all || activeFlags[channel]);
}

function formatPrefix(channel, level) {
  return `[${channel || 'general'}:${level}]`;
}

function logChannel(level, channel, ...args) {
  const prefix = formatPrefix(channel, level);
  writeServerLogEntry(level, channel, args);
  if (level === 'error') {
    nativeConsole.error(prefix, ...args);
    return;
  }
  if (!shouldLog(channel)) {
    return;
  }
  const target = level === 'warn' ? nativeConsole.warn : nativeConsole.log;
  target(prefix, ...args);
}

function createLogger(channel) {
  const safeChannel = channel || 'general';
  return {
    info: (...args) => logChannel('info', safeChannel, ...args),
    warn: (...args) => logChannel('warn', safeChannel, ...args),
    error: (...args) => logChannel('error', safeChannel, ...args)
  };
}

module.exports = {
  createLogger,
  logInfo: (channel, ...args) => logChannel('info', channel, ...args),
  logWarn: (channel, ...args) => logChannel('warn', channel, ...args),
  logError: (channel, ...args) => logChannel('error', channel, ...args),
  shouldLog,
  getLogFlags: cloneFlags,
  configureLogFlags,
  configureFromSpec,
  writeClientLogBatch
};

// Override default console to route through general channel
console.log = (...args) => logChannel('info', 'general', ...args);
console.warn = (...args) => logChannel('warn', 'general', ...args);
console.error = (...args) => logChannel('error', 'general', ...args);
