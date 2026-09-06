const PRIMARY_API_ORIGIN = 'https://api.aether.boats';
const SESSION_COOKIE = 'aether_session';

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function json(res, status, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
  if (!token) return json(res, 401, { error: 'session_required' });
  try {
    const target = new URL('/api/account/paper-arbitrage/performance', PRIMARY_API_ORIGIN);
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
    return res.send(text);
  } catch {
    return json(res, 503, { error: 'primary_upstream_unavailable', mode: 'SHADOW', live_execution_authorized: false });
  }
}
