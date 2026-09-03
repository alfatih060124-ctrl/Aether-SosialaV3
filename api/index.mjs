import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';
import { runAutoTradeTraining } from '../services/api/src/auto-trade-training.mjs';

const PRIMARY_API_ORIGIN = 'https://api.aether.boats';
const SESSION_COOKIE = 'aether_session';
const MAX_BODY_BYTES = 32768;
const marketIntelligence = createMarketIntelligenceService();

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

const AUTH_POST_ROUTES = new Set([
  '/api/auth/challenge',
  '/api/auth/verify',
  '/api/auth/logout',
]);

const SESSION_GET_ROUTES = new Set([
  '/api/auth/session',
  '/api/account/wallet-portfolio',
  '/api/account/trader',
  '/api/account/copy-mandates',
  '/api/account/copy-trades',
]);

const SESSION_POST_ROUTES = new Set([
  '/api/account/trader/challenge',
  '/api/account/trader/apply',
  '/api/account/copy-mandates',
  '/api/account/autotrade/evaluate',
]);

const json = (res, status, body) => {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.status(status).json(body);
};

function isPublicReadRoute(path) {
  if (PUBLIC_GET_ROUTES.has(path)) return true;
  return /^\/api\/traders\/[^/]+$/.test(path);
}
function isSessionPatchRoute(path) {
  return /^\/api\/account\/copy-mandates\/[^/]+$/.test(path);
}

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

function getSessionToken(req) {
  return parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
}

function sessionCookie(token, expiresAt) {
  const expiryMs = new Date(expiresAt || Date.now() + 30 * 24 * 60 * 60 * 1000).getTime();
  const maxAge = Math.max(60, Math.min(30 * 24 * 60 * 60, Math.floor((expiryMs - Date.now()) / 1000)));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Priority=High`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Priority=High`;
}

async function readBody(req) {
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('request_body_too_large');
    return raw;
  }
  if (['GET', 'HEAD'].includes(req.method)) return undefined;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('request_body_too_large');
  }
  return raw || undefined;
}

function primaryTarget(path, search = '') {
  const target = new URL(path + search, PRIMARY_API_ORIGIN);
  if (target.protocol !== 'https:' || target.hostname !== 'api.aether.boats') {
    throw new Error('primary_upstream_invalid');
  }
  return target;
}

async function requestPrimary(req, path, { method = req.method, body, sessionToken = '' } = {}) {
  const requestUrl = new URL(req.url || '/', 'https://aether.local');
  const target = primaryTarget(path, requestUrl.search || '');
  const headers = { accept: req.headers.accept || 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;

  const upstream = await fetch(target, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
  });

  return {
    status: upstream.status,
    contentType: upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    text: await upstream.text(),
  };
}

function sendUpstream(res, upstream) {
  res.status(upstream.status);
  res.setHeader('content-type', upstream.contentType);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.send(upstream.text);
}

function marketError(res, error) {
  const code = error instanceof Error ? error.message : 'market_provider_unavailable';
  if (code === 'invalid_token_mint' || code === 'token_mint_required' || code === 'invalid_market_discovery_view') {
    return json(res, 400, { error: code, read_only: true, live_execution_authorized: false });
  }
  if (code === 'market_token_not_found') {
    return json(res, 404, { error: code, read_only: true, live_execution_authorized: false });
  }
  if (code === 'market_provider_rate_limited') {
    return json(res, 503, { error: code, retryable: true, read_only: true, live_execution_authorized: false });
  }
  if (['market_provider_unavailable', 'market_provider_timeout', 'provider_network_down'].includes(code)) {
    return json(res, 503, { error: 'market_provider_unavailable', retryable: true, read_only: true, live_execution_authorized: false });
  }
  if (['market_provider_canonical_mismatch', 'invalid_market_provider_payload', 'market_provider_target_invalid'].includes(code)) {
    return json(res, 502, { error: code, read_only: true, live_execution_authorized: false });
  }
  return json(res, 503, { error: 'market_intelligence_unavailable', read_only: true, live_execution_authorized: false });
}

