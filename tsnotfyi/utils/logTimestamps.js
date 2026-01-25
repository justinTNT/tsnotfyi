const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

if (!console.__tsPatched) {
  LEVELS.forEach(level => {
    const original = typeof console[level] === 'function' ? console[level].bind(console) : null;
    if (!original) {
      return;
    }
    console[level] = (...args) => {
      const timestamp = new Date().toISOString();
      original(`[${timestamp}]`, ...args);
    };
  });
  Object.defineProperty(console, '__tsPatched', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}
