// Structured category logging
// Usage: import { createLogger } from './log.js';
//        const log = createLogger('tray');
//        log.info('loaded');  // → [tray] loaded
//
// Runtime control via window.LOG:
//   LOG.only('tray','sentinel')  — mute everything except these
//   LOG.mute('heartbeat')        — suppress one category
//   LOG.unmute('heartbeat')      — re-enable
//   LOG.level('warn')            — global minimum (suppress info+debug everywhere)
//   LOG.all()                    — reset to default (everything visible at info+)
//   LOG.verbose()                — show everything including debug
//   LOG.list()                   — show registered categories

const categories = {};
let muteSet = null;       // null = show all; Set = only show these
let blockSet = new Set(); // explicitly blocked
let globalLevel = 1;      // 0=debug, 1=info, 2=warn, 3=error

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(category) {
  const prefix = `[${category}]`;
  const logger = {
    debug: (...args) => emit(category, 'debug', prefix, args),
    info:  (...args) => emit(category, 'info',  prefix, args),
    warn:  (...args) => emit(category, 'warn',  prefix, args),
    error: (...args) => emit(category, 'error', prefix, args),
    category
  };
  categories[category] = logger;
  return logger;
}

function emit(category, level, prefix, args) {
  const levelNum = LEVELS[level];
  // warn and error always pass through
  if (levelNum < 2) {
    if (levelNum < globalLevel) return;
    if (blockSet.has(category)) return;
    if (muteSet !== null && !muteSet.has(category)) return;
  }
  const method = level === 'debug' ? 'log' : level === 'info' ? 'log' : level;
  console[method](prefix, ...args);
}

if (typeof window !== 'undefined') {
  window.LOG = {
    only:    (...cats) => { muteSet = new Set(cats); },
    mute:    (...cats) => { cats.forEach(c => blockSet.add(c)); },
    unmute:  (...cats) => { cats.forEach(c => blockSet.delete(c)); muteSet = null; },
    level:   (l) => { globalLevel = LEVELS[l] ?? 1; },
    all:     () => { muteSet = null; blockSet.clear(); globalLevel = 1; },
    verbose: () => { muteSet = null; blockSet.clear(); globalLevel = 0; },
    list:    () => Object.keys(categories),
  };
  window.createLogger = createLogger;
}
