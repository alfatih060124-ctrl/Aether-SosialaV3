import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { collectHistoricalSolUsdSnapshot } from '../packages/reconciliation-accounting/geckoterminal-sol-usd.mjs';
import { verifyHistoricalSolUsdSnapshot } from '../packages/reconciliation-accounting/geckoterminal-sol-usd-verifier.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production signature, tx hash, wallet, trade metric or source reference.
const POOL='11111111111111111111111111111111';
const WSOL='So11111111111111111111111111111111111111112';
const SLOT=123456789;
const BLOCK_TIME=1788239725;
const CANDLE_TIME=1788239700;
const OBSERVED='2030-01-01T00:00:00.000Z';

function ok(body){return{status:200,ok:true,json:async()=>body};}
function poolPayload(){return {data:{attributes:{address:POOL},relationships:{base_token:{data:{id:`solana_${WSOL}`}},quote_token:{data:{id:'solana_TEST_QUOTE'}}}}};}
function candlePayload(){return {data:{attributes:{ohlcv_list:[[CANDLE_TIME,149.5,151.1,148.8,150.1234567,1000000]]}}};}
function sourcePayload(value){
  return {
    schema_version:value.schema_version,
    source_type:value.source_type,
    provider:value.provider,
    api_version:value.api_version,
    network:value.network,
    pool_address:value.pool_address,
    wsol_mint:value.wsol_mint,
    token_side:value.token_side,
    anchor_slot:value.anchor_slot,
    transaction_block_time_unix:value.transaction_block_time_unix,
    candle_timestamp_unix:value.candle_timestamp_unix,
    candle_interval_seconds:value.candle_interval_seconds,
    price_usd_micro_per_sol:value.price_usd_micro_per_sol,
    candle:value.candle
  };
}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(sourcePayload(value))).digest('hex');}

const snapshot=await collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,
  anchorSlot:SLOT,
  transactionBlockTimeUnix:BLOCK_TIME,
  clock:()=>new Date(OBSERVED),
  fetchImpl:async(url)=>url.pathname.endsWith(`/pools/${POOL}`)?ok(poolPayload()):ok(candlePayload())
});

const checked=verifyHistoricalSolUsdSnapshot(snapshot);
assert.equal(checked.source_hash,snapshot.source_hash);
assert.equal(checked.source_reference,snapshot.source_reference);
assert.equal(checked.observed_at,OBSERVED);
assert.equal(checked.anchor_slot,SLOT);
assert.equal(checked.transaction_block_time_unix,BLOCK_TIME);
assert.equal(checked.price_usd_micro_per_sol,150_123_457);

const selfConsistentWrongPrice={...snapshot,price_usd_micro_per_sol:snapshot.price_usd_micro_per_sol+1};
selfConsistentWrongPrice.source_hash=hash(selfConsistentWrongPrice);
assert.throws(()=>verifyHistoricalSolUsdSnapshot(selfConsistentWrongPrice),/sol_usd_price_candle_mismatch/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,anchor_slot:SLOT+1}),/sol_usd_source_hash_mismatch/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,source_reference:`${snapshot.source_reference}:tampered`}),/sol_usd_source_reference_mismatch/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,observed_at:'2026-01-01T00:00:00.000Z'}),/sol_usd_observed_before_transaction/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,verified:true}),/sol_usd_boundary_violation/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,published:true}),/sol_usd_boundary_violation/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,live_execution_authorized:true}),/sol_usd_boundary_violation/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,provider_origin:'https://example.invalid'}}),/invalid_sol_usd_provenance/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,pool_url:'https://api.geckoterminal.com/unrelated?x=/api/v2/networks/solana/pools/11111111111111111111111111111111&include=base_token%2Cquote_token'}}),/sol_usd_pool_url_mismatch/);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,pool_url:`${snapshot.provenance.pool_url}&extra=1`}}),/sol_usd_pool_url_mismatch/);

const wrongTokenUrl=new URL(snapshot.provenance.ohlcv_url);
wrongTokenUrl.searchParams.set('token','quote');
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,ohlcv_url:wrongTokenUrl.toString()}}),/sol_usd_ohlcv_url_mismatch/);

const wrongBeforeUrl=new URL(snapshot.provenance.ohlcv_url);
wrongBeforeUrl.searchParams.set('before_timestamp',String(BLOCK_TIME+61));
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,ohlcv_url:wrongBeforeUrl.toString()}}),/sol_usd_ohlcv_url_mismatch/);

const unrelatedOhlcvUrl=new URL(snapshot.provenance.ohlcv_url);
unrelatedOhlcvUrl.pathname='/unrelated';
unrelatedOhlcvUrl.searchParams.set('x',`/api/v2/networks/solana/pools/${POOL}/ohlcv/minute`);
assert.throws(()=>verifyHistoricalSolUsdSnapshot({...snapshot,provenance:{...snapshot.provenance,ohlcv_url:unrelatedOhlcvUrl.toString()}}),/sol_usd_ohlcv_url_mismatch/);

console.log('historical SOL USD verifier regression: PASS');
