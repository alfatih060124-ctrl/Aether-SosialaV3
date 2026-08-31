import assert from 'node:assert/strict';
import { buildExecutionIntent, transitionExecution, assertRiskRecheck, ShadowDispatcher, createLiveDispatcherBoundary } from '../services/api/src/execution-boundary.mjs';

const base = {
  trader_id:'10000000-0000-0000-0000-000000000002',
  follower_user_id:'10000000-0000-0000-0000-000000000001',
  mandate_id:'10000000-0000-0000-0000-000000000003',
  signal_assessment_id:'assessment-shadow-001',
  token_mint:'So11111111111111111111111111111111111111112',
  quote_mint:'USDC',
  side:'BUY',requested_amount_usd:100,max_slippage_bps:100,mode:'SHADOW',created_at:'2026-09-01T00:00:00.000Z'
};
const a = buildExecutionIntent(base);
const b = buildExecutionIntent({ ...base, intent_id:'different-intent-id' });
assert.equal(a.idempotency_key,b.idempotency_key,'idempotency must be stable for equivalent intent');
assert.equal(a.live_execution_authorized,false);
assert.throws(()=>buildExecutionIntent({ ...base, mode:'LIVE' }),/non_shadow_execution_intent_blocked/);
assert.throws(()=>createLiveDispatcherBoundary(),/live_dispatcher_not_implemented/);

assert.equal(transitionExecution('CREATED','RISK_CHECKED').state,'RISK_CHECKED');
assert.throws(()=>transitionExecution('CREATED','DISPATCHED'),/invalid_execution_transition/);

const goodRisk = { allowed:true, mandate_active:true, trader_verified:true, marketplace_published:true, estimated_price_impact_bps:25 };
assert.equal(assertRiskRecheck({ intent:a,risk:goodRisk }).passed,true);
assert.deepEqual(assertRiskRecheck({ intent:a,risk:{ ...goodRisk, mandate_active:false } }).reason_codes,['MANDATE_NOT_ACTIVE']);

const dispatcher = new ShadowDispatcher();
const result = await dispatcher.dispatch(a,{ risk:goodRisk });
assert.equal(result.state,'RECONCILED');
assert.equal(result.execution_dispatched,false);
assert.equal(result.live_execution_authorized,false);
assert.equal(result.signer_used,false);
assert.equal(result.confirmation.signature,null);

const signerAttempt = new ShadowDispatcher({ authorizationHook: async()=>({ ok:true, signer_required:true }) });
const blocked = await signerAttempt.dispatch(a,{ risk:goodRisk });
assert.equal(blocked.state,'REJECTED');
assert.ok(blocked.reason_codes.includes('SHADOW_AUTHORIZATION_REJECTED'));
assert.equal(blocked.execution_dispatched,false);

console.log('execution boundary regression: PASS');
