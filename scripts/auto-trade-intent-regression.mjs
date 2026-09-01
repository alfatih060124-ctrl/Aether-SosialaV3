import assert from 'node:assert/strict';
import { buildAutoTradeExecutionIntent } from '../services/api/src/auto-trade-intent.mjs';

const trader = {
  trader_id: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  verified: true,
  verification_status: 'VERIFIED',
  published: true,
  mode: 'SHADOW'
};
const mandate = {
  policy_id: '22222222-2222-4222-8222-222222222222',
  follower_user_id: '33333333-3333-4333-8333-333333333333',
  trader_id: trader.trader_id,
  status: 'ACTIVE',
  mode: 'SHADOW',
  live_execution_authorized: false,
  max_slippage_bps: 75
};
const decision = {
  action: 'BUY',
  token_mint: 'So11111111111111111111111111111111111111112',
  requested_amount_usd: 125.5,
  mode: 'SHADOW',
  live_execution_authorized: false,
  reason_codes: ['STRICT_SIGNAL_QUALIFIED', 'MANDATE_LIMITS_PASSED']
};

const intent = buildAutoTradeExecutionIntent({
  decision,
  trader,
  mandate,
  sourceDecisionId: 'decision-00000001',
  signalAssessmentId: 'assessment-00000001',
  createdAt: '2026-09-01T00:00:00.000Z'
});
assert.equal(intent.schema_version, 2);
assert.equal(intent.side, 'BUY');
assert.equal(intent.mode, 'SHADOW');
assert.equal(intent.live_execution_authorized, false);
assert.equal(intent.follower_user_id, mandate.follower_user_id);
assert.equal(intent.mandate_id, mandate.policy_id);
assert.equal(intent.trader_id, trader.trader_id);
assert.equal(intent.max_slippage_bps, 75);
assert.equal(intent.requested_amount_usd, 125.5);
assert.match(intent.idempotency_key, /^[a-f0-9]{64}$/);
assert.equal(intent.risk_context.copy_mandate_gate.live_execution_authorized, false);

const same = buildAutoTradeExecutionIntent({
  decision,
  trader,
  mandate,
  sourceDecisionId: 'decision-00000001',
  signalAssessmentId: 'assessment-00000001',
  createdAt: '2026-09-01T00:00:10.000Z'
});
assert.equal(same.idempotency_key, intent.idempotency_key, 'idempotency must be decision-scoped, not timestamp-scoped');

for (const bad of [
  { name: 'HOLD is not executable', patchDecision: { action: 'HOLD', requested_amount_usd: 0 }, error: /autotrade_decision_not_executable/ },
  { name: 'LIVE decision blocked', patchDecision: { mode: 'LIVE', live_execution_authorized: true }, error: /non_shadow_autotrade_decision_blocked/ },
  { name: 'unpublished trader blocked', patchTrader: { published: false }, error: /trader_not_published/ },
  { name: 'unverified trader blocked', patchTrader: { verified: false }, error: /trader_not_verified/ },
  { name: 'inactive mandate blocked', patchMandate: { status: 'PAUSED' }, error: /copy_mandate_not_active/ },
  { name: 'LIVE-authorized mandate blocked', patchMandate: { live_execution_authorized: true }, error: /copy_mandate_live_authorization_blocked/ },
  { name: 'trader mismatch blocked', patchMandate: { trader_id: '44444444-4444-4444-8444-444444444444' }, error: /copy_mandate_trader_mismatch/ }
]) {
  assert.throws(() => buildAutoTradeExecutionIntent({
    decision: { ...decision, ...(bad.patchDecision || {}) },
    trader: { ...trader, ...(bad.patchTrader || {}) },
    mandate: { ...mandate, ...(bad.patchMandate || {}) },
    sourceDecisionId: 'decision-00000002',
    createdAt: '2026-09-01T00:00:00.000Z'
  }), bad.error, bad.name);
}

assert.throws(() => buildAutoTradeExecutionIntent({
  decision: { ...decision, private_key: 'forbidden' },
  trader,
  mandate,
  sourceDecisionId: 'decision-00000003'
}), /private_key|signing_material|autotrade/);

console.log('auto trade execution intent adapter regression passed');
