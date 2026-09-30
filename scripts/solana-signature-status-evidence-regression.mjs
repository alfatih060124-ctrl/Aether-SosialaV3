import assert from 'node:assert/strict';
import {
  collectSolanaSignatureStatusEvidence,
  verifySolanaSignatureStatusEvidence
} from '../services/api/src/solana-signature-status-evidence-source.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These are not production signatures, tx hashes, trades, or trader metrics.
const syntheticSignature = '1'.repeat(64);

function clockSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const finalizedResponse = {
  context: { slot: 5000 },
  value: [{
    slot: 4990,
    confirmations: null,
    err: null,
    status: { Ok: null },
    confirmationStatus: 'finalized'
  }]
};

const collected = await collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async (method, params) => {
    assert.equal(method, 'getSignatureStatuses');
    assert.deepEqual(params, [[syntheticSignature], { searchTransactionHistory: true }]);
    return finalizedResponse;
  },
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});

assert.equal(collected.collection_status, 'PENDING_DATA');
assert.equal(collected.reason, 'reconciliation_required_for_performance');
assert.equal(collected.source_reference, `solana_rpc:${syntheticSignature}@4990`);
assert.equal(collected.metrics_available, false);
assert.equal(collected.trades_count, null);
assert.equal(collected.total_return_bps, null);
assert.equal(collected.win_rate_bps, null);
assert.equal(collected.drawdown_bps, null);
assert.equal(collected.reputation_score, null);
assert.equal(collected.verified, false);
assert.equal(collected.published, false);
assert.equal(collected.live_execution_authorized, false);
assert.equal(verifySolanaSignatureStatusEvidence(collected), true);

const notFound = await collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async () => ({ context: { slot: 5000 }, value: [null] }),
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(notFound.reason, 'signature_status_not_found');
assert.equal(notFound.source_reference, null);
assert.equal(verifySolanaSignatureStatusEvidence(notFound), true);

const belowRequired = await collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  minimumConfirmationStatus: 'finalized',
  rpcCall: async () => ({
    context: { slot: 5000 },
    value: [{ ...finalizedResponse.value[0], confirmations: 2, confirmationStatus: 'confirmed' }]
  }),
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(belowRequired.reason, 'confirmation_below_required');
assert.equal(belowRequired.collection_status, 'PENDING_DATA');
assert.equal(verifySolanaSignatureStatusEvidence(belowRequired), true);

const failed = await collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async () => ({
    context: { slot: 5000 },
    value: [{
      ...finalizedResponse.value[0],
      err: { InstructionError: [0, 'SyntheticFailure'] },
      status: { Err: { InstructionError: [0, 'SyntheticFailure'] } }
    }]
  }),
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
});
assert.equal(failed.reason, 'failed_transaction_not_performance_evidence');
assert.equal(failed.verified, false);
assert.equal(failed.published, false);
assert.equal(verifySolanaSignatureStatusEvidence(failed), true);

await assert.rejects(() => collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async () => ({ context: { slot: 4000 }, value: [{ ...finalizedResponse.value[0], slot: 4990 }] }),
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
}), /rpc_status_slot_after_context/);

await assert.rejects(() => collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async () => ({ context: { slot: 5000 }, value: [finalizedResponse.value[0], null] }),
  clock: clockSequence('2026-09-02T17:00:00.000Z', '2026-09-02T17:00:00.100Z')
}), /invalid_signature_status_value/);

await assert.rejects(() => collectSolanaSignatureStatusEvidence({
  signature: syntheticSignature,
  rpcCall: async () => finalizedResponse,
  clock: clockSequence('2026-09-02T17:00:00.100Z', '2026-09-02T17:00:00.000Z')
}), /rpc_observed_before_request/);

const tampered = structuredClone(collected);
tampered.provenance.status.confirmation_status = 'confirmed';
assert.equal(verifySolanaSignatureStatusEvidence(tampered), false);

const selfConsistentReasonTamper = structuredClone(collected);
selfConsistentReasonTamper.reason = 'confirmation_below_required';
assert.equal(verifySolanaSignatureStatusEvidence(selfConsistentReasonTamper), false);

console.log('solana signature status evidence regression: ok');
