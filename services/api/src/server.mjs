import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const executionMode = process.env.EXECUTION_MODE || 'SHADOW';
const liveEnabled = process.env.LIVE_ENABLED === 'true' && executionMode === 'LIVE';

const send = (res, status, body) => {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      service: 'aether-api',
      execution_mode: executionMode,
      live_enabled: liveEnabled
    });
  }

  if (req.method === 'GET' && req.url === '/api/execution/status') {
    return send(res, 200, {
      mode: executionMode,
      live_enabled: liveEnabled,
      fail_closed: !liveEnabled,
      signer_exposed_to_api: false
    });
  }

  return send(res, 404, {error: 'not_found'});
});

server.listen(PORT, () => console.log(`Aether API listening on ${PORT}`));
