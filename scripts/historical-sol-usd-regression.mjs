import assert from 'node:assert/strict';
import { collectHistoricalSolUsdSnapshot, HISTORICAL_SOL_USD_SOURCE } from '../packages/reconciliation-accounting/geckoterminal-sol-usd.mjs';

const POOL='11111111111111111111111111111111';
const WSOL='So11111111111111111111111111111111111111112';
const SLOT=123456789;
const BLOCK_TIME=1788239725;
const CANDLE_TIME=1788239700;
const OBSERVED='2030-01-01T00:00:00.000Z';

function ok(body){return{status:200,ok:true,json:async()=>body};}
function poolPayload({address=POOL,solSide='base'}={}){
  return {data:{
    id:`solana_${address}`,
    type:'pool',
    attributes:{address},
    relationships:{
      base_token:{data:{id:solSide==='base'?`solana_${WSOL}`:'solana_TEST_QUOTE',type:'token'}},
      quote_token:{data:{id:solSide==='quote'?`solana_${WSOL}`:'solana_TEST_QUOTE',type:'token'}}
    }
  }};
}
function candlePayload(rows){return{data:{type:'ohlcv_request_response',attributes:{ohlcv_list:rows}}};}

const calls=[];
const fetchImpl=async(url,options)=>{
  calls.push({url:url.toString(),options});
  if(url.pathname.endsWith(`/pools/${POOL}`)) return ok(poolPayload());
  if(url.pathname.endsWith(`/pools/${POOL}/ohlcv/minute`)) return ok(candlePayload([
    [CANDLE_TIME,149.5,151.1,148.8,150.1234567,1000000],
    [CANDLE_TIME-60,148,150,147,149.5,900000]
  ]));
  throw new Error('unexpected_test_url');
};

const snapshot=await collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,
  anchorSlot:SLOT,
  transactionBlockTimeUnix:BLOCK_TIME,
  fetchImpl,
  clock:()=>new Date(OBSERVED)
});
assert.equal(calls.length,2);
assert.match(calls[0].url,/\/api\/v2\/networks\/solana\/pools\//);
assert.match(calls[0].options.headers.accept,/application\/json;version=20230203/);
assert.match(calls[1].url,/\/ohlcv\/minute\?/);
assert.match(calls[1].url,/aggregate=1/);
assert.match(calls[1].url,new RegExp(`before_timestamp=${BLOCK_TIME+60}`));
assert.match(calls[1].url,/limit=2/);
assert.match(calls[1].url,/currency=usd/);
assert.match(calls[1].url,/token=base/);
assert.match(calls[1].url,/include_empty_intervals=true/);
assert.equal(snapshot.source_type,'SOL_USD_PRICE_V1');
assert.equal(snapshot.provider,'GECKOTERMINAL_PUBLIC');
assert.equal(snapshot.api_version,'20230203');
assert.equal(snapshot.pool_address,POOL);
assert.equal(snapshot.wsol_mint,WSOL);
assert.equal(snapshot.token_side,'base');
assert.equal(snapshot.anchor_slot,SLOT);
assert.equal(snapshot.transaction_block_time_unix,BLOCK_TIME);
assert.equal(snapshot.candle_timestamp_unix,CANDLE_TIME);
assert.equal(snapshot.candle_interval_seconds,60);
assert.equal(snapshot.price_usd_micro_per_sol,150_123_457);
assert.equal(snapshot.currency,'USD_MICRO_PER_SOL');
assert.equal(snapshot.status,'HISTORICAL_PRICE_OBSERVED');
assert.equal(snapshot.observed_at,OBSERVED);
assert.equal(snapshot.read_only,true);
assert.equal(snapshot.reconciliation_ready,false);
assert.equal(snapshot.evidence_ready,false);
assert.equal(snapshot.verified,false);
assert.equal(snapshot.published,false);
assert.equal(snapshot.live_execution_authorized,false);
assert.match(snapshot.source_reference,new RegExp(`^GECKOTERMINAL:${POOL}:minute:1:${CANDLE_TIME}:base$`));
assert.match(snapshot.source_hash,/^[a-f0-9]{64}$/);
assert.equal(snapshot.provenance.selection_policy,'EXPLICIT_POOL_ADDRESS_REQUIRED');
assert.equal(HISTORICAL_SOL_USD_SOURCE.wsol_mint,WSOL);
assert.equal(HISTORICAL_SOL_USD_SOURCE.candle_interval_seconds,60);

const deterministic=await collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,fetchImpl,clock:()=>new Date(OBSERVED)
});
assert.equal(deterministic.source_hash,snapshot.source_hash);

const quoteCalls=[];
const quoteSide=await collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,
  anchorSlot:SLOT,
  transactionBlockTimeUnix:BLOCK_TIME,
  clock:()=>new Date(OBSERVED),
  fetchImpl:async(url,options)=>{
    quoteCalls.push({url:url.toString(),options});
    if(url.pathname.endsWith(`/pools/${POOL}`)) return ok(poolPayload({solSide:'quote'}));
    return ok(candlePayload([[CANDLE_TIME,150,152,149,151,1000]]));
  }
});
assert.equal(quoteSide.token_side,'quote');
assert.match(quoteCalls[1].url,/token=quote/);

await assert.rejects(()=>collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,clock:()=>new Date(OBSERVED),
  fetchImpl:async(url)=>url.pathname.endsWith(`/pools/${POOL}`)
    ?ok(poolPayload({address:WSOL}))
    :ok(candlePayload([[CANDLE_TIME,150,151,149,150,1]]))
}),/geckoterminal_pool_canonical_mismatch/);

await assert.rejects(()=>collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,clock:()=>new Date(OBSERVED),
  fetchImpl:async(url)=>url.pathname.endsWith(`/pools/${POOL}`)
    ?ok({data:{attributes:{address:POOL},relationships:{base_token:{data:{id:'solana_A'}},quote_token:{data:{id:'solana_B'}}}}})
    :ok(candlePayload([[CANDLE_TIME,150,151,149,150,1]]))
}),/geckoterminal_pool_missing_wsol/);

await assert.rejects(()=>collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,clock:()=>new Date(OBSERVED),
  fetchImpl:async(url)=>url.pathname.endsWith(`/pools/${POOL}`)
    ?ok(poolPayload())
    :ok(candlePayload([[CANDLE_TIME-120,150,151,149,150,1]]))
}),/geckoterminal_candle_not_found/);

await assert.rejects(()=>collectHistoricalSolUsdSnapshot({
  poolAddress:POOL,anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,clock:()=>new Date(OBSERVED),
  fetchImpl:async()=>({status:429,ok:false,json:async()=>({})})
}),/geckoterminal_rate_limited/);

await assert.rejects(()=>collectHistoricalSolUsdSnapshot({poolAddress:'bad',anchorSlot:SLOT,transactionBlockTimeUnix:BLOCK_TIME,fetchImpl}),/invalid_geckoterminal_pool_address/);
await assert.rejects(()=>collectHistoricalSolUsdSnapshot({poolAddress:POOL,anchorSlot:'bad',transactionBlockTimeUnix:BLOCK_TIME,fetchImpl}),/invalid_sol_usd_anchor_slot/);

console.log('historical SOL USD regression: PASS');
