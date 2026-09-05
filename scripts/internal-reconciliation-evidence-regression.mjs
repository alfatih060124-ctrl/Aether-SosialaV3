import assert from 'node:assert/strict';
import { collectInternalReconciliationEvidence } from '../services/api/src/internal-reconciliation-evidence-source.mjs';

const wallet = '11111111111111111111111111111111';
const signatureA = '1'.repeat(64);
const signatureB = `${'1'.repeat(63)}2`;

// SYNTHETIC / TEST-ONLY fixtures. These are not production trader results.
const recorded = collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-reconciliation-batch-001',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [
    {
      trade_id: 'synthetic-trade-b',
      reconciliation_status: 'RECONCILED',
      executed_at: '2026-08-31T19:20:00.000Z',
      source_signature: signatureB,
      realized_pnl_minor: -1000,
      capital_minor: 10000,
      equity_after_minor: 10500
    },
    {
      trade_id: 'synthetic-trade-a',
      reconciliation_status: 'RECONCILED',
      executed_at: '2026-08-31T19:10:00.000Z',
      source_signature: signatureA,
      realized_pnl_minor: 2000,
      capital_minor: 10000,
      equity_after_minor: 11500
    },
    {
      trade_id: 'ignored-unreconciled',
      reconciliation_status: 'PENDING',
      executed_at: '2026-08-31T19:15:00.000Z',
      source_signature: `${'1'.repeat(62)}23`,
      realized_pnl_minor: 999999,
      capital_minor: 1,
      equity_after_minor: 999999
    }
  ]
});

assert.equal(recorded.evidence_status, 'RECORDED');
assert.equal(recorded.verification_status, 'PENDING_REVIEW');
assert.equal(recorded.verified, false);
assert.equal(recorded.published, false);
assert.equal(recorded.source_type, 'INTERNAL_RECONCILIATION');
assert.equal(recorded.source_reference, 'synthetic-reconciliation-batch-001');
assert.equal(recorded.trades_count, 2);
assert.equal(recorded.total_return_bps, 500);
assert.equal(recorded.win_rate_bps, 5000);
assert.equal(recorded.drawdown_bps, 870);
assert.equal(recorded.provenance.reconciliation_batch_id, 'synthetic-reconciliation-batch-001');
assert.match(recorded.provenance.source_hash, /^[a-f0-9]{64}$/);
assert.match(recorded.provenance.calculation_hash, /^[a-f0-9]{64}$/);

const reversedInput = collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-reconciliation-batch-001',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [
    {
      trade_id: 'synthetic-trade-a',
      reconciliation_status: 'RECONCILED',
      executed_at: '2026-08-31T19:10:00.000Z',
      source_signature: signatureA,
      realized_pnl_minor: 2000,
      capital_minor: 10000,
      equity_after_minor: 11500
    },
    {
      trade_id: 'synthetic-trade-b',
      reconciliation_status: 'RECONCILED',
      executed_at: '2026-08-31T19:20:00.000Z',
      source_signature: signatureB,
      realized_pnl_minor: -1000,
      capital_minor: 10000,
      equity_after_minor: 10500
    }
  ]
});
assert.equal(reversedInput.drawdown_bps, recorded.drawdown_bps);
assert.equal(reversedInput.provenance.source_hash, recorded.provenance.source_hash);
assert.equal(reversedInput.provenance.calculation_hash, recorded.provenance.calculation_hash);

const pending = collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-reconciliation-batch-002',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [{
    trade_id: 'pending-only',
    reconciliation_status: 'PENDING',
    source_signature: signatureA,
    realized_pnl_minor: 1,
    capital_minor: 1,
    equity_after_minor: 1
  }]
});
assert.equal(pending.verification_status, 'PENDING_DATA');
assert.equal(pending.evidence_status, 'NOT_RECORDED');
assert.equal(pending.verified, false);
assert.equal(pending.published, false);
assert.equal(pending.reason, 'no_reconciled_trades');
assert.equal('trades_count' in pending, false);

assert.throws(() => collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-reconciliation-batch-003',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [{
    trade_id: 'missing-economic-data',
    reconciliation_status: 'RECONCILED',
    executed_at: '2026-08-31T19:25:00.000Z',
    source_signature: signatureA,
    realized_pnl_minor: null,
    capital_minor: null,
    equity_after_minor: null
  }]
}), /invalid_trade_0_capital_minor|invalid_trade_0_equity_after_minor/);

assert.throws(() => collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-reconciliation-batch-004',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [{
    trade_id: 'missing-time-order',
    reconciliation_status: 'RECONCILED',
    source_signature: signatureA,
    realized_pnl_minor: 100,
    capital_minor: 10000,
    equity_after_minor: 10100
  }]
}), /invalid_trade_0_executed_at/);

assert.throws(() => collectInternalReconciliationEvidence({
  walletAddress: '1'.repeat(33),
  reconciliationBatchId: 'synthetic-invalid-wallet-bytes',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: []
}), /invalid_wallet_address/);

assert.throws(() => collectInternalReconciliationEvidence({
  walletAddress: wallet,
  reconciliationBatchId: 'synthetic-invalid-signature-bytes',
  observedAt: '2026-08-31T19:30:00.000Z',
  trades: [{
    trade_id: 'synthetic-invalid-signature-trade',
    reconciliation_status: 'RECONCILED',
    executed_at: '2026-08-31T19:25:00.000Z',
    source_signature: '1'.repeat(63),
    realized_pnl_minor: 100,
    capital_minor: 10000,
    equity_after_minor: 10100
  }]
}), /invalid_trade_0_source_signature/);

console.log('internal reconciliation evidence regression: PASS');
