const PRIMARY_API_ORIGIN = 'https://api.aether.boats';
const SESSION_COOKIE = 'aether_session';
const ROUTES = Object.freeze({
  status: '/api/account/subscription',
  quote: '/api/account/subscription/quote',
  verify: '/api/account/subscription/verify'
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

function actionFor(req) {
  const action = String(req.query?.action || '').trim();
  if (!ROUTES[action]) return null;
  return action;
}

export default async function handler(req, res) {
  const action = actionFor(req);
  if (!action) return json(res, 404, { error: 'subscription_action_not_found' });
  const expectedMethod = action === 'status' ? 'GET' : 'POST';
  if (req.method !== expectedMethod) return json(res, 405, { error: 'method_not_allowed' });
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
  if (!token) return json(res, 401, { error: 'session_required' });

  try {
    const target = new URL(ROUTES[action], PRIMARY_API_ORIGIN);
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    let body;
    if (req.method === 'POST') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body && typeof req.body === 'object' ? req.body : {});
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
    return res.send(text);
  } catch {
    return json(res, 503, {
      error: 'primary_upstream_unavailable',
      mode: 'SHADOW',
      transaction_submission_authorized: false,
      signing_authorized: false,
      live_execution_authorized: false
    });
  }
}
