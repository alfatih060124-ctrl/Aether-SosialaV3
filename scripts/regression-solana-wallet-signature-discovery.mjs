import assert from 'node:assert/strict';
import { collectSolanaWalletSignatureDiscovery, verifySolanaWalletSignatureDiscovery } from '../services/api/src/solana-wallet-signature-discovery.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These identifiers are not production evidence.
const WALLET='1'.repeat(32);const SIG1='1'.repeat(64);const SIG2='1'.repeat(63)+'2';
const requestedAt='2026-09-03T15:20:00.000Z';const observedAt='2026-09-03T15:20:10.000Z';
function rows(){return[{signature:SIG1,slot:500,blockTime:1788448800,err:null,memo:null,confirmationStatus:'finalized'},{signature:SIG2,slot:499,blockTime:1788448799,err:{InstructionError:[0,'Custom']},memo:'test-only',confirmationStatus:'confirmed'}];}
function rpcWith(result){return async(method,params)=>{assert.equal(method,'getSignaturesForAddress');assert.equal(params[0],WALLET);assert.deepEqual(params[1],{commitment:'confirmed',limit:25});return{result:structuredClone(result)};};}
async function collect(result){return collectSolanaWalletSignatureDiscovery({rpc:rpcWith(result),traderWallet:WALLET,rpcEndpointLabel:'test_rpc',requestedAt,observedAt});}
async function rejects(result,code){await assert.rejects(()=>collect(result),e=>e?.code===code);}

const good=await collect(rows());assert.equal(good.collection_status,'PENDING_DATA');assert.equal(good.metrics_available,false);assert.equal(good.verified,false);assert.equal(good.published,false);assert.equal(good.live_execution_authorized,false);assert.equal(good.source_reference,null);assert.equal(good.discovered_signature_count,2);assert.equal(good.rows[0].source_reference,`solana_rpc:${SIG1}@500`);assert.equal(good.rows[1].source_reference,`solana_rpc:${SIG2}@499`);for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(good[k],null);assert.equal(verifySolanaWalletSignatureDiscovery(good),true);
const empty=await collect([]);assert.equal(empty.discovered_signature_count,0);assert.deepEqual(empty.rows,[]);assert.equal(empty.source_reference,null);assert.equal(verifySolanaWalletSignatureDiscovery(empty),true);
const duplicate=rows();duplicate[1].signature=SIG1;await rejects(duplicate,'duplicate_signature');
const ascending=rows();ascending[1].slot=501;await rejects(ascending,'signature_rows_not_descending');
const future=rows();future[0].blockTime=1788459999;await rejects(future,'future_block_time');
const badErr=rows();badErr[0].err='failed';await rejects(badErr,'invalid_transaction_err');
const badMemo=rows();badMemo[0].memo='x'.repeat(513);await rejects(badMemo,'invalid_memo');
const badStatus=rows();badStatus[0].confirmationStatus='unknown';await rejects(badStatus,'invalid_confirmation_status');
for(const mutate of[e=>{e.verified=true;},e=>{e.published=true;},e=>{e.trades_count=2;},e=>{e.source_reference=e.rows[0].source_reference;},e=>{e.rows[0].slot=1;},e=>{e.provenance.rows[0].slot=1;},e=>{e.discovered_signature_count=99;}]){const e=structuredClone(good);mutate(e);assert.equal(verifySolanaWalletSignatureDiscovery(e),false);}
await assert.rejects(()=>collectSolanaWalletSignatureDiscovery({rpc:rpcWith(rows()),traderWallet:WALLET,rpcEndpointLabel:'https://secret.invalid/?token=x',requestedAt,observedAt}),e=>e?.code==='invalid_rpc_endpoint_label');
await assert.rejects(()=>collectSolanaWalletSignatureDiscovery({rpc:rpcWith(rows()),traderWallet:WALLET,rpcEndpointLabel:'test_rpc',limit:101,requestedAt,observedAt}),e=>e?.code==='invalid_limit');
console.log('Solana wallet signature discovery regression: PASS');
