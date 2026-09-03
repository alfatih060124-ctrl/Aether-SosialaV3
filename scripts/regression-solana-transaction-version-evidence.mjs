import assert from 'node:assert/strict';
import { collectSolanaTransactionVersionEvidence, verifySolanaTransactionVersionEvidence } from '../services/api/src/solana-transaction-version-evidence.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These identifiers are not production evidence.
const SIG='1'.repeat(64);
const WALLET='1'.repeat(32);
const OTHER='1'.repeat(31)+'2';
const requestedAt='2026-09-03T13:00:00.000Z';
const observedAt='2026-09-03T13:00:10.000Z';

function found(version='legacy'){
  return {result:{slot:123,blockTime:1788440400,version,transaction:{signatures:[SIG],message:{accountKeys:[WALLET,OTHER]}},meta:{err:null}}};
}
function rpcWith(response, inspect){return async(method,params)=>{assert.equal(method,'getTransaction');assert.equal(params[0],SIG);assert.deepEqual(params[1],{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0});inspect?.(params);return structuredClone(response);};}
async function collect(response){return collectSolanaTransactionVersionEvidence({rpc:rpcWith(response),signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'test_rpc',requestedAt,observedAt});}
async function rejects(response,code){await assert.rejects(()=>collect(response),e=>e?.code===code);}

for(const v of ['legacy',0]){
  const e=await collect(found(v));
  assert.equal(e.collection_status,'PENDING_DATA');
  assert.equal(e.metrics_available,false);
  assert.equal(e.transaction_version,v);
  assert.equal(e.source_reference,`solana_rpc:${SIG}@123`);
  assert.equal(e.verified,false);assert.equal(e.published,false);assert.equal(e.live_execution_authorized,false);
  for(const k of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(e[k],null);
  assert.equal(verifySolanaTransactionVersionEvidence(e),true);
}

const missing=await collect({result:null});
assert.equal(missing.source_reference,null);assert.equal(missing.transaction_version,null);assert.equal(verifySolanaTransactionVersionEvidence(missing),true);

await rejects(found(1),'unsupported_transaction_version');
const noVersion=found();delete noVersion.result.version;await rejects(noVersion,'missing_transaction_version');
const badErr=found();badErr.result.meta.err='failed';await rejects(badErr,'invalid_transaction_err');
const wrongSig=found();wrongSig.result.transaction.signatures=[('1'.repeat(63)+'2')];await rejects(wrongSig,'returned_signature_mismatch');
const noWallet=found();noWallet.result.transaction.message.accountKeys=[OTHER];await rejects(noWallet,'trader_wallet_not_participant');
const future=found();future.result.blockTime=1788449999;await rejects(future,'future_block_time');

const good=await collect(found(0));
for(const mutate of [
  e=>{e.verified=true;},
  e=>{e.published=true;},
  e=>{e.trades_count=1;},
  e=>{e.transaction_version='legacy';},
  e=>{e.source_reference='solana_rpc:fake@123';},
  e=>{e.provenance.transaction_version='legacy';},
  e=>{e.provenance.max_supported_transaction_version=1;},
]){const e=structuredClone(good);mutate(e);assert.equal(verifySolanaTransactionVersionEvidence(e),false);}

await assert.rejects(()=>collectSolanaTransactionVersionEvidence({rpc:rpcWith(found()),signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'https://secret.invalid/?token=x',requestedAt,observedAt}),e=>e?.code==='invalid_rpc_endpoint_label');

console.log('Solana transaction version evidence regression: PASS');
