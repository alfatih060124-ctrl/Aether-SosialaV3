import { requireApiToken } from './auth.mjs';
import { evaluateRisk } from './risk-engine.mjs';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function evaluateRiskRequest(req, res, repository) {
  try {
    requireApiToken(req);
    const input = req.body || {};
    const result = evaluateRisk(input);
    if (input.event?.event_id && input.follower_user_id) {
      await repository.createRiskDecision({
        event_id: input.event.event_id,
        follower_user_id: input.follower_user_id,
        decision: result.decision,
        reason_code: result.reason_codes.join(',') || null
      });
    }
    return json(res, 200, result);
  } catch (e) {
    return json(res, e.statusCode || 400, { error: e.message });
  }
}
