import assert from 'node:assert/strict';
import { createAutoTradeRuntimeRiskSnapshotWriter } from '../services/api/src/autotrade-runtime-risk-writer.mjs';

const follower='22222222-2222-4222-8222-222222222222';
const policy='11111111-1111-4111-8111-111111111111';
const now=new Date('2026-09-03T05:20:00.000Z');
const facts={schema:'aether.autotrade.runtime_risk_facts.v1',source:'BACKEND_INTERNAL',authoritative:true,caller_authority:false,authenticated_follower_user_id:follower,policy_id:policy,capital_limit_usd:1000,available_capital_usd:800,daily_realized_pnl_usd:-10,trades_today:2,max_trades_per_day:20,cooldown_seconds:60,seconds_since_last_trade:120,min_signal_score:70,exit_quality_floor:50,allowed_tokens:['SOL','USDC']};
let producerCalls=0; let dbCalls=0;
const producer={async getRuntimeRiskFacts(input){producerCalls++;assert.deepEqual(input,{authenticated_follower_user_id:follower,policy_id:policy});return facts;}};
const db={async query(sql,params){dbCalls++;assert.match(sql,/FROM copy_policies p/);assert.match(sql,/p\.enabled = TRUE/);assert.match(sql,/TRUE, FALSE, FALSE, FALSE/);assert.equal(params[0],policy);assert.equal(params[1],follower);assert.equal(params[2],now);return {rows:[{policy_id:policy,follower_user_id:follower,observed_at:now}]};}};
const writer=createAutoTradeRuntimeRiskSnapshotWriter(db,{producer,clock:()=>now});
const result=await writer.refresh({authenticated_follower_user_id:follower,policy_id:policy});
assert.equal(producerCalls,1); assert.equal(dbCalls,1); assert.equal(result.schema,'aether.autotrade.runtime_risk_refresh.v1'); assert.equal(result.caller_authority,false); assert.equal(result.live_execution_authorized,false); assert.equal(result.network_submission_authorized,false); assert.equal(result.signer_required,false); assert.equal(result.execution_dispatched,false);

let badDbCalls=0;
const badWriter=createAutoTradeRuntimeRiskSnapshotWriter({async query(){badDbCalls++;return {rows:[]};}},{producer:{async getRuntimeRiskFacts(){return {...facts,source:'CALLER'};}},clock:()=>now});
await assert.rejects(()=>badWriter.refresh({authenticated_follower_user_id:follower,policy_id:policy}),/untrusted_runtime_risk_facts/); assert.equal(badDbCalls,0);

let malformedProducerCalls=0;
const malformed=createAutoTradeRuntimeRiskSnapshotWriter({async query(){throw new Error('must_not_query');}},{producer:{async getRuntimeRiskFacts(){malformedProducerCalls++;return facts;}},clock:()=>now});
await assert.rejects(()=>malformed.refresh({authenticated_follower_user_id:follower,policy_id:'not-a-uuid'}),/invalid_policy_id/); assert.equal(malformedProducerCalls,0);

const rejected=createAutoTradeRuntimeRiskSnapshotWriter({async query(){return {rows:[]};}},{producer,clock:()=>now});
await assert.rejects(()=>rejected.refresh({authenticated_follower_user_id:follower,policy_id:policy}),/runtime_risk_snapshot_refresh_rejected/);

console.log('Auto Trade Runtime Risk Writer Regression: PASS');
