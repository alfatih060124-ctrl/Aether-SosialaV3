import assert from 'node:assert/strict';
import { buildExecutionIntent, transitionExecution, assertRiskRecheck, ShadowDispatcher, createLiveDispatcherBoundary } from '../services/api/src/execution-boundary.mjs';

const NOW = Date.parse('2026-09-01T04:00:10.000Z');
const base = {
  trader_id:'10000000-0000-0000-0000-000000000002',
  follower_user_id:'10000000-0000-0000-0000-000000000001',
  mandate_id:'10000000-0000-0000-0000-000000000003',
  source_decision_id:'decision-shadow-0001',
  signal_assessment_id:'assessment-shadow-001',
  token_mint:'So11111111111111111111111111111111111111112',
  quote_mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  side:'BUY',requested_amount_usd:100,max_slippage_bps:100,mode:'SHADOW',
  created_at:'2026-09-01T04:00:00.000Z',ttl_ms:30_000
};

const a = buildExecutionIntent(base);
const b = buildExecutionIntent({ ...base, intent_id:'different-intent-id' });
assert.equal(a.schema_version,2);
assert.equal(a.chain,'SOLANA');
assert.equal(a.network,'mainnet-beta');
assert.equal(a.idempotency_key,b.idempotency_key,'idempotency must be stable for equivalent decision intent');
assert.notEqual(a.idempotency_key,buildExecutionIntent({ ...base, source_decision_id:'decision-shadow-0002' }).idempotency_key,'different decisions must not collide');
assert.equal(a.live_execution_authorized,false);
assert.throws(()=>buildExecutionIntent({ ...base, mode:'LIVE' }),/non_shadow_execution_intent_blocked/);
assert.throws(()=>buildExecutionIntent({ ...base, token_mint:'not-a-mint' }),/invalid_token_mint/);
assert.throws(()=>buildExecutionIntent({ ...base, mandate_id:null }),/invalid_execution_mandate_link/);
assert.throws(()=>buildExecutionIntent({ ...base, risk_context:{ private_key:'forbidden' } }),/signing_material_forbidden/);
assert.throws(()=>createLiveDispatcherBoundary(),/live_dispatcher_not_implemented/);

assert.equal(transitionExecution('CREATED','RISK_CHECKED').state,'RISK_CHECKED');
assert.throws(()=>transitionExecution('CREATED','DISPATCHED'),/invalid_execution_transition/);

const goodRisk = { allowed:true, mandate_active:true, trader_verified:true, marketplace_published:true, market_data_fresh:true, estimated_price_impact_bps:25 };
assert.equal(assertRiskRecheck({ intent:a,risk:goodRisk,now:NOW }).passed,true);
assert.deepEqual(assertRiskRecheck({ intent:a,risk:{ ...goodRisk, mandate_active:false },now:NOW }).reason_codes,['MANDATE_NOT_ACTIVE']);
assert.ok(assertRiskRecheck({ intent:a,risk:{ ...goodRisk, market_data_fresh:false },now:NOW }).reason_codes.includes('MARKET_DATA_STALE_OR_UNVERIFIED'));
assert.ok(assertRiskRecheck({ intent:a,risk:goodRisk,now:Date.parse('2026-09-01T04:01:00.000Z') }).reason_codes.includes('EXECUTION_INTENT_EXPIRED'));

const dispatcher = new ShadowDispatcher();
const result = await dispatcher.dispatch(a,{ risk:goodRisk,now:NOW });
assert.equal(result.state,'RECONCILED');
assert.equal(result.execution_dispatched,false);
assert.equal(result.network_submission,false);
assert.equal(result.live_execution_authorized,false);
assert.equal(result.signer_used,false);
assert.equal(result.confirmation.signature,null);
assert.deepEqual(result.lifecycle.map(x=>x.state),['CREATED','RISK_CHECKED','QUOTED','SIMULATED','AUTHORIZED','DISPATCHED','CONFIRMED','RECONCILED']);
assert.ok(result.lifecycle.every(x=>x.network_submission===false));

const signerAttempt = new ShadowDispatcher({ authorizationHook: async()=>({ ok:true, signer_required:true, live_execution_authorized:false }) });
const blockedSigner = await signerAttempt.dispatch(a,{ risk:goodRisk,now:NOW });
assert.equal(blockedSigner.state,'REJECTED');
assert.ok(blockedSigner.reason_codes.includes('SHADOW_AUTHORIZATION_REJECTED'));
assert.equal(blockedSigner.execution_dispatched,false);

const liveAuthAttempt = new ShadowDispatcher({ authorizationHook: async()=>({ ok:true, signer_required:false, live_execution_authorized:true }) });
const blockedLive = await liveAuthAttempt.dispatch(a,{ risk:goodRisk,now:NOW });
assert.equal(blockedLive.state,'REJECTED');
assert.ok(blockedLive.reason_codes.includes('SHADOW_AUTHORIZATION_REJECTED'));

const fakeSignatureAttempt = new ShadowDispatcher({ confirmationHook: async()=>({ ok:true, shadow:true, signature:'fake-chain-signature' }) });
const blockedSignature = await fakeSignatureAttempt.dispatch(a,{ risk:goodRisk,now:NOW });
assert.equal(blockedSignature.state,'FAILED');
assert.ok(blockedSignature.reason_codes.includes('SHADOW_CHAIN_SIGNATURE_FORBIDDEN'));
assert.equal(blockedSignature.execution_dispatched,false);

console.log('execution boundary regression: PASS');
