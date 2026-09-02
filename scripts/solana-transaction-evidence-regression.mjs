import assert from 'node:assert/strict';
import {
  collectSolanaTransactionEvidence,
  verifySolanaTransactionEvidence
} from '../services/api/src/solana-transaction-evidence-source.mjs';

// SYNTHETIC / TEST-ONLY fixtures only. These are not production signatures, tx hashes, wallets, or trader metrics.
const syntheticSignature = '1'.repeat(64);
const alternateSignature = '3'.repeat(88);
const syntheticWallet = '1'.repeat(32);
const otherWallet = '2'.repeat(44);

function clockSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const response = {
  slot: 123456,
  blockTime: 1788360000,
  meta: { fee: 5000, err: null },
  transaction: {
    signatures: [syntheticSignature],
    message: { accountKeys: [syntheticWallet, otherWallet] }
  }
};

const collected = await collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async (method, params) => {
    assert.equal(method, 'getTransaction');
    assert.equal(params[0], syntheticSignature);
    assert.deepEqual(params[1], {
      commitment: 'finalized',
      encoding: 'json',
      maxSupportedTransactionVersion: 0
    });
    return response;
  },
  clock: clockSequence('2026-09-02T16:00:00.000Z', '2026-09-02T16:00:00.100Z')
});

assert.equal(collected.collection_status, 'PENDING_DATA');
assert.equal(collected.reason, 'reconciliation_required_for_performance');
assert.equal(collected.source_type, 'SOLANA_RPC');
assert.equal(collected.source_reference, `solana_rpc:${syntheticSignature}@123456`);
assert.equal(collected.metrics_available, false);
assert.equal(collected.trades_count, null);
assert.equal(collected.total_return_bps, null);
assert.equal(collected.win_rate_bps, null);
assert.equal(collected.drawdown_bps, null);
assert.equal(collected.reputation_score, null);
assert.equal(collected.verified, false);
assert.equal(collected.published, false);
assert.equal(collected.live_execution_authorized, false);
assert.match(collected.provenance.source_hash, /^[0-9a-f]{64}$/);
assert.equal(verifySolanaTransactionEvidence(collected), true);

const notFound = await collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async () => null,
  clock: clockSequence('2026-09-02T16:00:00.000Z', '2026-09-02T16:00:00.100Z')
});
assert.equal(notFound.collection_status, 'PENDING_DATA');
assert.equal(notFound.reason, 'transaction_not_found_at_requested_commitment');
assert.equal(notFound.source_reference, null);
assert.equal(notFound.provenance.transaction_found, false);
assert.equal(verifySolanaTransactionEvidence(notFound), true);

const failed = await collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async () => ({ ...response, meta: { fee: 5000, err: { InstructionError: [0, 'SyntheticFailure'] } } }),
  clock: clockSequence('2026-09-02T16:00:00.000Z', '2026-09-02T16:00:00.100Z')
});
assert.equal(failed.reason, 'failed_transaction_not_performance_evidence');
assert.equal(failed.verified, false);
assert.equal(failed.published, false);

await assert.rejects(() => collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async () => ({ ...response, transaction: { ...response.transaction, signatures: [alternateSignature] } }),
  clock: clockSequence('2026-09-02T16:00:00.000Z', '2026-09-02T16:00:00.100Z')
}), /rpc_transaction_signature_mismatch/);

await assert.rejects(() => collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async () => ({ ...response, transaction: { ...response.transaction, message: { accountKeys: [otherWallet] } } }),
  clock: clockSequence('2026-09-02T16:00:00.000Z', '2026-09-02T16:00:00.100Z')
}), /rpc_transaction_wallet_not_participant/);

await assert.rejects(() => collectSolanaTransactionEvidence({
  signature: syntheticSignature,
  walletAddress: syntheticWallet,
  rpcCall: async () => response,
  clock: clockSequence('2026-09-02T16:00:00.100Z', '2026-09-02T16:00:00.000Z')
}), /rpc_observed_before_request/);

const tampered = structuredClone(collected);
tampered.provenance.transaction.fee_lamports = 9999;
assert.equal(verifySolanaTransactionEvidence(tampered), false);

console.log('solana transaction evidence regression: ok');
