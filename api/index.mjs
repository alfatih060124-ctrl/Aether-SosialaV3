import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const json = (res, status, body) => res.status(status).json(body);
const liveEnabled = process.env.LIVE_ENABLED === 'true' && process.env.EXECUTION_MODE === 'LIVE';

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'https://aether.local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    return json(res, 200, { status: 'ok', service: 'aether-api', execution_mode: process.env.EXECUTION_MODE || 'SHADOW', live_enabled: liveEnabled });
  }
  if (req.method === 'GET' && path === '/api/readiness') {
    return json(res, 200, { status: 'ready', database: 'external-api-service', note: 'Database-backed readiness is checked by the API service.' });
  }
  if (req.method === 'GET' && path === '/api/execution/status') {
    return json(res, 200, { mode: process.env.EXECUTION_MODE || 'SHADOW', live_enabled: liveEnabled, fail_closed: !liveEnabled, signer_exposed_to_api: false });
  }

  // The Vercel deployment is the public web gateway. Database-backed operations
  // must be proxied to the separately deployed API service via API_SERVICE_URL.
  const base = process.env.API_SERVICE_URL;
  if (base && path.startsWith('/api/')) {
    const target = new URL(path + (url.search || ''), base.endsWith('/') ? base : `${base}/`);
    const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
    if (process.env.API_SERVICE_TOKEN) headers.authorization = `Bearer ${process.env.API_SERVICE_TOKEN}`;
    const upstream = await fetch(target, { method: req.method, headers });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  }

  return json(res, 404, { error: 'route_not_configured', message: 'Configure API_SERVICE_URL for database-backed API routes.' });
}
