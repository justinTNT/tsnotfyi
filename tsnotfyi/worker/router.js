// Minimal URL pattern router for Cloudflare Workers

export class Router {
  constructor() {
    this.routes = [];
  }

  get(path, handler) { this.routes.push({ method: 'GET', path, handler }); }
  post(path, handler) { this.routes.push({ method: 'POST', path, handler }); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, url.pathname);
      if (params !== null) {
        try {
          return await route.handler({ request, url, params, env, ctx });
        } catch (err) {
          console.error(`Error in ${method} ${route.path}:`, err);
          return json({ error: 'Internal error' }, 500);
        }
      }
    }
    return null; // no match
  }
}

// Simple path matcher with :param support
function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
