import assert from 'node:assert/strict';
import {
  buildSolanaCrossSourceEvidence,
  verifySolanaCrossSourceEvidence,
} from '../services/api/src/solana-cross-source-evidence.mjs';

// SYNTHETIC / TEST-ONLY. These identifiers are generated fixtures, not production chain evidence.
const SYNTHETIC_SIGNATURE = '2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2';

const rpc = {
  signature: SYNTHETIC_SIGNATURE,
  slot: 123456789,
  block_time: 1788336000,
  status: 'finalized',
  observed_at: '2026-09-02T08:00:10.000Z',
};

const solscan = {
  signature: SYNTHETIC_SIGNATURE,
  slot: 123456789,
  block_time: 1788336000,
  status: 'Success',
  observed_at: '2026-09-02T08:00:12.000Z',
};

const evidence = buildSolanaCrossSourceEvidence({
  rpc,
  solscan,
  collected_at: '2026-09-02T08:00:15.000Z',
});

assert.equal(evidence.collection_status, 'PENDING_DATA');
assert.equal(evidence.metrics_available, false);
assert.equal(evidence.trades_count, null);
assert.equal(evidence.total_return_bps, null);
assert.equal(evidence.win_rate_bps, null);
assert.equal(evidence.drawdown_bps, null);
assert.equal(evidence.reputation_score, null);
assert.equal(evidence.verified, false);
assert.equal(evidence.published, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(verifySolanaCrossSourceEvidence(evidence), true);
assert.match(evidence.source_hash, /^[0-9a-f]{64}$/);
assert.equal(evidence.source_reference, `SOLANA_CROSS_SOURCE:${SYNTHETIC_SIGNATURE}:123456789`);

const evidenceAgain = buildSolanaCrossSourceEvidence({
  rpc: { ...rpc },
  solscan: { ...solscan },
  collected_at: '2026-09-02T08:00:15.000Z',
});
assert.equal(evidenceAgain.source_hash, evidence.source_hash);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc,
    solscan: { ...solscan, slot: 123456790 },
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_slot_mismatch/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc,
    solscan: { ...solscan, status: 'Fail' },
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_transaction_failed/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc: { ...rpc, status: 'processed' },
    solscan,
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_rpc_not_confirmed/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc,
    solscan: { ...solscan, block_time: 1788336001 },
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_block_time_mismatch/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc: { ...rpc, observed_at: '2026-09-02T07:59:59.999Z' },
    solscan,
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_observed_before_block_time/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc,
    solscan: { ...solscan, observed_at: '2026-09-02T07:59:59.999Z' },
    collected_at: '2026-09-02T08:00:15.000Z',
  }),
  /cross_source_observed_before_block_time/,
);

assert.throws(
  () => buildSolanaCrossSourceEvidence({
    rpc,
    solscan,
    collected_at: '2026-09-02T08:00:11.000Z',
  }),
  /cross_source_collected_before_observation/,
);

assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, source_hash: '0'.repeat(64) }), false);
assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, verified: true }), false);
assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, published: true }), false);
assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, live_execution_authorized: true }), false);
assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, trades_count: 1 }), false);
assert.equal(verifySolanaCrossSourceEvidence({ ...evidence, total_return_bps: 100 }), false);

console.log('solana cross-source evidence regression: PASS');
