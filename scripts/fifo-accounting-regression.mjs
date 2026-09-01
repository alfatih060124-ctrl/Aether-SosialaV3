import assert from 'node:assert/strict';
import { buildFifoAccountingCandidates, INVENTORY_SCOPE, usdToMinor } from '../packages/reconciliation-accounting/fifo.mjs';

const QUOTE = 'TEST_QUOTE_MINT';
const BASE = 'TEST_BASE_MINT';
const OTHER = 'TEST_OTHER_MINT';
const WALLET = 'TEST_TRADER_WALLET';

function event({id,slot,tokenIn,tokenOut,inRaw,outRaw,usd,confidence=0.99,decoder='fixture-decoder-v1',wallet=WALLET}) {
  return {
    event_id:id,
    chain:'solana',
    dex:'fixture-dex',
    trader_wallet:wallet,
    token_in:tokenIn,
    token_out:tokenOut,
    amount_in_raw:String(inRaw),
    amount_out_raw:String(outRaw),
    amount_usd:String(usd),
    tx_hash:`fixture-signature-${id}`,
    slot,
    confidence,
    observed_at:new Date(Date.UTC(2026,7,1,0,0,slot)).toISOString(),
    decoder_version:decoder
  };
}

// SYNTHETIC TEST-ONLY events. These are accounting fixtures, never trader evidence.
const buy1=event({id:'buy-1',slot:1,tokenIn:QUOTE,tokenOut:BASE,inRaw:100_000_000,outRaw:100,usd:'100.000000'});
const buy2=event({id:'buy-2',slot:2,tokenIn:QUOTE,tokenOut:BASE,inRaw:60_000_000,outRaw:50,usd:'60.000000'});
const sell1=event({id:'sell-1',slot:3,tokenIn:BASE,tokenOut:QUOTE,inRaw:120,outRaw:150_000_000,usd:'150.000000'});
const sell2=event({id:'sell-2',slot:4,tokenIn:BASE,tokenOut:QUOTE,inRaw:20,outRaw:30_000_000,usd:'30.000000'});

const result=buildFifoAccountingCandidates({events:[sell2,buy2,sell1,buy1],quoteMints:[QUOTE]});
assert.equal(result.accounting_method,'FIFO_COST_BASIS_V1');
assert.equal(result.inventory_scope,INVENTORY_SCOPE);
assert.equal(result.usd_minor_scale,1_000_000);
assert.equal(result.candidates.length,2);
assert.equal(result.issues.length,0);
assert.equal(result.reconciliation_ready,false);
assert.equal(result.evidence_ready,false);
assert.equal(result.live_execution_authorized,false);

const first=result.candidates[0];
assert.equal(first.event_id,'sell-1');
assert.equal(first.proceeds_minor,150_000_000);
assert.equal(first.cost_basis_minor,124_000_000);
assert.equal(first.gross_realized_pnl_minor,26_000_000);
assert.deepEqual(first.source_lots,[
  {event_id:'buy-1',quantity_raw:'100',cost_minor:100_000_000},
  {event_id:'buy-2',quantity_raw:'20',cost_minor:24_000_000}
]);
assert.equal(first.status,'PENDING_FEES_AND_EQUITY');
assert.equal(first.inventory_scope,INVENTORY_SCOPE);
assert.equal(first.fee_minor,null);
assert.equal(first.net_realized_pnl_minor,null);
assert.equal(first.equity_after_minor,null);
assert.equal(first.capital_minor,null);
assert.equal(first.valuation_reference,null);
assert.equal(first.reconciliation_ready,false);
assert.equal(first.evidence_ready,false);
assert.equal(first.verified,false);
assert.equal(first.published,false);
assert.equal(first.live_execution_authorized,false);
assert.match(first.accounting_hash,/^[a-f0-9]{64}$/);

const second=result.candidates[1];
assert.equal(second.event_id,'sell-2');
assert.equal(second.cost_basis_minor,24_000_000);
assert.equal(second.proceeds_minor,30_000_000);
assert.equal(second.gross_realized_pnl_minor,6_000_000);
assert.deepEqual(result.open_lots[BASE],[{event_id:'buy-2',remaining_quantity_raw:'10',remaining_cost_minor:12_000_000}]);

// Input order must not affect accounting or hashes.
const ordered=buildFifoAccountingCandidates({events:[buy1,buy2,sell1,sell2],quoteMints:[QUOTE]});
assert.deepEqual(result.candidates,ordered.candidates);
assert.deepEqual(result.open_lots,ordered.open_lots);

// Zero opening inventory is explicit. A sell beyond observed lots blocks that token instead of guessing.
const oversell=buildFifoAccountingCandidates({events:[buy1,event({id:'oversell',slot:5,tokenIn:BASE,tokenOut:QUOTE,inRaw:150,outRaw:180_000_000,usd:'180.000000'}),event({id:'after-block',slot:6,tokenIn:QUOTE,tokenOut:BASE,inRaw:10_000_000,outRaw:10,usd:'10.000000'})],quoteMints:[QUOTE]});
assert.equal(oversell.candidates.length,0);
assert.deepEqual(oversell.blocked_tokens,[{token_mint:BASE,reason:'INSUFFICIENT_FIFO_INVENTORY'}]);
assert.equal(oversell.issues[0].inventory_scope,INVENTORY_SCOPE);
assert.equal(oversell.issues[0].reconciliation_ready,false);
assert.equal(oversell.skipped[0].reason,'TOKEN_ACCOUNTING_BLOCKED');

// Base/base and quote/quote swaps are unsupported rather than misclassified.
const unsupported=buildFifoAccountingCandidates({events:[
  event({id:'base-base',slot:7,tokenIn:BASE,tokenOut:OTHER,inRaw:10,outRaw:20,usd:'12.000000'}),
  event({id:'quote-quote',slot:8,tokenIn:QUOTE,tokenOut:'SECOND_QUOTE',inRaw:10,outRaw:10,usd:'10.000000'})
],quoteMints:[QUOTE,'SECOND_QUOTE']});
assert.deepEqual(unsupported.skipped.map(x=>x.reason),['NON_QUOTE_PAIR_UNSUPPORTED','QUOTE_TO_QUOTE_UNSUPPORTED']);
assert.equal(unsupported.candidates.length,0);

assert.throws(()=>buildFifoAccountingCandidates({events:[{...buy1,confidence:0.89}],quoteMints:[QUOTE]}),/accounting_event_confidence_too_low/);
assert.throws(()=>buildFifoAccountingCandidates({events:[{...buy1,event_id:'shadow-buy'}],quoteMints:[QUOTE]}),/synthetic_trade_event_blocked/);
assert.throws(()=>buildFifoAccountingCandidates({events:[buy1,{...buy2,trader_wallet:'OTHER_WALLET'}],quoteMints:[QUOTE]}),/mixed_trader_wallets/);
assert.throws(()=>buildFifoAccountingCandidates({events:[buy1],quoteMints:[]}),/quote_mints_required/);
assert.throws(()=>buildFifoAccountingCandidates({events:[buy1],quoteMints:[QUOTE,QUOTE]}),/duplicate_quote_mint/);
assert.equal(usdToMinor('1.234567'),1_234_567n);
assert.throws(()=>usdToMinor('1.2345678'),/amount_usd_precision_exceeds_scale/);

console.log('FIFO accounting candidate regression: PASS');
