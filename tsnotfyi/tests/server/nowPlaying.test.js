jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((...args) => {
      const [filePath, options] = args;
      if (typeof filePath === 'string' && filePath.endsWith('tsnotfyi-config.json')) {
        const config = {
          server: {
            port: 3001,
            pidFile: 'server.pid',
            primedSessionCount: 0
          },
          database: {
            type: 'postgresql',
            path: 'test.db',
            postgresql: {
              connectionString: 'postgres://test'
            }
          },
          session: {
            secret: 'test-secret',
            maxAge: 3600000,
            cookieSecure: false,
            cookieName: 'test-session'
          }
        };
        return typeof options === 'string' ? JSON.stringify(config) : Buffer.from(JSON.stringify(config));
      }
      return actual.readFileSync(...args);
    })
  };
});

jest.mock('../../radial-search', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getStats: jest.fn(() => ({})),
    kdTree: {
      getTrack: jest.fn()
    }
  }));
});

jest.mock('../../services/vaeService', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    shutdown: jest.fn()
  }));
});

jest.mock('../../drift-audio-mixer', () => {
  return jest.fn().mockImplementation(() => ({
    clients: new Set(),
    eventClients: new Set(),
    destroy: jest.fn()
  }));
});

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      query: jest.fn(),
      end: jest.fn()
    }))
  };
});

process.env.SKIP_SERVICE_INIT = '1';
jest.useFakeTimers();

const { app, unregisterSession } = require('../../server');

function getRouterStack() {
  const router = app.router || app._router;
  return router && Array.isArray(router.stack) ? router.stack : [];
}

function invokeRoute(method, path, reqOverrides = {}) {
  const stack = getRouterStack();
  const layer = stack.find(
    (entry) => entry.route && entry.route.path === path && Boolean(entry.route.methods[method])
  );

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  const handler = layer.route.stack[0].handle;
  const req = { method: method.toUpperCase(), ...reqOverrides };

  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonBody = payload;
      return this;
    }
  };

  handler(req, res);

  return { statusCode, jsonBody };
}

describe('GET /sessions/now-playing', () => {
  beforeEach(() => {
    // Ensure test isolation in case other tests register sessions later
    unregisterSession('test-session');
  });

  test('responds with an empty sessions array when no mixers are active', async () => {
    console.log('app keys', Object.keys(app));
    const stack = getRouterStack().map(layer => layer && layer.route && layer.route.path).filter(Boolean);
    console.log('routes registered', stack);
    const { statusCode, jsonBody } = invokeRoute('get', '/sessions/now-playing');

    expect(statusCode).toBe(200);
    expect(jsonBody).toMatchObject({
      status: 'ok'
    });
    expect(Array.isArray(jsonBody.sessions)).toBe(true);
    expect(jsonBody.sessions.length).toBe(0);
  });
});
