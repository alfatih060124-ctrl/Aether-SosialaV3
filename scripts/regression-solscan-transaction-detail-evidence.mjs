import assert from 'node:assert/strict';
import { collectSolscanTransactionDetailEvidence, verifySolscanTransactionDetailEvidence } from '../services/api/src/solscan-transaction-detail-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never production signatures, wallets, trades, metrics, or source references.
const W='1'.repeat(32), O='1'.repeat(31)+'2', P='1'.repeat(31)+'3', M='1'.repeat(31)+'4', TA='1'.repeat(31)+'5';
const SIG='1'.repeat(64), SIG2='1'.repeat(63)+'2';
const requestedAt='2026-01-01T00:00:00.000Z', observedAt='2026-01-01T00:01:00.000Z';
const detail={tx_hash:SIG,block_id:100,block_time:1767225601,fee:5000,status:1,compute_units_consumed:12345,priority_fee:1000,signer:[W],programs_involved:[P],sol_bal_change:[{address:W,pre_balance:'1000000000',post_balance:'999995000',change_amount:'-5000'},{address:O,pre_balance:'1',post_balance:'2',change_amount:'1'}],token_bal_change:[{address:TA,token_address:M,change_type:'inc',change_amount:'10',decimals:6,pre_balance:'100',post_balance:'110',owner:W,pre_owner:W,post_owner:W}]};
const clone=v=>structuredClone(v);
async function collect(data=detail,extra={}){return collectSolscanTransactionDetailEvidence({query:async req=>{assert.equal(req.path,'/v2.0/transaction/detail');assert.equal(req.tx,SIG);return{success:true,data};},transactionSignature:SIG,traderWallet:W,sourceLabel:'solscan_pro_v2',requestedAt,observedAt,...extra});}

const e=await collect();
assert.equal(e.collection_status,'PENDING_DATA');assert.equal(e.metrics_available,false);assert.equal(e.verified,false);assert.equal(e.published,false);assert.equal(e.live_execution_authorized,false);assert.equal(e.reconciliation_required,true);assert.equal(e.trades_count,null);assert.equal(e.total_return_bps,null);assert.equal(e.win_rate_bps,null);assert.equal(e.drawdown_bps,null);assert.equal(e.reputation_score,null);assert.equal(e.source_reference,`solscan:transaction:${SIG}@100`);assert.equal(e.row.sol_balance_changes.length,1);assert.equal(e.row.token_balance_changes.length,1);assert.equal(verifySolscanTransactionDetailEvidence(e),true);
const missing=await collect(null);assert.equal(missing.source_reference,null);assert.equal(missing.row.found,false);assert.equal(verifySolscanTransactionDetailEvidence(missing),true);
for(const [field,value] of [['verified',true],['published',true],['live_execution_authorized',true],['trades_count',1],['total_return_bps',100],['win_rate_bps',5000],['drawdown_bps',100],['reputation_score',99]]){const x=clone(e);x[field]=value;assert.equal(verifySolscanTransactionDetailEvidence(x),false,field);}
{const x=clone(e);x.source_reference=`solscan:transaction:${SIG2}@100`;assert.equal(verifySolscanTransactionDetailEvidence(x),false);}
{const x=clone(e);x.provenance.row.token_balance_changes[0].change_amount='11';x.provenance.source_hash='0'.repeat(64);assert.equal(verifySolscanTransactionDetailEvidence(x),false);}
await assert.rejects(()=>collect({...detail,tx_hash:SIG2}),/transaction_signature_mismatch/);
await assert.rejects(()=>collect({...detail,signer:[O]}),/wallet_not_transaction_signer/);
await assert.rejects(()=>collect({...detail,block_time:1767225700}),/future_block_time/);
await assert.rejects(()=>collect({...detail,sol_bal_change:[{address:W,pre_balance:'100',post_balance:'90',change_amount:'-9'}]}),/sol_balance_delta_mismatch/);
await assert.rejects(()=>collect({...detail,token_bal_change:[{...detail.token_bal_change[0],post_balance:'111'}]}),/token_balance_delta_mismatch/);
await assert.rejects(()=>collect({...detail,token_bal_change:[{...detail.token_bal_change[0],change_type:'dec'}]}),/token_change_type_mismatch/);
await assert.rejects(()=>collect({...detail,fee:Number.MAX_SAFE_INTEGER+1}),/invalid_fee/);
await assert.rejects(()=>collect({...detail,signer:[W,W]}),/invalid_signers_duplicate/);
await assert.rejects(()=>collect(undefined,{sourceLabel:'https://secret.example/?token=x'}),/invalid_solscan_source_label/);
await assert.rejects(()=>collectSolscanTransactionDetailEvidence({query:async()=>({success:false,data:null}),transactionSignature:SIG,traderWallet:W,requestedAt,observedAt}),/invalid_solscan_response/);
await assert.rejects(()=>collect(undefined,{transactionSignature:'not-a-signature'}),/invalid_transaction_signature/);
console.log(JSON.stringify({ok:true,fixture_policy:'SYNTHETIC_TEST_ONLY',schema:e.schema,tests:25,collection_status:e.collection_status,metrics_available:e.metrics_available,verified:e.verified,published:e.published}));
