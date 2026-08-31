import assert from 'node:assert/strict';
import { collectSolanaRpcEvidence, buildSolanaRpcProvenance } from '../services/api/src/solana-evidence-source.mjs';

const wallet = '11111111111111111111111111111111';
const signature = '5'.repeat(64);
const olderSignature = '6'.repeat(64);
const failedSignature = '7'.repeat(64);
const calls = [];
const result = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  endpointLabel: 'synthetic-rpc-test-only',
  rpcCall: async (method, params) => {
    calls.push({ method, params });
    return [
      { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' },
      { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
      { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
      { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' }
    ];
  }
});
assert.equal(calls[0].method, 'getSignaturesForAddress');
assert.equal(result.verification_status, 'PENDING_DATA');
assert.equal(result.verified, false);
assert.equal(result.published, false);
assert.equal(result.evidence_status, 'NOT_RECORDED');
assert.equal(result.reason, 'reconciled_trade_performance_required');
assert.equal(result.source_reference, signature);
assert.equal(result.provenance.schema_version, 2);
assert.equal(result.provenance.signatures_observed, 3);
assert.equal(result.provenance.successful_signatures_observed, 2);
assert.equal(result.provenance.failed_signatures_observed, 1);
assert.equal(result.provenance.newest_signature, signature);
assert.equal(result.provenance.oldest_signature, failedSignature);
assert.equal('trades_count' in result, false);
assert.equal('total_return_bps' in result, false);
assert.equal('win_rate_bps' in result, false);
assert.equal('drawdown_bps' in result, false);
assert.equal('reputation_score' in result, false);
assert.match(result.provenance.source_hash, /^[a-f0-9]{64}$/);

const reordered = buildSolanaRpcProvenance({
  walletAddress: wallet,
  endpointLabel: 'synthetic-rpc-test-only',
  signatures: [
    { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
    { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
    { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' }
  ]
});
assert.equal(reordered.source_hash, result.provenance.source_hash);
assert.equal(reordered.newest_signature, signature);
assert.equal(reordered.oldest_signature, failedSignature);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [
    { signature, slot: 123, blockTime: 1788190000, err: null },
    { signature, slot: 124, blockTime: 1788190001, err: null }
  ]
}), /conflicting_duplicate_signature/);

const empty = await collectSolanaRpcEvidence({ walletAddress: wallet, rpcCall: async () => [] });
assert.equal(empty.reason, 'no_verifiable_chain_activity');
assert.equal(empty.source_reference, null);
assert.throws(() => buildSolanaRpcProvenance({ walletAddress: 'bad', signatures: [] }), /invalid_solana_wallet/);
console.log('solana evidence source regression: PASS');
