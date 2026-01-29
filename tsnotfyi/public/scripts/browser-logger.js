// Browser logging module - sends console output to server
// Must be loaded before page.js

// Set to true to disable all client-to-server logging (for performance testing)
const BROWSER_LOGGING_DISABLED = false;

const CLIENT_LOG_ENDPOINT = '/client-logs';
const BROWSER_LOG_BATCH_LIMIT = 40;
const BROWSER_LOG_SCHEDULE_DELAY_MS = 3000;
const BROWSER_LOG_FLUSH_INTERVAL_MS = 12000;
const BROWSER_LOG_MAX_MESSAGE_LENGTH = 800;

const browserLogBuffer = [];
let browserLogFlushTimer = null;

function safeSerializeValue(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    const valueType = typeof value;
    if (valueType === 'string') {
        return value;
    }
    if (valueType === 'number' || valueType === 'boolean') {
        return String(value);
    }
    if (valueType === 'bigint') {
        return `${value.toString()}n`;
    }
    if (valueType === 'function') {
        return `[Function ${value.name || 'anonymous'}]`;
    }
    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }
    if (typeof Element !== 'undefined' && value instanceof Element) {
        return `<${value.tagName?.toLowerCase() || 'element'}>`;
    }

    try {
        const seen = new WeakSet();
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
    } catch (err) {
        return `<<unserializable: ${err?.message || err}>>`;
    }
}

function clampLogMessage(message) {
    if (!message) {
        return '';
    }
    if (message.length <= BROWSER_LOG_MAX_MESSAGE_LENGTH) {
        return message;
    }
    return `${message.slice(0, BROWSER_LOG_MAX_MESSAGE_LENGTH)}…`;
}

function flushBrowserLogs(reason = 'manual', options = {}) {
    if (!browserLogBuffer.length) {
        return;
    }
    const entries = browserLogBuffer.splice(0, browserLogBuffer.length);
    browserLogFlushTimer = null;

    const payload = {
        sessionId: (typeof window !== 'undefined' && window.state && window.state.sessionId) || null,
        reason,
        clientTimestamp: Date.now(),
        entries
    };

    const json = JSON.stringify(payload);
    if (options.sync && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const ok = navigator.sendBeacon(CLIENT_LOG_ENDPOINT, blob);
            if (ok) {
                return;
            }
        } catch (_) {
            // Fall through to fetch path below
        }
    }

    if (typeof fetch === 'function') {
        fetch(CLIENT_LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json,
            keepalive: Boolean(options.sync)
        }).catch(() => {});
    }
}

function scheduleBrowserLogFlush(reason) {
    if (browserLogFlushTimer) {
        return;
    }
    browserLogFlushTimer = setTimeout(() => {
        flushBrowserLogs(reason);
    }, BROWSER_LOG_SCHEDULE_DELAY_MS);
}

function bufferBrowserConsoleEntry({ level, timestamp, args, fragments }) {
    if (BROWSER_LOGGING_DISABLED) return;
    const messageParts = (args || []).map((arg) => safeSerializeValue(arg));
    const message = clampLogMessage(messageParts.join(' '));
    const entry = {
        level,
        timestamp,
        message,
        fragments: Array.isArray(fragments) ? fragments.slice(0, 3) : []
    };
    browserLogBuffer.push(entry);
    if (browserLogBuffer.length >= BROWSER_LOG_BATCH_LIMIT) {
        flushBrowserLogs('batch-limit');
    } else {
        scheduleBrowserLogFlush('scheduled');
    }
}

// Setup window event listeners
if (typeof window !== 'undefined') {
    window.__flushBrowserLogs = () => flushBrowserLogs('manual');
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => flushBrowserLogs('beforeunload', { sync: true }));
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushBrowserLogs('visibilitychange', { sync: true });
            }
        });
    }
    if (typeof window.setInterval === 'function') {
        setInterval(() => flushBrowserLogs('interval'), BROWSER_LOG_FLUSH_INTERVAL_MS);
    }
}

// Patch console methods to capture and buffer logs
(() => {
    if (typeof console === 'undefined' || console.__tsPatchedBrowser) {
        return;
    }

    const isSerializableObject = (value) => {
        if (!value || typeof value !== 'object') {
            return false;
        }
        if (value instanceof Error) {
            return false;
        }
        if (typeof Element !== 'undefined' && value instanceof Element) {
            return false;
        }
        return true;
    };

    const SafeStringify = (value) => {
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
            }, 2);
        } catch (err) {
            return `<<unserializable: ${err?.message || err}>>`;
        }
    };

    ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
        if (typeof console[level] !== 'function') {
            return;
        }
        const original = console[level].bind(console);
        console[level] = (...args) => {
            const timestamp = new Date().toISOString();
            const jsonFragments = [];
            args.forEach((arg) => {
                if (isSerializableObject(arg)) {
                    const json = SafeStringify(arg);
                    jsonFragments.push(`↳ ${json}`);
                }
            });
            bufferBrowserConsoleEntry({ level, timestamp, args, fragments: jsonFragments });
            original(`[${timestamp}]`, ...args, ...jsonFragments);
        };
    });

    Object.defineProperty(console, '__tsPatchedBrowser', {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
})();