export default async function handler(req, res) {
  const requestUrl = new URL(req.url || '/', 'https://aether.local');
  const path = requestUrl.pathname.replace(/\/+$/, '') || '/';

  if (!path.startsWith('/api/')) {
    return json(res, 404, { error: 'not_found' });
  }

  try {
    if (req.method === 'GET' && path === '/api/market/discovery') {
      try {
        const data = await marketIntelligence.getDiscovery(requestUrl.searchParams.get('view') || 'trending');
        return json(res, 200, data);
      } catch (error) {
        return marketError(res, error);
      }
    }

    if (req.method === 'GET' && path === '/api/market/token') {
      const mint = requestUrl.searchParams.get('mint');
      if (!mint) return marketError(res, new Error('token_mint_required'));
      try {
        const data = await marketIntelligence.getToken(mint);
        return json(res, 200, data);
      } catch (error) {
        return marketError(res, error);
      }
    }

    if (path === '/api/market/token' || path === '/api/market/discovery') {
      return json(res, 405, { error: 'method_not_allowed', read_only: true, live_execution_authorized: false });
    }

    if (req.method === 'POST' && path === '/api/account/auto-strategy/simulate') {
      const token = getSessionToken(req);
      if (!token) return json(res, 401, { error: 'session_required' });
      const sessionCheck = await requestPrimary(req, '/api/auth/session', { method: 'GET', sessionToken: token });
      if (sessionCheck.status === 401) {
        res.setHeader('Set-Cookie', clearSessionCookie());
        return json(res, 401, { error: 'session_invalid' });
      }
      if (sessionCheck.status < 200 || sessionCheck.status >= 300) return sendUpstream(res, sessionCheck);
      let body = {};
      const raw = await readBody(req);
      if (raw) {
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid_json' }); }
      }
      try {
        return json(res, 200, {
          ...runAutoTradeTraining(body),
          authenticated_session: true,
          simulator_runtime: 'PUBLIC_EDGE',
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_training_scenario') {
          return json(res, 400, { error: 'invalid_training_scenario', mode: 'SHADOW', live_execution_authorized: false });
        }
        return json(res, 503, { error: 'auto_strategy_simulator_unavailable', mode: 'SHADOW', live_execution_authorized: false });
      }
    }

    if (path === '/api/account/auto-strategy/simulate') {
      return json(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
    }

    if (req.method === 'GET' && isPublicReadRoute(path)) {
      return sendUpstream(res, await requestPrimary(req, path, { method: 'GET' }));
    }

    if (req.method === 'GET' && SESSION_GET_ROUTES.has(path)) {
      const token = getSessionToken(req);
      if (!token) return json(res, 401, { error: 'session_required' });
      const upstream = await requestPrimary(req, path, { method: 'GET', sessionToken: token });
      if (upstream.status === 401) res.setHeader('Set-Cookie', clearSessionCookie());
      return sendUpstream(res, upstream);
    }

    if (req.method === 'POST' && path === '/api/auth/challenge') {
      const body = await readBody(req);
      return sendUpstream(res, await requestPrimary(req, path, { method: 'POST', body }));
    }

    if (req.method === 'POST' && path === '/api/auth/verify') {
      const body = await readBody(req);
      const upstream = await requestPrimary(req, path, { method: 'POST', body });
      if (upstream.status < 200 || upstream.status >= 300) return sendUpstream(res, upstream);

      let payload;
      try { payload = JSON.parse(upstream.text); } catch { return json(res, 502, { error: 'invalid_auth_upstream_response' }); }
      const token = payload?.session?.token;
      const expiresAt = payload?.session?.expires_at;
      if (!token || !expiresAt) return json(res, 502, { error: 'auth_session_missing' });

      res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
      const safePayload = {
        user: payload.user,
        account_created: Boolean(payload.account_created),
        session: {
          session_id: payload.session.session_id,
          expires_at: payload.session.expires_at,
          storage: 'HTTP_ONLY_COOKIE',
        },
      };
      return json(res, 200, safePayload);
    }

    if (req.method === 'POST' && path === '/api/auth/logout') {
      const token = getSessionToken(req);
      res.setHeader('Set-Cookie', clearSessionCookie());
      if (!token) return json(res, 200, { revoked: false, local_session_cleared: true });
      const upstream = await requestPrimary(req, path, { method: 'POST', sessionToken: token });
      if (upstream.status === 401) return json(res, 200, { revoked: false, local_session_cleared: true });
      return sendUpstream(res, upstream);
    }

    if (req.method === 'POST' && SESSION_POST_ROUTES.has(path)) {
      const token = getSessionToken(req);
      if (!token) return json(res, 401, { error: 'session_required' });
      const body = await readBody(req);
      const upstream = await requestPrimary(req, path, { method: 'POST', body, sessionToken: token });
      if (upstream.status === 401) res.setHeader('Set-Cookie', clearSessionCookie());
      return sendUpstream(res, upstream);
    }

    if (req.method === 'PATCH' && isSessionPatchRoute(path)) {
      const token = getSessionToken(req);
      if (!token) return json(res, 401, { error: 'session_required' });
      const body = await readBody(req);
      const upstream = await requestPrimary(req, path, { method: 'PATCH', body, sessionToken: token });
      if (upstream.status === 401) res.setHeader('Set-Cookie', clearSessionCookie());
      return sendUpstream(res, upstream);
    }

    if (AUTH_POST_ROUTES.has(path) || SESSION_GET_ROUTES.has(path) || SESSION_POST_ROUTES.has(path) || isSessionPatchRoute(path)) {
      return json(res, 405, { error: 'method_not_allowed' });
    }

    return json(res, 403, {
      error: 'public_gateway_route_blocked',
      deployment_role: 'PUBLIC_EDGE',
      primary_runtime: 'PRIMARY_VM',
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'request_body_too_large') {
      return json(res, 413, { error: 'request_body_too_large' });
    }
    return json(res, 503, {
      error: 'primary_upstream_unavailable',
      deployment_role: 'PUBLIC_EDGE',
      message: error instanceof Error ? error.message : 'upstream_request_failed',
    });
  }
}
