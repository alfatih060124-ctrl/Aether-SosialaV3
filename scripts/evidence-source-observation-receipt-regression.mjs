import assert from 'node:assert/strict';
import {
  buildEvidenceSourceObservationReceipt,
  verifyEvidenceSourceObservationReceipt,
} from '../services/api/src/evidence-source-observation-receipt.mjs';

// SYNTHETIC / TEST-ONLY. This is not production evidence and is never published or verified.
const receipt = buildEvidenceSourceObservationReceipt({
  source_type: 'INTERNAL_RECONCILIATION',
  source_reference: 'TEST_ONLY:reconciliation:batch-001',
  source_hash: 'a'.repeat(64),
  source_origin: 'https://evidence.internal.example',
  request_started_at: '2026-09-02T12:00:00.000Z',
  observed_at: '2026-09-02T12:00:01.000Z',
  collected_at: '2026-09-02T12:00:02.000Z',
  http_status: 200,
});

assert.equal(receipt.collection_status, 'PENDING_DATA');
assert.equal(receipt.metrics_available, false);
assert.equal(receipt.trades_count, null);
assert.equal(receipt.total_return_bps, null);
assert.equal(receipt.win_rate_bps, null);
assert.equal(receipt.drawdown_bps, null);
assert.equal(receipt.reputation_score, null);
assert.equal(receipt.verified, false);
assert.equal(receipt.published, false);
assert.equal(receipt.live_execution_authorized, false);
assert.equal(verifyEvidenceSourceObservationReceipt(receipt), true);
assert.match(receipt.receipt_hash, /^[0-9a-f]{64}$/);

const same = buildEvidenceSourceObservationReceipt({
  source_type: receipt.source_type,
  source_reference: receipt.source_reference,
  source_hash: receipt.source_hash,
  source_origin: receipt.source_origin,
  request_started_at: receipt.request_started_at,
  observed_at: receipt.observed_at,
  collected_at: receipt.collected_at,
  http_status: receipt.http_status,
});
assert.equal(same.receipt_hash, receipt.receipt_hash);

assert.throws(() => buildEvidenceSourceObservationReceipt({
  ...receipt,
  observed_at: '2026-09-02T11:59:59.000Z',
}), /observation_before_request/);

assert.throws(() => buildEvidenceSourceObservationReceipt({
  ...receipt,
  collected_at: '2026-09-02T12:00:00.500Z',
}), /collection_before_observation/);

assert.throws(() => buildEvidenceSourceObservationReceipt({
  ...receipt,
  source_origin: 'https://evidence.internal.example/path?token=secret',
}), /invalid_source_origin/);

assert.throws(() => buildEvidenceSourceObservationReceipt({
  ...receipt,
  source_hash: 'not-a-hash',
}), /invalid_source_hash/);

assert.throws(() => buildEvidenceSourceObservationReceipt({
  ...receipt,
  http_status: 500,
}), /invalid_source_http_status/);

assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, receipt_hash: '0'.repeat(64) }), false);
assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, verified: true }), false);
assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, published: true }), false);
assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, live_execution_authorized: true }), false);
assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, trades_count: 1 }), false);
assert.equal(verifyEvidenceSourceObservationReceipt({ ...receipt, reputation_score: 1 }), false);

console.log('evidence source observation receipt regression: PASS');
