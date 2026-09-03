// SYNTHETIC / TEST-ONLY. No production signatures, tx hashes, wallets, or source references.
import assert from 'node:assert/strict';
import { collectSolanaAddressTableEvidence, verifySolanaAddressTableEvidence } from '../services/api/src/solana-address-table-evidence.mjs';

const SIG='BUguQsv2ZuHus54HAFzjdJHzZBkygAjKhEeYwSG19tUfUyvvz3worsdQCdAXDNjakJHioSiyxhFiDJrm8XpSXRA';
const WALLET='4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const TABLE='8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const LOADED_W='CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const LOADED_R='GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const requestedAt='2026-09-03T10:00:00.000Z';
const observedAt='2026-09-03T10:00:10.000Z';

function response(overrides={}){
  const base={result:{slot:123456,blockTime:1788429600,transaction:{signatures:[SIG],message:{accountKeys:[WALLET,TABLE],addressTableLookups:[{accountKey:TABLE,writableIndexes:[1],readonlyIndexes:[2]}]}},meta:{err:null,loadedAddresses:{writable:[LOADED_W],readonly:[LOADED_R]}}}};
  return structuredClone(Object.assign(base,overrides));
}
const rpcFrom = value => async (method,params)=>{ assert.equal(method,'getTransaction'); assert.equal(params[0],SIG); return structuredClone(value); };
const input = rpc => ({rpc,signature:SIG,traderWallet:WALLET,rpcEndpointLabel:'mainnet-primary',commitment:'confirmed',requestedAt,observedAt});

const valid=await collectSolanaAddressTableEvidence(input(rpcFrom(response())));
assert.equal(valid.collection_status,'PENDING_DATA');
assert.equal(valid.metrics_available,false); assert.equal(valid.verified,false); assert.equal(valid.published,false); assert.equal(valid.live_execution_authorized,false);
for(const k of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score']) assert.equal(valid[k],null);
assert.equal(valid.lookup_count,1); assert.equal(valid.loaded_writable_count,1); assert.equal(valid.loaded_readonly_count,1);
assert.equal(valid.source_reference,`solana_rpc:${SIG}@123456`);
assert.equal(verifySolanaAddressTableEvidence(valid),true);

const noLookupResp=response(); noLookupResp.result.transaction.message.addressTableLookups=[]; noLookupResp.result.meta.loadedAddresses={writable:[],readonly:[]};
const noLookup=await collectSolanaAddressTableEvidence(input(rpcFrom(noLookupResp)));
assert.equal(noLookup.source_reference,null); assert.equal(noLookup.lookup_count,0); assert.equal(verifySolanaAddressTableEvidence(noLookup),true);

const notFound=await collectSolanaAddressTableEvidence(input(rpcFrom({result:null})));
assert.equal(notFound.source_reference,null); assert.equal(notFound.lookup_count,0); assert.equal(verifySolanaAddressTableEvidence(notFound),true);

for (const mutate of [
  e=>{e.trades_count=1},
  e=>{e.verified=true},
  e=>{e.published=true},
  e=>{e.source_reference=`solana_rpc:${SIG}@123457`},
  e=>{e.provenance.loaded_cardinality.writable_expected=2},
  e=>{e.provenance.address_table_lookups[0].writable_indexes=[9]},
  e=>{e.provenance.loaded_addresses.writable=[LOADED_R]},
]) { const e=structuredClone(valid); mutate(e); assert.equal(verifySolanaAddressTableEvidence(e),false); }

async function mustReject(resp, code, extra={}){
  await assert.rejects(()=>collectSolanaAddressTableEvidence({...input(rpcFrom(resp)),...extra}),e=>e?.code===code);
}
const missingErr=response(); delete missingErr.result.meta.err; await mustReject(missingErr,'missing_transaction_err');
const mismatch=response(); mismatch.result.transaction.signatures[0]='1111111111111111111111111111111111111111111111111111111111111111'; await mustReject(mismatch,'returned_signature_mismatch');
const nonParticipant=response(); nonParticipant.result.transaction.message.accountKeys=[TABLE,LOADED_W]; await mustReject(nonParticipant,'trader_wallet_not_participant');
const badCount=response(); badCount.result.meta.loadedAddresses.readonly=[]; await mustReject(badCount,'loaded_address_count_mismatch');
const overlap=response(); overlap.result.transaction.message.addressTableLookups[0].readonlyIndexes=[1]; await mustReject(overlap,'overlapping_lookup_indexes_0');
const dupTable=response(); dupTable.result.transaction.message.addressTableLookups.push(structuredClone(dupTable.result.transaction.message.addressTableLookups[0])); await mustReject(dupTable,'duplicate_lookup_account_key');
const future=response(); future.result.blockTime=1788440000; await mustReject(future,'future_block_time');
await assert.rejects(()=>collectSolanaAddressTableEvidence({...input(rpcFrom(response())),rpcEndpointLabel:'https://rpc.example/?token=TEST_ONLY'}),e=>e?.code==='invalid_rpc_endpoint_label');

console.log('Solana address table evidence regression: PASS');
