const json = (res, status, body) => res.status(status).json(body);
const liveEnabled = process.env.LIVE_ENABLED === 'true' && process.env.EXECUTION_MODE === 'LIVE';
const base = process.env.API_SERVICE_URL || 'https://aether-social-v3-api.onrender.com';

async function proxyUpstream(path, req, res) {
  const url = new URL(req.url || '/', 'https://aether.local');
  const target = new URL(path + (url.search || ''), base.endsWith('/') ? base : `${base}/`);
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (process.env.API_SERVICE_TOKEN) headers.authorization = `Bearer ${process.env.API_SERVICE_TOKEN}`;
  const upstream = await fetch(target, { method: req.method, headers });
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
  return res.send(text);
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'https://aether.local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'aether-api-gateway',
      execution_mode: process.env.EXECUTION_MODE || 'SHADOW',
      live_enabled: liveEnabled,
      upstream: base,
    });
  }

  // Database readiness must come from the real API service, not a hard-coded gateway response.
  if (req.method === 'GET' && path === '/api/readiness') {
    try {
      return await proxyUpstream('/api/readiness', req, res);
    } catch (error) {
      return json(res, 503, {
        status: 'not_ready',
        database: 'upstream_unavailable',
        error: error instanceof Error ? error.message : 'upstream_request_failed',
      });
    }
  }

  if (req.method === 'GET' && path === '/api/execution/status') {
    return json(res, 200, {
      mode: process.env.EXECUTION_MODE || 'SHADOW',
      live_enabled: liveEnabled,
      fail_closed: !liveEnabled,
      signer_exposed_to_api: false,
    });
  }

  if (path.startsWith('/api/')) {
    try {
      return await proxyUpstream(path, req, res);
    } catch (error) {
      return json(res, 503, {
        error: 'upstream_unavailable',
        message: error instanceof Error ? error.message : 'upstream_request_failed',
      });
    }
  }

  return json(res, 404, { error: 'not_found' });
}
