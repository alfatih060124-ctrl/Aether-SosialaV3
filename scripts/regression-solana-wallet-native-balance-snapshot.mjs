// SYNTHETIC / TEST-ONLY fixtures. Never use these values as production trader evidence.
import assert from 'node:assert/strict';
import { collectSolanaWalletNativeBalanceSnapshot, verifySolanaWalletNativeBalanceSnapshot } from '../services/api/src/solana-wallet-native-balance-snapshot.mjs';

const WALLET='11111111111111111111111111111111';
const requestedAt='2026-09-04T00:00:00.000Z';
const observedAt='2026-09-04T00:00:01.000Z';
async function expectCode(fn,code){await assert.rejects(fn,e=>e?.code===code);}
function clone(v){return structuredClone(v);}

let seen;
const rpc=async req=>{seen=req;return{result:{context:{slot:123456},value:1234567890}};};
const evidence=await collectSolanaWalletNativeBalanceSnapshot({rpc,traderWallet:WALLET,commitment:'finalized',endpointLabel:'rpc_mainnet',requestedAt,observedAt,minContextSlot:123000});
assert.deepEqual(seen,{method:'getBalance',params:[WALLET,{commitment:'finalized',minContextSlot:123000}]});
assert.equal(evidence.collection_status,'PENDING_DATA');
assert.equal(evidence.lamports,'1234567890');
assert.equal(evidence.sol_decimal,'1.234567890');
assert.equal(evidence.source_reference,null);
assert.equal(evidence.verified,false);assert.equal(evidence.published,false);assert.equal(evidence.metrics_available,false);assert.equal(evidence.live_execution_authorized,false);
for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(evidence[k],null);
assert.equal(verifySolanaWalletNativeBalanceSnapshot(evidence),true);

const zero=await collectSolanaWalletNativeBalanceSnapshot({rpc:async()=>({result:{context:{slot:1},value:0}}),traderWallet:WALLET,requestedAt,observedAt});
assert.equal(zero.lamports,'0');assert.equal(zero.sol_decimal,'0.000000000');assert.equal(verifySolanaWalletNativeBalanceSnapshot(zero),true);

await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc,traderWallet:'z'.repeat(44),requestedAt,observedAt}),'invalid_trader_wallet');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc:async()=>({result:{context:{slot:99},value:1}}),traderWallet:WALLET,requestedAt,observedAt,minContextSlot:100}),'context_slot_below_minimum');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc:async()=>({result:{context:{slot:1},value:-1}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_lamports');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc:async()=>({result:{context:{slot:1},value:Number.MAX_SAFE_INTEGER+1}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_lamports');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc:async()=>({result:null}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_rpc_response');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc,traderWallet:WALLET,endpointLabel:'https://rpc.example/?key=secret',requestedAt,observedAt}),'invalid_rpc_endpoint_label');
await expectCode(()=>collectSolanaWalletNativeBalanceSnapshot({rpc,traderWallet:WALLET,requestedAt:observedAt,observedAt:requestedAt}),'invalid_observation_chronology');

for(const mutate of [
 e=>{e.verified=true;},e=>{e.published=true;},e=>{e.metrics_available=true;},e=>{e.trades_count=1;},e=>{e.source_reference='solana_rpc:synthetic@1';},
 e=>{e.lamports='2';},e=>{e.sol_decimal='9.000000000';},e=>{e.provenance.context_slot=999;},e=>{e.provenance.requested_wallet='z'.repeat(44);},e=>{e.provenance.source_reference_policy='TRANSACTION';}
]){const t=clone(evidence);mutate(t);assert.equal(verifySolanaWalletNativeBalanceSnapshot(t),false);}

console.log('Solana wallet native balance snapshot regression: PASS');
