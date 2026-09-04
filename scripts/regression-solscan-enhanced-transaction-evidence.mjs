import assert from 'node:assert/strict';
import { collectSolscanEnhancedTransactionEvidence, verifySolscanEnhancedTransactionEvidence } from '../services/api/src/solscan-enhanced-transaction-evidence.mjs';

// SYNTHETIC / TEST-ONLY fixtures. Never production evidence.
const WALLET='11111111111111111111111111111111';
const OTHER='So11111111111111111111111111111111111111112';
const SIG='1'.repeat(64);
const requestedAt='2026-09-03T19:20:00.000Z';
const observedAt='2026-09-03T19:20:10.000Z';
const tx=({wallet=WALLET,signature=SIG,blockTime=1700000000,version='legacy'}={})=>({slot:321,blockTime,version,transaction:{signatures:[signature],message:{accountKeys:[wallet,OTHER]}},meta:{fee:5000,err:null}});
const response=(transactions=[tx()],cursor='opaque-page-2')=>({success:true,data:{cursor,transactions}});
let captured;
const evidence=await collectSolscanEnhancedTransactionEvidence({query:async req=>(captured=req,response()),traderWallet:WALLET,requestCursor:'opaque-page-1',limit:20,requestedAt,observedAt});
assert.deepEqual(captured,{path:'/v2.0/account/transactions/enhanced',address:WALLET,limit:20,encoding:'json',cursor:'opaque-page-1'});
assert.equal(evidence.collection_status,'PENDING_DATA');
assert.equal(evidence.metrics_available,false);
assert.equal(evidence.verified,false);assert.equal(evidence.published,false);assert.equal(evidence.live_execution_authorized,false);
for(const key of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score','calculation_hash']) assert.equal(evidence[key],null);
assert.equal(evidence.source_reference,null);assert.equal(evidence.evidence_count,1);assert.equal(evidence.next_cursor,'opaque-page-2');
assert.equal(evidence.rows[0].source_reference,`solscan:transaction:${SIG}@321`);assert.equal(verifySolscanEnhancedTransactionEvidence(evidence),true);
for(const [key,value] of [['verified',true],['published',true],['live_execution_authorized',true],['trades_count',1],['total_return_bps',1],['win_rate_bps',1],['drawdown_bps',1],['reputation_score',1],['calculation_hash','fabricated']]){const tampered=structuredClone(evidence);tampered[key]=value;assert.equal(verifySolscanEnhancedTransactionEvidence(tampered),false);}
const cursorTamper=structuredClone(evidence);cursorTamper.next_cursor='made-up';assert.equal(verifySolscanEnhancedTransactionEvidence(cursorTamper),false);
const rowTamper=structuredClone(evidence);rowTamper.rows[0].fee_lamports=1;assert.equal(verifySolscanEnhancedTransactionEvidence(rowTamper),false);
const provenanceTamper=structuredClone(evidence);provenanceTamper.provenance.rows[0].slot=999;assert.equal(verifySolscanEnhancedTransactionEvidence(provenanceTamper),false);
const aggregateRef=structuredClone(evidence);aggregateRef.source_reference=`solscan:transaction:${SIG}@321`;assert.equal(verifySolscanEnhancedTransactionEvidence(aggregateRef),false);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response(),traderWallet:'z'.repeat(44),limit:20,requestedAt,observedAt}),/invalid_trader_wallet/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response([tx({wallet:OTHER})]),traderWallet:WALLET,limit:20,requestedAt,observedAt}),/wallet_not_transaction_participant/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response([tx(),tx()]),traderWallet:WALLET,limit:20,requestedAt,observedAt}),/duplicate_signature/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response([tx({blockTime:4102444800})]),traderWallet:WALLET,limit:20,requestedAt,observedAt}),/future_block_time/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response([tx({version:1})]),traderWallet:WALLET,limit:20,requestedAt,observedAt}),/unsupported_transaction_version/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>response(),traderWallet:WALLET,limit:101,requestedAt,observedAt}),/invalid_limit/);
await assert.rejects(()=>collectSolscanEnhancedTransactionEvidence({query:async()=>{throw new Error('provider down');},traderWallet:WALLET,limit:20,requestedAt,observedAt}),/provider down/);
const empty=await collectSolscanEnhancedTransactionEvidence({query:async()=>response([],null),traderWallet:WALLET,limit:20,requestedAt,observedAt});assert.equal(empty.evidence_count,0);assert.equal(empty.next_cursor,null);assert.equal(verifySolscanEnhancedTransactionEvidence(empty),true);
console.log('Solscan enhanced transaction evidence regression: SYNTHETIC / TEST-ONLY PASS');
