import assert from 'node:assert/strict';
import { buildExecutionIntent, assertCanonicalExecutionIntent, ShadowDispatcher } from '../services/api/src/execution-boundary.mjs';

const NOW = Date.parse('2026-09-01T09:10:10.000Z');
const base = {
  trader_id:'10000000-0000-0000-0000-000000000002',
  follower_user_id:'10000000-0000-0000-0000-000000000001',
  mandate_id:'10000000-0000-0000-0000-000000000003',
  source_decision_id:'decision-canonical-0001',
  signal_assessment_id:'assessment-canonical-001',
  token_mint:'So11111111111111111111111111111111111111112',
  quote_mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  side:'BUY',
  requested_amount_usd:100,
  max_slippage_bps:100,
  mode:'SHADOW',
  created_at:'2026-09-01T09:10:00.000Z',
  ttl_ms:30_000,
  source:'AUTO_TRADE_ENGINE'
};

const intent = buildExecutionIntent(base);
assert.equal(assertCanonicalExecutionIntent(intent), intent);
assert.throws(() => buildExecutionIntent({ ...base, mode:undefined }), /non_shadow_execution_intent_blocked/);
assert.throws(() => assertCanonicalExecutionIntent({ ...intent, network:'devnet' }), /invalid_execution_network/);
assert.throws(() => assertCanonicalExecutionIntent({ ...intent, live_execution_authorized:true }), /execution_intent_fail_closed/);
assert.throws(() => assertCanonicalExecutionIntent({ ...intent, idempotency_key:'0'.repeat(64) }), /execution_idempotency_mismatch/);
assert.throws(() => assertCanonicalExecutionIntent({ ...intent, requested_amount_usd:'100' }), /invalid_requested_amount_usd/);
assert.throws(() => assertCanonicalExecutionIntent({ ...intent, signer:{ publicKey:'forbidden' } }), /signing_material_forbidden/);

const goodRisk = {
  allowed:true,
  mandate_active:true,
  trader_verified:true,
  marketplace_published:true,
  market_data_fresh:true,
  estimated_price_impact_bps:20
};

let hookCalls = 0;
const dispatcher = new ShadowDispatcher({
  quoteHook: async () => { hookCalls += 1; return { ok:true, shadow:true }; }
});

await assert.rejects(
  () => dispatcher.dispatch({ ...intent, side:'SELL' }, { risk:goodRisk, now:NOW }),
  /execution_idempotency_mismatch/
);
assert.equal(hookCalls, 0, 'tampered intent must fail before quote/simulation/authorization hooks');

const valid = await dispatcher.dispatch(intent, { risk:goodRisk, now:NOW });
assert.equal(valid.state, 'RECONCILED');
assert.equal(valid.execution_dispatched, false);
assert.equal(valid.network_submission, false);
assert.equal(valid.live_execution_authorized, false);
assert.equal(valid.signer_used, false);
assert.equal(hookCalls, 1);

console.log('canonical intent dispatch regression: PASS');
