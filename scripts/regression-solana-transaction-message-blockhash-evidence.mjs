import assert from 'node:assert/strict';
import {collectSolanaTransactionMessageBlockhashEvidence,verifySolanaTransactionMessageBlockhashEvidence} from '../services/api/src/solana-transaction-message-blockhash-evidence.mjs';

const SIG='1'.repeat(64), WALLET='1'.repeat(32), BLOCKHASH='1'.repeat(32);
const START='2026-09-03T07:00:00.000Z', OBS='2026-09-03T07:01:00.000Z';
const rpcFound=async(method,params)=>{assert.equal(method,'getTransaction');assert.equal(params[0],SIG);return{jsonrpc:'2.0',result:{slot:123,blockTime:1788418800,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET,signer:true,writable:true}],recentBlockhash:BLOCKHASH}},meta:{err:null}}}};
const collect=(overrides={})=>collectSolanaTransactionMessageBlockhashEvidence({rpcRequest:rpcFound,signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'test-rpc',commitment:'confirmed',requestStartedAt:START,observedAt:OBS,...overrides});

const evidence=await collect();
assert.equal(evidence.schema,'aether.solana.transaction_message_blockhash_evidence.v1');
assert.equal(evidence.collection_status,'PENDING_DATA');
assert.equal(evidence.metrics_available,false);assert.equal(evidence.verified,false);assert.equal(evidence.published,false);assert.equal(evidence.live_execution_authorized,false);assert.equal(evidence.reconciliation_required,true);
for(const k of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(evidence[k],null);
assert.equal(evidence.recent_blockhash,BLOCKHASH);assert.equal(evidence.source_reference,`solana_rpc:${SIG}@123`);assert.equal(verifySolanaTransactionMessageBlockhashEvidence(evidence),true);

const notFound=await collect({rpcRequest:async()=>({jsonrpc:'2.0',result:null})});
assert.equal(notFound.source_reference,null);assert.equal(notFound.recent_blockhash,null);assert.equal(verifySolanaTransactionMessageBlockhashEvidence(notFound),true);

for(const mutate of [
 e=>{e.recent_blockhash='2'.repeat(32)},
 e=>{e.provenance.recent_blockhash='2'.repeat(32)},
 e=>{e.total_return_bps=1},
 e=>{e.verified=true},
 e=>{e.source_reference=`solana_rpc:${SIG}@124`},
]){const clone=structuredClone(evidence);mutate(clone);assert.throws(()=>verifySolanaTransactionMessageBlockhashEvidence(clone));}

await assert.rejects(()=>collect({rpcEndpointLabel:'https://rpc.example/?token=secret'}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:123,blockTime:1788418800,transaction:{signatures:['2'.repeat(64)],message:{accountKeys:[{pubkey:WALLET}],recentBlockhash:BLOCKHASH}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:123,blockTime:1788419000,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET}],recentBlockhash:BLOCKHASH}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:123,blockTime:1788418800,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET}],recentBlockhash:'not-a-blockhash'}},meta:{err:null}}})}));
await assert.rejects(()=>collect({rpcRequest:async()=>({jsonrpc:'2.0',result:{slot:123,blockTime:1788418800,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET}],recentBlockhash:BLOCKHASH}},meta:{}}})}));

console.log('SYNTHETIC / TEST-ONLY Solana transaction message blockhash evidence regression: PASS');
