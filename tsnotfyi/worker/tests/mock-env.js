// Mock Cloudflare bindings for testing
// In-memory implementations of KV, D1, and R2

export class MockKV {
  constructor() {
    this._store = new Map();
    this._ttls = new Map();
  }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    const ttl = this._ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this._store.delete(key);
      this._ttls.delete(key);
      return null;
    }
    return entry;
  }

  async put(key, value, options = {}) {
    this._store.set(key, value);
    if (options.expirationTtl) {
      this._ttls.set(key, Date.now() + options.expirationTtl * 1000);
    }
  }

  async delete(key) {
    this._store.delete(key);
    this._ttls.delete(key);
  }

  // Test helper
  _dump() {
    return Object.fromEntries(this._store);
  }
}

export class MockD1 {
  constructor() {
    this._tables = {};
  }

  prepare(sql) {
    return new MockD1Statement(this, sql);
  }

  // Test helper: seed data
  _seed(table, rows) {
    this._tables[table] = rows;
  }

  _getTable(table) {
    return this._tables[table] || [];
  }
}

class MockD1Statement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._bindings = [];
  }

  bind(...args) {
    this._bindings = args;
    return this;
  }

  async first() {
    // Simple mock: return null (tests that need real D1 results should override)
    return null;
  }

  async run() {
    return { success: true, meta: {} };
  }

  async all() {
    return { results: [] };
  }
}

export class MockR2 {
  constructor() {
    this._objects = new Map();
  }

  async get(key) {
    const data = this._objects.get(key);
    if (!data) return null;
    return {
      size: data.length,
      async json() { return JSON.parse(data); },
      async text() { return data; }
    };
  }

  async put(key, data) {
    this._objects.set(key, typeof data === 'string' ? data : JSON.stringify(data));
  }

  async list() {
    return {
      objects: Array.from(this._objects.entries()).map(([key, val]) => ({
        key,
        size: val.length
      }))
    };
  }

  // Test helper
  _seed(key, data) {
    this._objects.set(key, typeof data === 'string' ? data : JSON.stringify(data));
  }
}

export function createMockEnv(overrides = {}) {
  return {
    METADATA: new MockKV(),
    SESSIONS: new MockKV(),
    DB: new MockD1(),
    LIBRARY: new MockR2(),
    AUDIO_SERVER_URL: 'http://localhost:3002',
    API_SERVER_URL: 'http://localhost:3003',
    COVERS_URL: 'https://covers.tsnot.fyi',
    ...overrides
  };
}
