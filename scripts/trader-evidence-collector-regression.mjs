import assert from 'node:assert/strict';
import { buildRecordedEvidence, calculateReconciledMetrics, normalizeEvidenceReference, pendingData } from '../services/api/src/trader-evidence-collector.mjs';

// SYNTHETIC TEST-ONLY fixture. These values must never be presented as trader performance.
const trades = [
  { trade_id: 'synthetic-1', realized_pnl_minor: 100, capital_minor: 1000, equity_after_minor: 1100 },
  { trade_id: 'synthetic-2', realized_pnl_minor: -50, capital_minor: 1000, equity_after_minor: 1050 },
  { trade_id: 'synthetic-3', realized_pnl_minor: 150, capital_minor: 1000, equity_after_minor: 1200 }
];

const metrics = calculateReconciledMetrics(trades);
assert.deepEqual(metrics, { trades_count: 3, total_return_bps: 667, win_rate_bps: 6667, drawdown_bps: 455 });

assert.throws(() => calculateReconciledMetrics([]), /insufficient_reconciled_trades/);
assert.throws(() => normalizeEvidenceReference({ sourceType: 'SOLANA_RPC', reference: 'not-a-signature' }), /invalid_solana_signature/);
assert.deepEqual(pendingData(), {
  verification_status: 'PENDING_DATA', verified: false, published: false, evidence_status: 'NOT_RECORDED', reason: 'insufficient_verifiable_data'
});

const evidence = buildRecordedEvidence({
  sourceType: 'INTERNAL_RECONCILIATION',
  reference: 'recon:test-only:batch-001',
  observedAt: '2026-08-31T00:00:00.000Z',
  trades,
  provenance: { reconciliation_batch_id: 'test-only-batch-001' }
});
assert.equal(evidence.evidence_status, 'RECORDED');
assert.equal(evidence.provenance.collector, 'AETHER_TRADER_EVIDENCE');
assert.match(evidence.provenance.calculation_hash, /^[a-f0-9]{64}$/);
assert.equal('reputation_score' in evidence, false, 'collector must not invent reputation');
assert.equal('verified' in evidence, false, 'recording evidence must not verify trader');
assert.equal('published' in evidence, false, 'recording evidence must not publish trader');

console.log('trader evidence collector regression: PASS');
