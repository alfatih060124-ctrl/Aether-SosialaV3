import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const ROLE = 'STANDBY_RENDER';

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      service: 'aether-standby',
      deployment_role: ROLE,
      traffic_authorized: false,
      execution_mode: 'SHADOW',
      live_enabled: false,
      database_attached: false
    });
  }

  if (req.method === 'GET' && path === '/api/execution/status') {
    return send(res, 200, {
      mode: 'SHADOW',
      deployment_role: ROLE,
      live_enabled: false,
      fail_closed: true,
      execution_dispatched: false,
      signer_exposed_to_api: false
    });
  }

  if (req.method === 'GET' && path === '/api/readiness') {
    return send(res, 503, {
      status: 'standby',
      deployment_role: ROLE,
      traffic_authorized: false,
      database: 'detached',
      reason: 'render_is_not_a_primary_runtime'
    });
  }

  return send(res, 503, {
    error: 'standby_not_routable',
    deployment_role: ROLE,
    traffic_authorized: false,
    live_enabled: false
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[aether-standby] listening on ${PORT}; primary traffic disabled`);
});
