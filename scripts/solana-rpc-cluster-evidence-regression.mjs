import assert from 'node:assert/strict';
import {
  buildSolanaRpcClusterEvidence,
  collectSolanaRpcClusterEvidence,
  verifySolanaRpcClusterEvidence,
} from '../services/api/src/solana-rpc-cluster-evidence.mjs';

// SYNTHETIC / TEST-ONLY 32-byte Base58 genesis hashes. They are not production source references.
const EXPECTED = '11111111111111111111111111111111';
const OTHER = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const times = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:01.000Z')];

const rpc = {
  async call(method, params) {
    assert.equal(method, 'getGenesisHash');
    assert.deepEqual(params, []);
    return { jsonrpc: '2.0', result: EXPECTED, id: 1 };
  },
};

let i = 0;
const evidence = await collectSolanaRpcClusterEvidence({
  rpc,
  expected_genesis_hash: EXPECTED,
  rpc_endpoint_label: 'synthetic-rpc',
  clock: () => times[i++],
});
assert.equal(evidence.cluster_identity_match, true);
assert.equal(evidence.collection_status, 'PENDING_DATA');
assert.equal(evidence.source_reference, null);
assert.equal(evidence.metrics_available, false);
assert.equal(evidence.verified, false);
assert.equal(evidence.published, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(verifySolanaRpcClusterEvidence(evidence), true);

const mismatch = buildSolanaRpcClusterEvidence({
  expected_genesis_hash: EXPECTED,
  returned_genesis_hash: OTHER,
  rpc_endpoint_label: 'synthetic-rpc',
  request_started_at: '2026-01-01T00:00:00.000Z',
  observed_at: '2026-01-01T00:00:01.000Z',
});
assert.equal(mismatch.cluster_identity_match, false);
assert.equal(mismatch.status_reason, 'cluster_identity_mismatch');
assert.equal(mismatch.collection_status, 'PENDING_DATA');
assert.equal(mismatch.trades_count, null);
assert.equal(mismatch.total_return_bps, null);
assert.equal(mismatch.win_rate_bps, null);
assert.equal(mismatch.drawdown_bps, null);
assert.equal(mismatch.reputation_score, null);
assert.equal(verifySolanaRpcClusterEvidence(mismatch), true);

for (const malformedGenesisHash of [
  '22222222222222222222222222222222',
  '1111111111111111111111111111111',
  '0'.repeat(32),
]) {
  assert.throws(() => buildSolanaRpcClusterEvidence({
    expected_genesis_hash: malformedGenesisHash,
    returned_genesis_hash: EXPECTED,
    rpc_endpoint_label: 'synthetic-rpc',
    request_started_at: '2026-01-01T00:00:00.000Z',
    observed_at: '2026-01-01T00:00:01.000Z',
  }), /32-byte Base58 hash/);
}

assert.throws(() => buildSolanaRpcClusterEvidence({
  expected_genesis_hash: EXPECTED,
  returned_genesis_hash: EXPECTED,
  rpc_endpoint_label: 'https://rpc.example/?token=TEST_ONLY',
  request_started_at: '2026-01-01T00:00:00.000Z',
  observed_at: '2026-01-01T00:00:01.000Z',
}), /opaque identifier/);

assert.throws(() => buildSolanaRpcClusterEvidence({
  expected_genesis_hash: EXPECTED,
  returned_genesis_hash: EXPECTED,
  rpc_endpoint_label: 'synthetic-rpc',
  request_started_at: '2026-01-01T00:00:02.000Z',
  observed_at: '2026-01-01T00:00:01.000Z',
}), /cannot precede/);

assert.equal(verifySolanaRpcClusterEvidence({ ...evidence, verified: true }), false);
assert.equal(verifySolanaRpcClusterEvidence({ ...evidence, returned_genesis_hash: OTHER }), false);
assert.equal(verifySolanaRpcClusterEvidence({ ...evidence, returned_genesis_hash: '22222222222222222222222222222222' }), false);

console.log('Solana RPC cluster identity evidence regression passed');
