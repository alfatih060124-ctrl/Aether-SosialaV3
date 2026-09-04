// SYNTHETIC / TEST-ONLY fixtures. Never use these values as production trader evidence.
import assert from 'node:assert/strict';
import { collectSolanaWalletAccountIdentitySnapshot, verifySolanaWalletAccountIdentitySnapshot } from '../services/api/src/solana-wallet-account-identity-snapshot.mjs';

const WALLET='11111111111111111111111111111111';
const OWNER='Vote111111111111111111111111111111111111111';
const requestedAt='2026-09-04T00:00:00.000Z';
const observedAt='2026-09-04T00:00:01.000Z';
async function expectCode(fn,code){await assert.rejects(fn,e=>e?.code===code);}
function clone(v){return structuredClone(v);}

let seen;
const rpc=async req=>{seen=req;return{result:{context:{slot:555000},value:{data:['','base64'],executable:false,lamports:123,rentEpoch:0,owner:OWNER,space:0}}};};
const evidence=await collectSolanaWalletAccountIdentitySnapshot({rpc,traderWallet:WALLET,commitment:'finalized',endpointLabel:'rpc_mainnet',requestedAt,observedAt,minContextSlot:554000});
assert.deepEqual(seen,{method:'getAccountInfo',params:[WALLET,{commitment:'finalized',encoding:'base64',dataSlice:{offset:0,length:0},minContextSlot:554000}]});
assert.equal(evidence.collection_status,'PENDING_DATA');
assert.equal(evidence.source_reference,null);
assert.equal(evidence.calculation_hash,null);
assert.equal(evidence.account_exists,true);
assert.equal(evidence.account_owner,OWNER);
assert.equal(evidence.account_executable,false);
assert.equal(evidence.account_space,0);
assert.equal(evidence.verified,false);
assert.equal(evidence.published,false);
assert.equal(evidence.metrics_available,false);
assert.equal(evidence.live_execution_authorized,false);
for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(evidence[k],null);
assert.equal(verifySolanaWalletAccountIdentitySnapshot(evidence),true);

const missing=await collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:1},value:null}}),traderWallet:WALLET,requestedAt,observedAt});
assert.equal(missing.account_exists,false);
assert.equal(missing.account_owner,null);
assert.equal(missing.account_executable,null);
assert.equal(missing.account_space,null);
assert.equal(missing.calculation_hash,null);
assert.equal(verifySolanaWalletAccountIdentitySnapshot(missing),true);

await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc,traderWallet:'z'.repeat(44),requestedAt,observedAt}),'invalid_trader_wallet');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:99},value:null}}),traderWallet:WALLET,requestedAt,observedAt,minContextSlot:100}),'context_slot_below_minimum');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:1},value:{data:['','base64'],owner:'z'.repeat(44),executable:false,space:0}}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_account_owner');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:1},value:{data:['','base64'],owner:OWNER,executable:'false',space:0}}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_account_executable');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:1},value:{data:['payload','base64'],owner:OWNER,executable:false,space:0}}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_account_data_slice');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc:async()=>({result:{context:{slot:1},value:{data:['','base64'],owner:OWNER,executable:false,space:Number.MAX_SAFE_INTEGER+1}}}),traderWallet:WALLET,requestedAt,observedAt}),'invalid_account_space');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc,traderWallet:WALLET,endpointLabel:'https://rpc.example/?key=secret',requestedAt,observedAt}),'invalid_rpc_endpoint_label');
await expectCode(()=>collectSolanaWalletAccountIdentitySnapshot({rpc,traderWallet:WALLET,requestedAt:observedAt,observedAt:requestedAt}),'invalid_observation_chronology');

for(const mutate of [
  e=>{e.verified=true;},
  e=>{e.published=true;},
  e=>{e.metrics_available=true;},
  e=>{e.trades_count=1;},
  e=>{e.calculation_hash='synthetic';},
  e=>{e.source_reference='solana_rpc:synthetic@1';},
  e=>{e.account_owner=WALLET;},
  e=>{e.provenance.context_slot=999;},
  e=>{e.provenance.account_space=7;},
  e=>{e.provenance.data_slice.length=1;},
  e=>{e.provenance.source_reference_policy='TRANSACTION';}
]){const t=clone(evidence);mutate(t);assert.equal(verifySolanaWalletAccountIdentitySnapshot(t),false);}

console.log('Solana wallet account identity snapshot regression: PASS');
