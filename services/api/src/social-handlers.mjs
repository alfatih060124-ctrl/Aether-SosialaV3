import { requireApiToken } from './auth.mjs';
import { validateCopyPolicy } from './validation.mjs';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function createCopyPolicy(req, res, repository) {
  try {
    requireApiToken(req);
    validateCopyPolicy(req.body);
    if (!req.body.follower_user_id || !req.body.trader_id) return json(res, 400, { error: 'missing_owner' });
    const saved = await repository.createCopyPolicy(req.body);
    return json(res, 201, saved);
  } catch (e) { return json(res, e.statusCode || 400, { error: e.message }); }
}

export async function listCopyPolicies(req, res, repository) {
  try {
    requireApiToken(req);
    const userId = new URL(req.url, 'http://localhost').searchParams.get('user_id');
    if (!userId) return json(res, 400, { error: 'user_id_required' });
    return json(res, 200, await repository.listCopyPolicies(userId));
  } catch (e) { return json(res, e.statusCode || 400, { error: e.message }); }
}

export async function createRiskDecision(req, res, repository) {
  try {
    requireApiToken(req);
    const { event_id, follower_user_id, decision, reason_code } = req.body || {};
    if (!event_id || !follower_user_id || !['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { error: 'invalid_risk_decision' });
    return json(res, 201, await repository.createRiskDecision({ event_id, follower_user_id, decision, reason_code }));
  } catch (e) { return json(res, e.statusCode || 400, { error: e.message }); }
}
