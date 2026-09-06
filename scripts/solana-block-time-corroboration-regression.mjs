import assert from 'node:assert/strict';
import {
  collectSolanaBlockTimeCorroboration,
  verifySolanaBlockTimeCorroboration
} from '../services/api/src/solana-block-time-corroboration.mjs';

// SYNTHETIC / TEST-ONLY. This 64-byte Base58-shaped value is not a production transaction signature.
const syntheticSignature = '1'.repeat(64);
const sourceReference = `solana_rpc:${syntheticSignature}@4990`;

function clockSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const corroborated = await collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: 1788368400,
  rpcCall: async (method, params) => {
    assert.equal(method, 'getBlockTime');
    assert.deepEqual(params, [4990]);
    return 1788368400;
  },
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});

assert.equal(corroborated.collection_status, 'PENDING_DATA');
assert.equal(corroborated.reason, 'block_time_corroborated_reconciliation_required');
assert.equal(corroborated.source_reference, sourceReference);
assert.equal(corroborated.metrics_available, false);
assert.equal(corroborated.trades_count, null);
assert.equal(corroborated.total_return_bps, null);
assert.equal(corroborated.win_rate_bps, null);
assert.equal(corroborated.drawdown_bps, null);
assert.equal(corroborated.reputation_score, null);
assert.equal(corroborated.verified, false);
assert.equal(corroborated.published, false);
assert.equal(corroborated.live_execution_authorized, false);
assert.equal(verifySolanaBlockTimeCorroboration(corroborated), true);

const mismatch = await collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: 1788368399,
  rpcCall: async () => 1788368400,
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(mismatch.reason, 'block_time_mismatch');
assert.equal(mismatch.collection_status, 'PENDING_DATA');
assert.equal(mismatch.verified, false);
assert.equal(mismatch.published, false);
assert.equal(verifySolanaBlockTimeCorroboration(mismatch), true);

const missingExpected = await collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: null,
  rpcCall: async () => 1788368400,
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(missingExpected.reason, 'expected_block_time_required_for_corroboration');
assert.equal(verifySolanaBlockTimeCorroboration(missingExpected), true);

const notFound = await collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: 1788368400,
  rpcCall: async () => null,
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(notFound.reason, 'block_time_not_found');
assert.equal(notFound.source_reference, null);
assert.equal(verifySolanaBlockTimeCorroboration(notFound), true);

await assert.rejects(() => collectSolanaBlockTimeCorroboration({
  sourceReference: `solana_rpc:not-a-real-signature@4990`,
  expectedBlockTime: 1788368400,
  rpcCall: async () => 1788368400
}), /invalid_source_reference|invalid_solana_signature/);

await assert.rejects(() => collectSolanaBlockTimeCorroboration({
  sourceReference: `solana_rpc:${syntheticSignature}@04990`,
  expectedBlockTime: 1788368400,
  rpcCall: async () => 1788368400
}), /invalid_source_reference/);

await assert.rejects(() => collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: 1788368400,
  rpcCall: async () => 1788368400,
  clock: clockSequence('2026-09-02T17:00:00.100Z', '2026-09-02T17:00:00.000Z')
}), /rpc_observed_before_request/);

await assert.rejects(() => collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime: 1788368400,
  rpcCall: async () => 1788372001,
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
}), /rpc_block_time_after_observation/);

const tamperedHash = structuredClone(corroborated);
tamperedHash.provenance.returned_block_time += 1;
assert.equal(verifySolanaBlockTimeCorroboration(tamperedHash), false);

const selfConsistentTamper = structuredClone(corroborated);
selfConsistentTamper.reason = 'block_time_mismatch';
assert.equal(verifySolanaBlockTimeCorroboration(selfConsistentTamper), false);

const publishedTamper = structuredClone(corroborated);
publishedTamper.published = true;
assert.equal(verifySolanaBlockTimeCorroboration(publishedTamper), false);

console.log('solana block-time corroboration regression: ok');
