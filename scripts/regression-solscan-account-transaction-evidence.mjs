import assert from 'node:assert/strict';
import { collectSolscanAccountTransactionEvidence, verifySolscanAccountTransactionEvidence } from '../services/api/src/solscan-account-transaction-evidence.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production signature, tx hash, metric, or source reference is asserted here.
const WALLET='1'.repeat(32), SIG1='1'.repeat(64), SIG2='1'.repeat(63)+'2', PROGRAM='2'.repeat(32);
const requestedAt='2026-09-03T15:00:00.000Z', observedAt='2026-09-03T15:00:10.000Z';
function rows(){return[{slot:700,fee:5000,status:'Success',signer:[WALLET],block_time:1788447600,tx_hash:SIG1,program_ids:[PROGRAM]},{slot:699,fee:7000,status:'Fail',signer:[WALLET],block_time:1788447599,tx_hash:SIG2,program_ids:[]}];}
function queryWith(data){return async req=>{assert.deepEqual(req,{path:'/v2.0/account/transactions',address:WALLET,limit:20,before:null});return{success:true,data:structuredClone(data)};};}
async function collect(data){return collectSolscanAccountTransactionEvidence({query:queryWith(data),traderWallet:WALLET,sourceLabel:'solscan_test',requestedAt,observedAt});}
async function rejects(data,code){await assert.rejects(()=>collect(data),e=>e?.code===code);}

const good=await collect(rows());assert.equal(good.collection_status,'PENDING_DATA');assert.equal(good.metrics_available,false);assert.equal(good.verified,false);assert.equal(good.published,false);assert.equal(good.live_execution_authorized,false);assert.equal(good.source_reference,null);assert.equal(good.evidence_count,2);assert.equal(good.rows[0].source_reference,`solscan:transaction:${SIG1}@700`);for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'])assert.equal(good[k],null);assert.equal(verifySolscanAccountTransactionEvidence(good),true);
const empty=await collect([]);assert.equal(empty.evidence_count,0);assert.deepEqual(empty.rows,[]);assert.equal(verifySolscanAccountTransactionEvidence(empty),true);
const duplicate=rows();duplicate[1].tx_hash=SIG1;await rejects(duplicate,'duplicate_tx_hash');
const ascending=rows();ascending[1].slot=701;await rejects(ascending,'rows_not_descending');
const foreign=rows();foreign[0].signer=['3'.repeat(32)];await rejects(foreign,'wallet_not_signer');
const future=rows();future[0].block_time=1788459999;await rejects(future,'future_block_time');
const badStatus=rows();badStatus[0].status='Unknown';await rejects(badStatus,'invalid_transaction_status');
const unsafeFee=rows();unsafeFee[0].fee=Number.MAX_SAFE_INTEGER+1;await rejects(unsafeFee,'invalid_fee_0');
for(const mutate of[e=>{e.verified=true;},e=>{e.published=true;},e=>{e.trades_count=2;},e=>{e.source_reference=e.rows[0].source_reference;},e=>{e.rows[0].slot=1;},e=>{e.provenance.rows[0].fee_lamports=1;},e=>{e.evidence_count=99;}]){const e=structuredClone(good);mutate(e);assert.equal(verifySolscanAccountTransactionEvidence(e),false);}
await assert.rejects(()=>collectSolscanAccountTransactionEvidence({query:queryWith(rows()),traderWallet:WALLET,sourceLabel:'https://pro-api.solscan.io?token=secret',requestedAt,observedAt}),e=>e?.code==='invalid_solscan_source_label');
await assert.rejects(()=>collectSolscanAccountTransactionEvidence({query:async()=>({success:false,data:[]}),traderWallet:WALLET,sourceLabel:'solscan_test',requestedAt,observedAt}),e=>e?.code==='invalid_solscan_response');
console.log('Solscan account transaction evidence regression: PASS');
