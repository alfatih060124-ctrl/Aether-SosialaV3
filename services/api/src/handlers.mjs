import { validateCopyPolicy, validateExecutionMode } from './validation.mjs';
import { requireApiToken, isLiveEnabled } from './auth.mjs';
import { assertLiveExecutionAllowed } from './authorization.mjs';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function createTradeEvent(req, res, repository) {
  try {
    requireApiToken(req);
    const event = req.body;
    if (!event?.event_id || !event?.tx_hash || !event?.trader_wallet) return json(res, 400, { error: 'invalid_trade_event' });
    const saved = await repository.createTradeEvent(event);
    return json(res, saved ? 201 : 200, saved ?? { duplicate: true, event_id: event.event_id });
  } catch (error) { return json(res, error.statusCode || 500, { error: error.message }); }
}

export async function createExecutionRequest(req, res, repository) {
  try {
    requireApiToken(req);
    const input = req.body || {};
    const mode = validateExecutionMode(input.mode || 'SHADOW');
    assertLiveExecutionAllowed({
      mode,
      liveEnabled: isLiveEnabled(),
      fixtureGatePassed: process.env.FIXTURE_GATE_PASSED === 'true',
      operatorApproved: process.env.OPERATOR_APPROVED === 'true'
    });
    const saved = await repository.createExecutionRequest({ ...input, mode });
    return json(res, 201, saved);
  } catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
}

export function validateCopyPolicyRequest(req, res) {
  try { requireApiToken(req); validateCopyPolicy(req.body); return json(res, 200, { valid: true }); }
  catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
}
