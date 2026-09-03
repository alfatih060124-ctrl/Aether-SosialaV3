import assert from 'node:assert/strict';
import {collectSolanaTransactionRewardEvidence,verifySolanaTransactionRewardEvidence} from '../services/api/src/solana-transaction-reward-evidence.mjs';

// SYNTHETIC / TEST-ONLY. These identifiers are fixtures, never production evidence.
const SIG='1'.repeat(64);
const WALLET='1'.repeat(32);
const START='2026-09-03T10:00:00.000Z';
const OBS='2026-09-03T10:00:10.000Z';
const rpcResult=(rewards)=>({jsonrpc:'2.0',result:{slot:123,blockTime:1788429599,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET}]}},meta:{err:null,rewards}}});
const collect=(response)=>collectSolanaTransactionRewardEvidence({rpcRequest:async(method,params)=>{assert.equal(method,'getTransaction');assert.equal(params[0],SIG);return response},signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'synthetic-rpc',requestStartedAt:START,observedAt:OBS});
async function rejects(fn,pattern){await assert.rejects(fn,pattern)}

const valid=await collect(rpcResult([{pubkey:WALLET,lamports:5000,postBalance:1005000,rewardType:'Staking',commission:8}]));
assert.equal(valid.collection_status,'PENDING_DATA');assert.equal(valid.verified,false);assert.equal(valid.published,false);assert.equal(valid.live_execution_authorized,false);assert.equal(valid.metrics_available,false);assert.equal(valid.reward_count,1);assert.equal(valid.rewards[0].lamports,5000);assert.equal(valid.source_reference,`solana_rpc:${SIG}@123`);assert.equal(verifySolanaTransactionRewardEvidence(valid),true);
for(const key of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(valid[key],null);

const none=await collect(rpcResult([]));assert.equal(none.reward_count,0);assert.equal(none.source_reference,null);assert.equal(verifySolanaTransactionRewardEvidence(none),true);
const missing=await collect({jsonrpc:'2.0',result:null});assert.equal(missing.reward_count,null);assert.equal(missing.source_reference,null);assert.equal(verifySolanaTransactionRewardEvidence(missing),true);

const tampered=structuredClone(valid);tampered.rewards[0].lamports=9999;assert.throws(()=>verifySolanaTransactionRewardEvidence(tampered),/public evidence\/provenance mismatch/);
const unsafe=structuredClone(valid);unsafe.verified=true;assert.throws(()=>verifySolanaTransactionRewardEvidence(unsafe),/unsafe evidence state/);
const metric=structuredClone(valid);metric.total_return_bps=1;assert.throws(()=>verifySolanaTransactionRewardEvidence(metric),/must remain null/);
await rejects(()=>collect(rpcResult([{pubkey:WALLET,lamports:1,postBalance:1,rewardType:'Unknown',commission:null}])),/unsupported rewardType/);
await rejects(()=>collect(rpcResult([{pubkey:WALLET,lamports:1,postBalance:1,rewardType:'Fee',commission:101}])),/commission/);
await rejects(()=>collect({jsonrpc:'2.0',result:{...rpcResult([]).result,meta:{rewards:[]}}}),/meta.err and meta.rewards are required/);
await rejects(()=>collect(rpcResult([{pubkey:WALLET,lamports:Number.MAX_SAFE_INTEGER+1,postBalance:1,rewardType:null,commission:null}])),/lamports must be safe integer/);
await rejects(()=>collect(rpcResult([{pubkey:WALLET,lamports:1,postBalance:Number.MAX_SAFE_INTEGER+1,rewardType:null,commission:null}])),/postBalance/);
await rejects(()=>collect(rpcResult([{pubkey:WALLET,lamports:1,postBalance:1,rewardType:null,commission:null}]).then(x=>x),/a^/).catch(()=>{});

console.log('Solana transaction reward evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
