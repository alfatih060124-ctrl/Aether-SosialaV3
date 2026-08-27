import http from 'node:http';
import { Pool } from 'pg';

const PORT = Number(process.env.PORT || 8080);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const send = (res, status, body, type='application/json; charset=utf-8') => {
  res.writeHead(status, {'content-type':type,'cache-control':'no-store'});
  res.end(type.startsWith('text/') ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      return send(res, 200, { status:'ok', service:'aether-api', execution_mode:executionMode, live_enabled:liveEnabled });
    }
    if (req.method === 'GET' && req.url === '/api/readiness') {
      if (!pool) return send(res, 503, {status:'not_ready', database:'unconfigured'});
      try { await pool.query('SELECT 1'); return send(res, 200, {status:'ready', database:'ok'}); }
      catch { return send(res, 503, {status:'not_ready', database:'unavailable'}); }
    }
    if (req.method === 'GET' && req.url === '/api/execution/status') {
      return send(res, 200, { mode:executionMode, live_enabled:liveEnabled, fail_closed:!liveEnabled, signer_exposed_to_api:false });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
      return send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Aether Social V3</title></head><body><main><h1>Aether Social V3</h1><p>Public API dashboard</p><p>Execution mode: '+executionMode+'</p><p>Live enabled: '+liveEnabled+'</p></main></body></html>', 'text/html; charset=utf-8');
    }
    return send(res, 404, {error:'not_found'});
  } catch { return send(res, 500, {error:'internal_error'}); }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Aether API listening on ${PORT}`));
