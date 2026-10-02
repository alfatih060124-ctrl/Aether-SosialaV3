const PRIMARY = 'https://api.aether.boats/api/account/auto-strategy/market-shadow';
const SESSION_COOKIE = 'aether_session';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return json(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
  }

  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
  if (!token) return json(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });

  try {
    const upstream = await fetch(PRIMARY, {
      method: req.method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(7000)
    });
    const text = await upstream.text();
    if (upstream.status === 401) {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Priority=High`);
    }
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
    return res.send(text);
  } catch (error) {
    return json(res, 503, {
      error: 'primary_upstream_unavailable',
      message: error instanceof Error ? error.message : 'upstream_request_failed',
      mode: 'SHADOW',
      execution_dispatched: false,
      transaction_signed: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }
}
