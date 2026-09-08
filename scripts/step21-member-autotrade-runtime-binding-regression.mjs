import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleMemberFromCompletedShadowScan, MEMBER_AUTOTRADE_SHADOW_SCHEDULER } from '../services/api/src/member-autotrade-shadow-scheduler.mjs';

const candidate = Object.freeze({
  token_mint: 'TOKEN', quote_mint: 'USDC', buy_dex: 'ORCA', sell_dex: 'RAYDIUM',
  buy_pool_address: 'BUY_POOL', sell_pool_address: 'SELL_POOL', notional_usdc: 10,
  gross_profit_before_costs_usdc: 0.05, market_execution_cost_usdc: 0.02,
  network_fee_usdc: 0.01, market_net_pnl_usdc: 0.03,
  gross_executable_spread_bps: 50, expected_net_edge_bps: 30,
  net_edge_gate_passed: true, costs_verified: true, exact_transaction_fee_ready: true,
  observed_at: '2026-09-08T07:00:00.000Z', mode: 'SHADOW', execution_dispatched: false,
  transaction_signed: false, network_submission_authorized: false, live_execution_authorized: false
});
const scan = Object.freeze({ scan_id:'scan-1', status:'COMPLETE', mode:'SHADOW', live_execution_authorized:false, summary:{qualified:[candidate]} });
const member = Object.freeze({ user_id:'00000000-0000-0000-0000-000000000001', wallet_address:'wallet-1', state:'RUNNING_SCANNING' });

const transitions=[];
let state='RUNNING_SCANNING';
const transition=async (_pool,_user,command)=>{
  transitions.push(command);
  if(command==='BEGIN_EXECUTION')state='EXECUTING';
  if(command==='BEGIN_SETTLING')state='SETTLING';
  if(command==='SETTLED')state='RUNNING_SCANNING';
  if(command==='FAIL')state='PAUSED';
  return {state,live_execution_authorized:false};
};const persisted=[];
const result=await settleMemberFromCompletedShadowScan({
  pool:{},repos:null,member,scan,performanceFeeBps:1000,transition,
  persist:async (_pool,session,row,options)=>{persisted.push({session,row,options});return {duplicate:false}}
});
assert.equal(result.settled,1);
assert.deepEqual(transitions,['BEGIN_EXECUTION','BEGIN_SETTLING','SETTLED']);
assert.equal(persisted.length,1);
assert.match(persisted[0].options.idempotencyKey,/scan-1/);
assert.equal(result.live_execution_authorized,false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_SCHEDULER.enabled_by_default,false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_SCHEDULER.transaction_count_cap,null);
assert.equal(MEMBER_AUTOTRADE_SHADOW_SCHEDULER.min_expected_net_edge_bps,20);

transitions.length=0;persisted.length=0;state='RUNNING_SCANNING';
const lowScan={...scan,scan_id:'scan-low',summary:{qualified:[{...candidate,expected_net_edge_bps:19,net_edge_gate_passed:true}]}};
const skipped=await settleMemberFromCompletedShadowScan({pool:{},member,scan:lowScan,performanceFeeBps:1000,transition,persist:async()=>{throw new Error('should_not_persist')}});
assert.equal(skipped.settled,0);
assert.equal(transitions.length,0);

transitions.length=0;state='RUNNING_SCANNING';
await assert.rejects(settleMemberFromCompletedShadowScan({pool:{},member,scan:{...scan,scan_id:'scan-fail'},performanceFeeBps:1000,transition,persist:async()=>{throw new Error('persistence_failed')}}),/persistence_failed/);
assert.deepEqual(transitions,['BEGIN_EXECUTION','FAIL']);

const schedulerSource=fs.readFileSync(new URL('../services/api/src/member-autotrade-shadow-scheduler.mjs',import.meta.url),'utf8');
const persistenceSource=fs.readFileSync(new URL('../services/api/src/paper-arbitrage-persistence.mjs',import.meta.url),'utf8');
const probeSource=fs.readFileSync(new URL('./vm-cross-venue-net-edge-probe.mjs',import.meta.url),'utf8');
const serverSource=fs.readFileSync(new URL('../services/api/src/server.mjs',import.meta.url),'utf8');
for(const token of ['pg_try_advisory_lock','AUTOTRADE_SHADOW_SCHEDULER_ENABLED','RUNNING_SCANNING','performance_fee_bps','startMarketShadowRuntimeScan'])assert.match(schedulerSource,new RegExp(token));
assert.match(persistenceSource,/persistQualifiedPaperArbitrageProbe/);
assert.match(persistenceSource,/paper_arbitrage_probe_net_edge_below_floor/);
for(const token of ['buy_pool_address','sell_pool_address','network_fee_usdc','costs_verified'])assert.match(probeSource,new RegExp(token));
assert.match(serverSource,/startMemberAutoTradeShadowScheduler/);
assert.match(serverSource,/\/api\/admin\/runtime\/scheduler/);
assert.doesNotMatch(schedulerSource,/sendTransaction|secretKey|fromSecretKey|seed phrase/i);
console.log('step21 member Auto Trade SHADOW runtime binding regression: PASS');