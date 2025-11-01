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
  configureFromSpec
};

// Override default console to route through general channel
console.log = (...args) => logChannel('info', 'general', ...args);
console.warn = (...args) => logChannel('warn', 'general', ...args);
console.error = (...args) => logChannel('error', 'general', ...args);
