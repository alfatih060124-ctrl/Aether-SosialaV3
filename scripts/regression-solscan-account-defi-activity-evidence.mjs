import assert from 'node:assert/strict';
import { collectSolscanAccountDefiActivityEvidence, verifySolscanAccountDefiActivityEvidence } from '../services/api/src/solscan-account-defi-activity-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never production signatures, wallets, trades, metrics, or source references.
const W='1'.repeat(32), O='1'.repeat(31)+'2', P='1'.repeat(31)+'3', S='1'.repeat(31)+'4', T1='1'.repeat(31)+'5', T2='1'.repeat(31)+'6';
const SIG='1'.repeat(64), SIG2='1'.repeat(63)+'2';
const requestedAt='2026-01-01T00:00:00.000Z', observedAt='2026-01-01T00:01:00.000Z';
const row={block_id:100,trans_id:SIG,block_time:1767225601,activity_type:'ACTIVITY_TOKEN_SWAP',from_address:W,to_address:O,platform:[P],sources:[S],routers:[{token1:T1,token1_decimals:9,amount1:'1000000000',token2:T2,token2_decimals:6,amount2:'25000000',child_routers:[]}]};
const clone=v=>structuredClone(v);
async function collect(rows=[row],extra={}){return collectSolscanAccountDefiActivityEvidence({query:async req=>{assert.equal(req.path,'/v2.0/account/defi/activities');assert.deepEqual(req.activity_type,['ACTIVITY_TOKEN_SWAP','ACTIVITY_AGG_TOKEN_SWAP']);assert.equal(req.sort_by,'block_time');assert.equal(req.sort_order,'desc');return{success:true,data:rows};},traderWallet:W,sourceLabel:'solscan_pro_v2',page:1,pageSize:20,requestedAt,observedAt,...extra});}

const e=await collect();
assert.equal(e.collection_status,'PENDING_DATA');assert.equal(e.metrics_available,false);assert.equal(e.verified,false);assert.equal(e.published,false);assert.equal(e.live_execution_authorized,false);assert.equal(e.reconciliation_required,true);assert.equal(e.source_reference,null);assert.equal(e.trades_count,null);assert.equal(e.total_return_bps,null);assert.equal(e.win_rate_bps,null);assert.equal(e.drawdown_bps,null);assert.equal(e.reputation_score,null);assert.equal(e.evidence_count,1);assert.equal(e.rows[0].source_reference,`solscan:transaction:${SIG}@100`);assert.equal(verifySolscanAccountDefiActivityEvidence(e),true);
const empty=await collect([]);assert.equal(empty.evidence_count,0);assert.equal(verifySolscanAccountDefiActivityEvidence(empty),true);
for(const [field,value] of [['verified',true],['published',true],['live_execution_authorized',true],['trades_count',1],['total_return_bps',100],['win_rate_bps',5000],['drawdown_bps',100],['reputation_score',99],['source_reference',`solscan:transaction:${SIG}@100`]]){const x=clone(e);x[field]=value;assert.equal(verifySolscanAccountDefiActivityEvidence(x),false,field);}
{const x=clone(e);x.rows[0].activity_type='ACTIVITY_AGG_TOKEN_SWAP';assert.equal(verifySolscanAccountDefiActivityEvidence(x),false);}
{const x=clone(e);x.provenance.rows[0].routers[0].amount1='999';assert.equal(verifySolscanAccountDefiActivityEvidence(x),false);}
await assert.rejects(()=>collect([row,{...row,trans_id:SIG2,block_id:101,block_time:1767225602}]),/rows_not_descending/);
await assert.rejects(()=>collect([row,{...row,block_id:99,block_time:1767225600}]),/duplicate_tx_hash/);
await assert.rejects(()=>collect([{...row,from_address:O,to_address:P}]),/wallet_not_activity_party/);
await assert.rejects(()=>collect([{...row,activity_type:'ACTIVITY_TOKEN_ADD_LIQ'}]),/invalid_activity_type/);
await assert.rejects(()=>collect([{...row,routers:[{...row.routers[0],amount1:'1e9'}]}]),/invalid_routers_0_0_amount1/);
await assert.rejects(()=>collect([{...row,block_time:1767225700}]),/future_block_time/);
await assert.rejects(()=>collect(undefined,{sourceLabel:'https://secret.example/?token=x'}),/invalid_solscan_source_label/);
await assert.rejects(()=>collect(undefined,{pageSize:11}),/invalid_page_size/);
await assert.rejects(()=>collectSolscanAccountDefiActivityEvidence({query:async()=>({success:false,data:[]}),traderWallet:W,requestedAt,observedAt}),/invalid_solscan_response/);
console.log(JSON.stringify({ok:true,fixture_policy:'SYNTHETIC_TEST_ONLY',schema:e.schema,tests:22,collection_status:e.collection_status,metrics_available:e.metrics_available,verified:e.verified,published:e.published}));
