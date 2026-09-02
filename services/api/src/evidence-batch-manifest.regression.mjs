// SYNTHETIC / TEST-ONLY regression. No production signatures, tx hashes, wallets, or trader metrics.
import assert from 'node:assert/strict';
import { buildEvidenceBatchManifest, verifyEvidenceBatchManifest } from './evidence-batch-manifest.mjs';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const collectedAt = '2026-01-01T00:05:00.000Z';

const a = {
  source_type: 'INTERNAL_RECONCILIATION',
  source_reference: 'test-only:reconciliation:trade-001',
  source_hash: H1,
  observed_at: '2026-01-01T00:01:00.000Z',
};
const b = {
  source_type: 'INTERNAL_RECONCILIATION',
  source_reference: 'test-only:reconciliation:trade-002',
  source_hash: H2,
  observed_at: '2026-01-01T00:02:00.000Z',
};

const first = buildEvidenceBatchManifest([b, a], { collected_at: collectedAt });
const second = buildEvidenceBatchManifest([a, b], { collected_at: collectedAt });

assert.equal(first.manifest_hash, second.manifest_hash, 'input ordering must not change manifest hash');
assert.equal(first.evidence_count, 2);
assert.equal(first.collection_status, 'PENDING_DATA');
assert.equal(first.metrics_available, false);
assert.equal(first.trades_count, null);
assert.equal(first.total_return_bps, null);
assert.equal(first.win_rate_bps, null);
assert.equal(first.drawdown_bps, null);
assert.equal(first.reputation_score, null);
assert.equal(first.verified, false);
assert.equal(first.published, false);
assert.equal(first.live_execution_authorized, false);
assert.equal(verifyEvidenceBatchManifest(first), true);

const changedHash = buildEvidenceBatchManifest([{ ...a, source_hash: '3'.repeat(64) }, b], { collected_at: collectedAt });
assert.notEqual(changedHash.manifest_hash, first.manifest_hash, 'source hash must be manifest-bound');

const changedTime = buildEvidenceBatchManifest([a, b], { collected_at: '2026-01-01T00:05:01.000Z' });
assert.notEqual(changedTime.manifest_hash, first.manifest_hash, 'collection time must be manifest-bound');

const validSignature = '1'.repeat(64);
const rpc = {
  ...a,
  source_type: 'SOLANA_RPC',
  source_reference: `solana_rpc:${validSignature}@123`,
};
assert.equal(buildEvidenceBatchManifest([rpc], { collected_at: collectedAt }).evidence_count, 1);

for (const source_reference of [
  'not-a-signature',
  'solana_rpc:not-a-signature@123',
  `solana_rpc:${'1'.repeat(63)}@123`,
  `solana_rpc:${'0'.repeat(64)}@123`,
  `solana_rpc:${validSignature}@01`,
  `solana_rpc:${validSignature}@9007199254740992`,
]) {
  assert.throws(
    () => buildEvidenceBatchManifest([{ ...rpc, source_reference }], { collected_at: collectedAt }),
    (error) => error?.code === 'invalid_evidence_source_reference',
  );
}
assert.throws(
  () => buildEvidenceBatchManifest([{ ...rpc, source_type: 'SOLSCAN' }], { collected_at: collectedAt }),
  (error) => error?.code === 'invalid_evidence_source_reference',
);

assert.throws(
  () => buildEvidenceBatchManifest([a, a], { collected_at: collectedAt }),
  (error) => error?.code === 'duplicate_evidence_source_reference',
);
assert.throws(
  () => buildEvidenceBatchManifest([], { collected_at: collectedAt }),
  (error) => error?.code === 'evidence_batch_empty',
);
assert.throws(
  () => buildEvidenceBatchManifest([{ ...a, source_hash: 'not-a-hash' }], { collected_at: collectedAt }),
  (error) => error?.code === 'invalid_evidence_source_hash',
);
assert.throws(
  () => buildEvidenceBatchManifest([a], { collected_at: '2026-01-01T00:05:00Z' }),
  (error) => error?.code === 'noncanonical_evidence_observed_at',
);

assert.throws(
  () => verifyEvidenceBatchManifest({ ...first, manifest_hash: '0'.repeat(64) }),
  (error) => error?.code === 'evidence_manifest_hash_mismatch',
);
assert.throws(
  () => verifyEvidenceBatchManifest({ ...first, verified: true }),
  (error) => error?.code === 'evidence_manifest_boundary_violation',
);
assert.throws(
  () => verifyEvidenceBatchManifest({ ...first, trades_count: 2 }),
  (error) => error?.code === 'evidence_manifest_metric_fabrication',
);

console.log('evidence batch manifest regression: PASS');
