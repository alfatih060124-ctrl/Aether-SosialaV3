import assert from 'node:assert/strict';
import {
  assessReconciliationBatchCompleteness,
  verifyReconciliationBatchCompleteness
} from '../services/api/src/reconciliation-batch-completeness.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production signatures, tx hashes, source references, wallets, or trader metrics.
const base = {
  reconciliationBatchId: 'test-batch-0001',
  observedAt: '2026-09-02T15:00:00.000Z'
};

const completeInput = {
  ...base,
  rows: [
    { trade_id: 'synthetic-trade-b', reconciliation_status: 'RECONCILED' },
    { trade_id: 'synthetic-trade-a', reconciliation_status: 'RECONCILED' }
  ]
};

const complete = assessReconciliationBatchCompleteness(completeInput);
assert.equal(complete.collection_status, 'PENDING_DATA');
assert.equal(complete.reconciliation_complete, true);
assert.equal(complete.reason, 'reconciliation_complete_metrics_not_calculated');
assert.equal(complete.metrics_available, false);
assert.equal(complete.trades_count, null);
assert.equal(complete.total_return_bps, null);
assert.equal(complete.win_rate_bps, null);
assert.equal(complete.drawdown_bps, null);
assert.equal(complete.reputation_score, null);
assert.equal(complete.verified, false);
assert.equal(complete.published, false);
assert.equal(complete.live_execution_authorized, false);
assert.equal(complete.source_reference, null);
assert.match(complete.provenance.completeness_hash, /^[0-9a-f]{64}$/);
assert.equal(verifyReconciliationBatchCompleteness(complete, completeInput), true);

const reordered = assessReconciliationBatchCompleteness({
  ...base,
  rows: [...completeInput.rows].reverse()
});
assert.equal(reordered.provenance.completeness_hash, complete.provenance.completeness_hash);

const pending = assessReconciliationBatchCompleteness({
  ...base,
  rows: [
    { trade_id: 'synthetic-trade-a', reconciliation_status: 'RECONCILED' },
    { trade_id: 'synthetic-trade-b', reconciliation_status: 'PENDING' }
  ]
});
assert.equal(pending.collection_status, 'PENDING_DATA');
assert.equal(pending.reconciliation_complete, false);
assert.equal(pending.reason, 'reconciliation_rows_pending');
assert.equal(pending.metrics_available, false);
assert.equal(pending.verified, false);
assert.equal(pending.published, false);

const rejected = assessReconciliationBatchCompleteness({
  ...base,
  rows: [
    { trade_id: 'synthetic-trade-a', reconciliation_status: 'REJECTED' }
  ]
});
assert.equal(rejected.reconciliation_complete, false);
assert.equal(rejected.reason, 'reconciliation_rows_rejected');

assert.throws(() => assessReconciliationBatchCompleteness({
  ...base,
  rows: [
    { trade_id: 'synthetic-trade-a', reconciliation_status: 'RECONCILED' },
    { trade_id: 'synthetic-trade-a', reconciliation_status: 'RECONCILED' }
  ]
}), /duplicate_reconciliation_trade_id/);

assert.throws(() => assessReconciliationBatchCompleteness({
  ...base,
  rows: [{ trade_id: 'synthetic-trade-a', reconciliation_status: 'UNKNOWN' }]
}), /invalid_row_0_status/);

assert.throws(() => assessReconciliationBatchCompleteness({
  ...base,
  observedAt: '2026-09-02T15:00:00Z',
  rows: completeInput.rows
}), /invalid_observed_at/);

const tampered = structuredClone(complete);
tampered.provenance.counts.RECONCILED = 999;
assert.equal(verifyReconciliationBatchCompleteness(tampered, completeInput), false);

console.log('reconciliation batch completeness regression: ok');
