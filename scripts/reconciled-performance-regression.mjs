import assert from 'node:assert/strict';
import { buildReconciledLedgerRecord, calculateDeterministicReputation, MIN_REPUTATION_TRADES } from '../services/api/src/reconciled-performance-service.mjs';
import { collectInternalReconciliationEvidence } from '../services/api/src/internal-reconciliation-evidence-source.mjs';

const wallet = '1'.repeat(32);
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const signature = i => '1'.repeat(63) + alphabet[i % alphabet.length];

// SYNTHETIC TEST-ONLY fixture: validates the contract, not real trader performance.
const event = {
  event_id: 'fixture_chain_event_1',
  chain: 'SOLANA',
  trader_wallet: wallet,
  tx_hash: signature(0),
  slot: 123456,
  confidence: '0.9900',
  observed_at: '2026-08-31T00:00:00.000Z',
  decoder_version: 'fixture-decoder-v1'
};
const record = buildReconciledLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001',
  walletAddress: wallet,
  event,
  input: {
    realized_pnl_minor: 2500,
    capital_minor: 100000,
    equity_after_minor: 102500,
    accounting_method: 'FIFO_COST_BASIS_V1',
    valuation_reference: 'fixture-valuation-snapshot-1'
  }
});
assert.equal(record.reconciliation_status, 'RECONCILED');
assert.equal(record.source_signature, event.tx_hash);
assert.match(record.source_hash, /^[a-f0-9]{64}$/);
assert.equal(record.provenance.accounting_method, 'FIFO_COST_BASIS_V1');
assert.equal(record.live_execution_authorized, undefined);

assert.throws(() => buildReconciledLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001', walletAddress: wallet,
  event: {...event,event_id:'shadow_event_1'}, input: {
    realized_pnl_minor:1,capital_minor:100,equity_after_minor:101,
    accounting_method:'FIFO_COST_BASIS_V1',valuation_reference:'fixture-valuation-2'
  }
}), /synthetic_trade_event_blocked/);

assert.throws(() => buildReconciledLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001', walletAddress: wallet,
  event: {...event,event_id:'low_confidence_event',confidence:'0.50'}, input: {
    realized_pnl_minor:1,capital_minor:100,equity_after_minor:101,
    accounting_method:'FIFO_COST_BASIS_V1',valuation_reference:'fixture-valuation-3'
  }
}), /reconciliation_event_confidence_too_low/);

const tooSmall = calculateDeterministicReputation({
  trades_count: MIN_REPUTATION_TRADES - 1,
  total_return_bps: 500,
  win_rate_bps: 6000,
  drawdown_bps: 900
});
assert.equal(tooSmall.available, false);
assert.equal(tooSmall.reason, 'insufficient_reconciled_trade_sample');

const enough = calculateDeterministicReputation({
  trades_count: MIN_REPUTATION_TRADES,
  total_return_bps: 500,
  win_rate_bps: 6000,
  drawdown_bps: 900
});
assert.equal(enough.available, true);
assert.equal(enough.formula_version, 'AETHER_REPUTATION_V1');
assert.ok(enough.score >= 0 && enough.score <= 100);
assert.deepEqual(enough, calculateDeterministicReputation({
  trades_count: MIN_REPUTATION_TRADES,
  total_return_bps: 500,
  win_rate_bps: 6000,
  drawdown_bps: 900
}));

let equity = 1_000_000;
const trades = Array.from({length:MIN_REPUTATION_TRADES},(_,i)=>{
  const pnl = i % 4 === 0 ? -2500 : 5000;
  equity += pnl;
  return {
    trade_id:`fixture-trade-${String(i).padStart(2,'0')}`,
    executed_at:new Date(Date.UTC(2026,7,1,0,i,0)).toISOString(),
    realized_pnl_minor:pnl,
    capital_minor:100000,
    equity_after_minor:equity,
    source_signature:signature(i+1),
    reconciliation_status:'RECONCILED'
  };
});
const evidence = collectInternalReconciliationEvidence({
  walletAddress:wallet,
  reconciliationBatchId:'fixture-reconciliation-batch-0001',
  observedAt:'2026-08-31T00:00:00.000Z',
  trades
});
assert.equal(evidence.evidence_status,'RECORDED');
assert.equal(evidence.verification_status,'PENDING_REVIEW');
assert.equal(evidence.verified,false);
assert.equal(evidence.published,false);
assert.equal(evidence.trades_count,MIN_REPUTATION_TRADES);
assert.match(evidence.provenance.calculation_hash,/^[a-f0-9]{64}$/);
assert.match(evidence.provenance.source_hash,/^[a-f0-9]{64}$/);

const reputation = calculateDeterministicReputation(evidence);
assert.equal(reputation.available,true);
assert.ok(reputation.score >= 0 && reputation.score <= 100);

console.log('reconciled performance regression: PASS');
