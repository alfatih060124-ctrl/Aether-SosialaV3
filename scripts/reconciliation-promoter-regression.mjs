import assert from 'node:assert/strict';
import { buildFifoAccountingCandidates } from '../packages/reconciliation-accounting/fifo.mjs';
import { promoteAccountingCandidate, verifyAccountingCandidate } from '../packages/reconciliation-accounting/promoter.mjs';

const QUOTE='TEST_QUOTE_MINT';
const BASE='TEST_BASE_MINT';
const WALLET='TEST_TRADER_WALLET';
const observed='2026-08-31T00:00:00.000Z';
function event(id,slot,tokenIn,tokenOut,inRaw,outRaw,usd){return{event_id:id,chain:'solana',dex:'fixture',trader_wallet:WALLET,token_in:tokenIn,token_out:tokenOut,amount_in_raw:String(inRaw),amount_out_raw:String(outRaw),amount_usd:String(usd),tx_hash:`fixture-signature-${id}`,slot,confidence:0.99,observed_at:observed,decoder_version:'fixture-decoder-v1'}}

// SYNTHETIC TEST-ONLY accounting fixture. It is not verification evidence.
const fifo=buildFifoAccountingCandidates({events:[
  event('buy-1',100,QUOTE,BASE,100_000_000,100,'100.000000'),
  event('sell-1',101,BASE,QUOTE,100,130_000_000,'130.000000')
],quoteMints:[QUOTE]});
const candidate=fifo.candidates[0];
assert.equal(candidate.gross_realized_pnl_minor,30_000_000);
assert.doesNotThrow(()=>verifyAccountingCandidate(candidate));

const feeSnapshot={
  source_type:'ADDITIONAL_NON_EMBEDDED_FEES_V1',
  source_reference:'fixture-fee-observation-0001',
  source_hash:'a'.repeat(64),
  source_slot:101,
  observed_at:observed,
  additional_fee_minor:1_500_000,
  network_fee_minor:500_000,
  platform_execution_fee_minor:1_000_000,
  other_explicit_fee_minor:0,
  embedded_swap_fee_handling:'ALREADY_REFLECTED_IN_EXECUTION_VALUE'
};
const valuationSnapshot={
  source_type:'TRADE_USD_VALUATION_V1',
  source_reference:'fixture-trade-valuation-0001',
  source_hash:'b'.repeat(64),
  source_slot:101,
  observed_at:observed,
  proceeds_minor:130_000_000,
  cost_basis_minor:100_000_000,
  currency:'USD_MICRO'
};
const equitySnapshot={
  source_type:'WALLET_EQUITY_SNAPSHOT_V1',
  source_reference:'fixture-wallet-equity-0001',
  source_hash:'c'.repeat(64),
  source_slot:101,
  observed_at:observed,
  equity_after_minor:528_500_000,
  currency:'USD_MICRO',
  balance_scope:'FULL_TRADER_WALLET_MARK_TO_MARKET'
};

const promoted=promoteAccountingCandidate({candidate,feeSnapshot,valuationSnapshot,equitySnapshot});
assert.equal(promoted.status,'RECONCILIATION_READY');
assert.equal(promoted.realized_pnl_minor,28_500_000);
assert.equal(promoted.capital_minor,100_000_000);
assert.equal(promoted.equity_after_minor,528_500_000);
assert.equal(promoted.accounting_method,'FIFO_COST_BASIS_V1');
assert.equal(promoted.reconciliation_ready,true);
assert.equal(promoted.evidence_ready,false);
assert.equal(promoted.verification_authorized,false);
assert.equal(promoted.publication_authorized,false);
assert.equal(promoted.verified,false);
assert.equal(promoted.published,false);
assert.equal(promoted.live_execution_authorized,false);
assert.match(promoted.finalization_hash,/^[a-f0-9]{64}$/);
assert.equal(promoted.provenance.fee.additional_fee_minor,1_500_000);
assert.equal(promoted.provenance.equity.balance_scope,'FULL_TRADER_WALLET_MARK_TO_MARKET');
assert.deepEqual(promoted,promoteAccountingCandidate({candidate,feeSnapshot,valuationSnapshot,equitySnapshot}));

const tampered={...candidate,gross_realized_pnl_minor:candidate.gross_realized_pnl_minor+1};
assert.throws(()=>promoteAccountingCandidate({candidate:tampered,feeSnapshot,valuationSnapshot,equitySnapshot}),/accounting_candidate_pnl_mismatch|accounting_hash_mismatch/);
assert.throws(()=>promoteAccountingCandidate({candidate,valuationSnapshot,equitySnapshot}),/fee_snapshot_required/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot:{...feeSnapshot,source_slot:102},valuationSnapshot,equitySnapshot}),/fee_slot_mismatch/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot:{...feeSnapshot,observed_at:'2026-08-31T00:10:01.000Z'},valuationSnapshot,equitySnapshot}),/fee_time_mismatch/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot:{...feeSnapshot,additional_fee_minor:1_400_000},valuationSnapshot,equitySnapshot}),/fee_breakdown_mismatch/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot:{...feeSnapshot,embedded_swap_fee_handling:'SUBTRACT_AGAIN'},valuationSnapshot,equitySnapshot}),/embedded_swap_fee_handling_required/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot,valuationSnapshot:{...valuationSnapshot,proceeds_minor:129_000_000},equitySnapshot}),/valuation_candidate_mismatch/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot,valuationSnapshot,equitySnapshot:{...equitySnapshot,balance_scope:'PARTIAL_WALLET'}}),/equity_balance_scope_invalid/);
assert.throws(()=>promoteAccountingCandidate({candidate,feeSnapshot:{...feeSnapshot,source_hash:'not-a-hash'},valuationSnapshot,equitySnapshot}),/invalid_fee_source_hash/);

console.log('reconciliation promoter regression: PASS');
