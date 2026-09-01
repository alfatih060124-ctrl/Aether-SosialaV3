import assert from 'node:assert/strict';
import { buildExecutionIntent, ShadowDispatcher } from '../services/api/src/execution-boundary.mjs';
import { AuditedShadowDispatcher, buildExecutionAuditEnvelope } from '../services/api/src/execution-audit.mjs';

const intent = buildExecutionIntent({
  intent_id:'10000000-0000-0000-0000-000000000010',
  trader_id:'10000000-0000-0000-0000-000000000002',
  follower_user_id:'10000000-0000-0000-0000-000000000001',
  mandate_id:'10000000-0000-0000-0000-000000000003',
  source_decision_id:'decision-shadow-audit-0001',
  signal_assessment_id:'assessment-shadow-audit-001',
  token_mint:'So11111111111111111111111111111111111111112',
  quote_mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  side:'BUY',requested_amount_usd:100,max_slippage_bps:100,mode:'SHADOW',
  created_at:'2026-09-01T10:00:00.000Z',ttl_ms:30_000
});
const risk = { allowed:true, mandate_active:true, trader_verified:true, marketplace_published:true, market_data_fresh:true, estimated_price_impact_bps:25 };
const ticks = [Date.parse('2026-09-01T10:00:01.000Z'), Date.parse('2026-09-01T10:00:02.000Z')];
const audited = new AuditedShadowDispatcher({ clock:()=>ticks.shift() });
const result = await audited.dispatch(intent,{ risk,now:Date.parse('2026-09-01T10:00:05.000Z') });
assert.equal(result.state,'RECONCILED');
assert.equal(result.execution_dispatched,false);
assert.equal(result.audit.mode,'SHADOW');
assert.equal(result.audit.dispatcher,'ShadowDispatcher');
assert.equal(result.audit.execution_dispatched,false);
assert.equal(result.audit.network_submission,false);
assert.equal(result.audit.live_execution_authorized,false);
assert.equal(result.audit.signer_used,false);
assert.equal(result.audit.intent_id,intent.intent_id);
assert.equal(result.audit.idempotency_key,intent.idempotency_key);
assert.match(result.audit.audit_id,/^[a-f0-9]{64}$/);
assert.match(result.audit.intent_digest,/^[a-f0-9]{64}$/);
assert.deepEqual(result.audit.lifecycle.map(x=>x.sequence),[0,1,2,3,4,5,6,7]);
assert.ok(result.audit.lifecycle.every(x=>x.network_submission===false));

const raw = await new ShadowDispatcher().dispatch(intent,{ risk,now:Date.parse('2026-09-01T10:00:05.000Z') });
const a = buildExecutionAuditEnvelope({ intent,result:raw,started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' });
const b = buildExecutionAuditEnvelope({ intent,result:raw,started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' });
assert.equal(a.audit_id,b.audit_id,'same audited execution must hash deterministically');

assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:raw,dispatcher:'SolanaLiveDispatcher',started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/execution_audit_dispatcher_identity_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:raw,dispatcher:'CustomDispatcher',started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/execution_audit_dispatcher_identity_violation/);
assert.throws(()=>new AuditedShadowDispatcher({ dispatcher:{ async dispatch(){ return raw; } } }),/invalid_shadow_dispatcher/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,intent_id:'10000000-0000-0000-0000-000000000099'},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/execution_audit_intent_mismatch/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,execution_dispatched:true},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/shadow_execution_dispatch_flag_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,network_submission:true},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/shadow_network_submission_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,signer_used:true},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/shadow_signer_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,live_execution_authorized:true},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/shadow_live_authorization_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:{...raw,lifecycle:[...raw.lifecycle,{state:'DISPATCHED',network_submission:true}]},started_at:'2026-09-01T10:00:01.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/shadow_lifecycle_network_submission_violation/);
assert.throws(()=>buildExecutionAuditEnvelope({ intent,result:raw,started_at:'2026-09-01T10:00:03.000Z',completed_at:'2026-09-01T10:00:02.000Z' }),/invalid_execution_audit_time_order/);

console.log('execution audit regression: PASS');
