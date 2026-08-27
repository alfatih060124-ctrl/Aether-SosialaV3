import http from 'node:http';
import { Pool } from 'pg';
import { createTradeEventRepository } from './repositories/trade-events.mjs';
import { createExecutionRequestRepository } from './repositories/execution-requests.mjs';
import { createCoreRepositories } from './repositories/core.mjs';

const PORT = Number(process.env.PORT || 8080);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const repos = pool ? {
  tradeEvents: createTradeEventRepository(pool),
  executionRequests: createExecutionRequestRepository(pool),
  ...createCoreRepositories(pool)
} : null;

const send = (res, status, body, type='application/json; charset=utf-8') => {
  res.writeHead(status, {'content-type':type,'cache-control':'no-store'});
  res.end(type.startsWith('text/') ? body : JSON.stringify(body));
};
const auth = (req) => !process.env.API_TOKEN || req.headers.authorization === `Bearer ${process.env.API_TOKEN}`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, {status:'ok',service:'aether-api',execution_mode:executionMode,live_enabled:liveEnabled});
    if (req.method === 'GET' && req.url === '/api/readiness') {
      if (!pool) return send(res, 503, {status:'not_ready',database:'unconfigured'});
      try { await pool.query('SELECT 1'); return send(res, 200, {status:'ready',database:'ok'}); }
      catch { return send(res, 503, {status:'not_ready',database:'unavailable'}); }
    }
    if (req.method === 'GET' && req.url === '/api/execution/status') return send(res, 200, {mode:executionMode,live_enabled:liveEnabled,fail_closed:!liveEnabled,signer_exposed_to_api:false});
    if (!auth(req) && req.url.startsWith('/api/')) return send(res, 401, {error:'unauthorized'});
    if (req.method === 'GET' && req.url.startsWith('/api/trades')) {
      if (!repos) return send(res, 503, {error:'database_unconfigured'});
      return send(res, 200, {items: await repos.tradeEvents.recent(new URL(req.url,'http://localhost').searchParams.get('limit'))});
    }
    if (req.method === 'GET' && req.url.startsWith('/api/traders')) {
      if (!repos) return send(res, 503, {error:'database_unconfigured'});
      const rows = await pool.query('SELECT * FROM traders ORDER BY created_at DESC LIMIT 200');
      return send(res, 200, {items:rows.rows});
    }
    if (req.method === 'GET' && req.url === '/api/executions') {
      if (!repos) return send(res, 503, {error:'database_unconfigured'});
      const rows = await pool.query('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT 200');
      return send(res, 200, {items:rows.rows});
    }
    if (req.method === 'GET' && req.url === '/' || req.url === '/dashboard') return send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Aether Social V3</title></head><body><main><h1>Aether Social V3</h1><p>Public API dashboard</p><p>Execution mode: '+executionMode+'</p><p>Live enabled: '+liveEnabled+'</p></main></body></html>','text/html; charset=utf-8');
    return send(res,404,{error:'not_found'});
  } catch (error) { console.error(error); return send(res,500,{error:'internal_error'}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Aether API listening on ${PORT}`));
