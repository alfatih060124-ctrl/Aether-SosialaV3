export async function shadowRoute({ req, res, auth, repos, pool, executionMode, liveEnabled, send, jsonBody, runShadowSimulation }) {
  if (req.method !== 'POST' || req.url !== '/api/shadow/simulate') return false;
  if (!auth(req)) { send(res, 401, { error: 'unauthorized' }); return true; }
  if (!repos) { send(res, 503, { error: 'database_unconfigured' }); return true; }
  if (liveEnabled || executionMode !== 'SHADOW') { send(res, 409, { error: 'shadow_simulation_locked', reason: 'execution_mode_not_shadow' }); return true; }
  const result = await runShadowSimulation({ repos, pool, body: await jsonBody(req) });
  send(res, result.status, result.body);
  return true;
}
