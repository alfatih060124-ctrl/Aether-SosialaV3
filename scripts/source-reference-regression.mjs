import assert from 'node:assert/strict';
import { canonicalEvidenceSourceReference, pendingEvidenceBoundary } from '../packages/data-evidence/source-reference.mjs';

console.log('SYNTHETIC / TEST-ONLY source reference regression');

const rpc = { source_type: 'SOLANA_RPC', signature: 'synthetic_signature_test_only', slot: 123 };
assert.equal(canonicalEvidenceSourceReference(rpc), 'solana_rpc:synthetic_signature_test_only@123');

const pending = pendingEvidenceBoundary(rpc);
assert.equal(pending.collection_status, 'PENDING_DATA');
assert.equal(pending.metrics_available, false);
assert.equal(pending.trades_count, null);
assert.equal(pending.total_return_bps, null);
assert.equal(pending.win_rate_bps, null);
assert.equal(pending.drawdown_bps, null);
assert.equal(pending.reputation_score, null);
assert.equal(pending.verified, false);
assert.equal(pending.published, false);
assert.equal(pending.live_execution_authorized, false);

assert.equal(
  canonicalEvidenceSourceReference({ source_type: 'INTERNAL_RECONCILIATION', reconciliation_id: 'test-only/id' }),
  'internal-reconciliation:test-only%2Fid'
);

for (const bad of [
  null,
  {},
  { source_type: 'UNKNOWN', signature: 'x', slot: 1 },
  { source_type: 'SOLANA_RPC', signature: '', slot: 1 },
  { source_type: 'SOLANA_RPC', signature: ' x ', slot: 1 },
  { source_type: 'SOLSCAN', signature: 'x', slot: Number.MAX_SAFE_INTEGER + 1 },
  { source_type: 'INTERNAL_RECONCILIATION', reconciliation_id: '' },
]) {
  assert.throws(() => canonicalEvidenceSourceReference(bad));
}

console.log('source reference regression: PASS');
