const PRIMARY_API_ORIGIN = 'https://api.aether.boats';
const PUBLIC_GET_ROUTES = new Set([
  '/api/health',
  '/api/readiness',
  '/api/version',
  '/api/execution/status',
  '/api/signals/config',
  '/api/autotrade/status',
  '/api/trades',
  '/api/traders',
  '/api/marketplace/fees',
]);

const json = (res, status, body) => res.status(status).json(body);

function isPublicReadRoute(path) {
  if (PUBLIC_GET_ROUTES.has(path)) return true;
  return /^\/api\/traders\/[^/]+$/.test(path);
}

async function proxyPublicGet(req, res, path) {
  const requestUrl = new URL(req.url || '/', 'https://aether.local');
  const target = new URL(path + requestUrl.search, PRIMARY_API_ORIGIN);

  if (target.protocol !== 'https:' || target.hostname !== 'api.aether.boats') {
    return json(res, 503, {
      error: 'primary_upstream_invalid',
      deployment_role: 'PUBLIC_EDGE',
    });
  }

  const upstream = await fetch(target, {
    method: 'GET',
    headers: { accept: req.headers.accept || 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const text = await upstream.text();

  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.send(text);
}

export default async function handler(req, res) {
  const requestUrl = new URL(req.url || '/', 'https://aether.local');
  const path = requestUrl.pathname.replace(/\/+$/, '') || '/';

  if (!path.startsWith('/api/')) {
    return json(res, 404, { error: 'not_found' });
  }

  // Vercel is a public edge/read layer only. It never carries admin,
  // execution, simulation, billing, signal-mutation, or service credentials.
  if (req.method !== 'GET' || !isPublicReadRoute(path)) {
    return json(res, 403, {
      error: 'public_gateway_route_blocked',
      deployment_role: 'PUBLIC_EDGE',
      primary_runtime: 'PRIMARY_VM',
    });
  }

  try {
    return await proxyPublicGet(req, res, path);
  } catch (error) {
    return json(res, 503, {
      error: 'primary_upstream_unavailable',
      deployment_role: 'PUBLIC_EDGE',
      message: error instanceof Error ? error.message : 'upstream_request_failed',
    });
  }
}
