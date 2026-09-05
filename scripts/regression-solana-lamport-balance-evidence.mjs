import assert from 'node:assert/strict';
import { collectSolanaLamportBalanceEvidence, verifySolanaLamportBalanceEvidence } from '../services/api/src/solana-lamport-balance-evidence.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These identifiers and balances are not production evidence.
const SIG='1'.repeat(64);const WALLET='1'.repeat(32);const OTHER='1'.repeat(31)+'2';
const requestedAt='2026-09-03T13:00:00.000Z';const observedAt='2026-09-03T13:00:10.000Z';
function found(){return{result:{slot:321,blockTime:1788440400,transaction:{signatures:[SIG],message:{accountKeys:[{pubkey:WALLET,signer:true,writable:true,source:'transaction'},{pubkey:OTHER,signer:false,writable:true,source:'transaction'}]}},meta:{err:null,preBalances:[5000000,2000000],postBalances:[4750000,2250000]}}};}
function rpcWith(response){return async(method,params)=>{assert.equal(method,'getTransaction');assert.equal(params[0],SIG);assert.deepEqual(params[1],{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0});return structuredClone(response);};}
async function collect(response){return collectSolanaLamportBalanceEvidence({rpc:rpcWith(response),signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'test_rpc',requestedAt,observedAt});}
async function rejects(response,code){await assert.rejects(()=>collect(response),e=>e?.code===code);}

const good=await collect(found());
assert.equal(good.collection_status,'PENDING_DATA');assert.equal(good.metrics_available,false);assert.equal(good.source_reference,`solana_rpc:${SIG}@321`);assert.equal(good.trader_pre_lamports,5000000);assert.equal(good.trader_post_lamports,4750000);assert.equal(good.trader_delta_lamports,'-250000');assert.equal(good.verified,false);assert.equal(good.published,false);assert.equal(good.live_execution_authorized,false);for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(good[k],null);assert.equal(verifySolanaLamportBalanceEvidence(good),true);

const missing=await collect({result:null});assert.equal(missing.source_reference,null);assert.equal(missing.trader_delta_lamports,null);assert.equal(verifySolanaLamportBalanceEvidence(missing),true);
const card=found();card.result.meta.postBalances=[4750000];await rejects(card,'lamport_balance_cardinality_mismatch');
const unsafe=found();unsafe.result.meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1;await rejects(unsafe,'invalid_pre_balance_0');
const negative=found();negative.result.meta.postBalances[0]=-1;await rejects(negative,'invalid_post_balance_0');
const wrongSig=found();wrongSig.result.transaction.signatures=['1'.repeat(63)+'2'];await rejects(wrongSig,'returned_signature_mismatch');
const noWallet=found();noWallet.result.transaction.message.accountKeys=[{pubkey:OTHER}];noWallet.result.meta.preBalances=[1];noWallet.result.meta.postBalances=[1];await rejects(noWallet,'trader_wallet_not_participant');
const future=found();future.result.blockTime=1788449999;await rejects(future,'future_block_time');
const badErr=found();badErr.result.meta.err='failed';await rejects(badErr,'invalid_transaction_err');

for(const mutate of[e=>{e.verified=true;},e=>{e.published=true;},e=>{e.trades_count=1;},e=>{e.trader_delta_lamports='0';},e=>{e.provenance.trader_delta_lamports='0';},e=>{e.provenance.trader_account_index=1;},e=>{e.source_reference='solana_rpc:fake@321';}]){const e=structuredClone(good);mutate(e);assert.equal(verifySolanaLamportBalanceEvidence(e),false);}
await assert.rejects(()=>collectSolanaLamportBalanceEvidence({rpc:rpcWith(found()),signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'https://secret.invalid/?token=x',requestedAt,observedAt}),e=>e?.code==='invalid_rpc_endpoint_label');
console.log('Solana lamport balance evidence regression: PASS');
