import assert from 'node:assert/strict';
import { collectSolscanAccountTransferEvidence, verifySolscanAccountTransferEvidence } from '../services/api/src/solscan-account-transfer-evidence.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production signature, tx hash, trade count, return, win rate, drawdown, reputation score, or source reference is fabricated here.
const WALLET='1'.repeat(32), OTHER='1'.repeat(31)+'2', TOKEN='1'.repeat(31)+'3', SIG1='1'.repeat(64), SIG2='1'.repeat(63)+'2';
const requestedAt='2026-09-03T15:00:00.000Z', observedAt='2026-09-03T15:00:10.000Z';
function rows(){return[{block_id:800,trans_id:SIG1,block_time:1788447600,activity_type:'ACTIVITY_SPL_TRANSFER',from_address:WALLET,from_token_account:null,to_address:OTHER,to_token_account:null,token_address:TOKEN,token_decimals:6,amount:1000000},{block_id:799,trans_id:SIG2,block_time:1788447599,activity_type:'ACTIVITY_SPL_TRANSFER',from_address:OTHER,from_token_account:null,to_address:WALLET,to_token_account:null,token_address:TOKEN,token_decimals:6,amount:2500000}];}
function queryWith(data){return async req=>{assert.deepEqual(req,{path:'/v2.0/account/transfer',address:WALLET,activity_type:['ACTIVITY_SPL_TRANSFER'],exclude_amount_zero:true,page:1,page_size:20,sort_by:'block_time',sort_order:'desc'});return{success:true,data:structuredClone(data)};};}
async function collect(data){return collectSolscanAccountTransferEvidence({query:queryWith(data),traderWallet:WALLET,sourceLabel:'solscan_test',requestedAt,observedAt});}
async function rejects(data,code){await assert.rejects(()=>collect(data),e=>e?.code===code);}

const good=await collect(rows());assert.equal(good.collection_status,'PENDING_DATA');assert.equal(good.metrics_available,false);assert.equal(good.verified,false);assert.equal(good.published,false);assert.equal(good.live_execution_authorized,false);assert.equal(good.source_reference,null);assert.equal(good.evidence_count,2);assert.equal(good.rows[0].direction,'OUT');assert.equal(good.rows[1].direction,'IN');assert.equal(good.rows[0].amount_base_units,1000000);for(const k of['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score','calculation_hash'])assert.equal(good[k],null);assert.equal(verifySolscanAccountTransferEvidence(good),true);
const empty=await collect([]);assert.equal(empty.evidence_count,0);assert.equal(verifySolscanAccountTransferEvidence(empty),true);
const ascending=rows();ascending[1].block_time=1788447601;await rejects(ascending,'rows_not_descending');
const duplicate=rows();duplicate[1].trans_id=duplicate[0].trans_id;await rejects(duplicate,'duplicate_signature');
const foreign=rows();foreign[0].from_address=OTHER;foreign[0].to_address=OTHER;await rejects(foreign,'wallet_not_transfer_party');
const zero=rows();zero[0].amount=0;await rejects(zero,'zero_amount_transfer');
const unsafe=rows();unsafe[0].amount=Number.MAX_SAFE_INTEGER+1;await rejects(unsafe,'invalid_amount_0');
const future=rows();future[0].block_time=1788459999;await rejects(future,'future_block_time');
const wrongActivity=rows();wrongActivity[0].activity_type='ACTIVITY_SPL_MINT';await rejects(wrongActivity,'invalid_activity_type');
for(const mutate of[e=>{e.verified=true;},e=>{e.published=true;},e=>{e.live_execution_authorized=true;},e=>{e.trades_count=2;},e=>{e.total_return_bps=10;},e=>{e.calculation_hash='0'.repeat(64);},e=>{e.source_reference=e.rows[0].source_reference;},e=>{e.rows[0].amount_base_units=1;},e=>{e.provenance.rows[0].token_decimals=9;},e=>{e.evidence_count=99;}]){const e=structuredClone(good);mutate(e);assert.equal(verifySolscanAccountTransferEvidence(e),false);}
await assert.rejects(()=>collectSolscanAccountTransferEvidence({query:queryWith(rows()),traderWallet:WALLET,sourceLabel:'https://pro-api.solscan.io?token=secret',requestedAt,observedAt}),e=>e?.code==='invalid_solscan_source_label');
await assert.rejects(()=>collectSolscanAccountTransferEvidence({query:async()=>({success:false,data:[]}),traderWallet:WALLET,sourceLabel:'solscan_test',requestedAt,observedAt}),e=>e?.code==='invalid_solscan_response');
console.log('Solscan account transfer evidence regression: PASS');
