const PRIMARY_API_ORIGIN = 'https://api.aether.boats';
const SESSION_COOKIE = 'aether_session';
const ROUTES = Object.freeze({
  state: '/api/account/autotrade/state',
  start: '/api/account/autotrade/start',
  stop: '/api/account/autotrade/stop'
});

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
  const action = String(req.query?.action || '').trim();
  const targetPath = ROUTES[action];
  if (!targetPath) return json(res, 404, { error: 'autotrade_state_action_not_found' });
  const expectedMethod = action === 'state' ? 'GET' : 'POST';
  if (req.method !== expectedMethod) return json(res, 405, { error: 'method_not_allowed' });

  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
  if (!token) return json(res, 401, { error: 'session_required' });

  try {
    const upstream = await fetch(new URL(targetPath, PRIMARY_API_ORIGIN), {
      method: req.method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
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
  } catch {
    return json(res, 503, {
      error: 'primary_upstream_unavailable',
      mode: 'SHADOW',
      execution_dispatched: false,
      transaction_submission_authorized: false,
      signer_authorized: false,
      fund_movement_authorized: false,
      live_execution_authorized: false
    });
  }
}
