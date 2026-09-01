import assert from 'node:assert/strict';
import { collectSolanaRpcEvidence, buildSolanaRpcProvenance } from '../services/api/src/solana-evidence-source.mjs';

// Synthetic/test-only fixtures. These are not production wallet signatures or trader performance.
const wallet = '11111111111111111111111111111111';
const signature = '5'.repeat(87);
const olderSignature = '6'.repeat(87);
const failedSignature = '7'.repeat(87);
const oldestSignature = '8'.repeat(87);
const calls = [];
const result = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  endpointLabel: 'synthetic-rpc-test-only',
  rpcCall: async (method, params) => {
    calls.push({ method, params });
    return [
      { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' },
      { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
      { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, { Custom: 1, Detail: { b: 2, a: 1 } }] }, confirmationStatus: 'finalized' },
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
assert.equal(result.provenance.schema_version, 3);
assert.equal(result.provenance.pages_fetched, 1);
assert.equal(result.provenance.page_size, 100);
assert.equal(result.provenance.collection_complete, true);
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
    { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, { Detail: { a: 1, b: 2 }, Custom: 1 }] }, confirmationStatus: 'finalized' },
    { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
    { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' }
  ]
});
assert.equal(reordered.source_hash, result.provenance.source_hash);
assert.equal(reordered.newest_signature, signature);
assert.equal(reordered.oldest_signature, failedSignature);

const equivalentDuplicate = buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [
    { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, { Custom: 1, Detail: { b: 2, a: 1 } }] } },
    { signature: failedSignature, slot: 121, blockTime: 1788189980, err: { InstructionError: [0, { Detail: { a: 1, b: 2 }, Custom: 1 }] } }
  ]
});
assert.equal(equivalentDuplicate.signatures_observed, 1);
assert.equal(equivalentDuplicate.failed_signatures_observed, 1);

const paginatedCalls = [];
const paginated = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  endpointLabel: 'synthetic-rpc-test-only',
  limit: 2,
  maxPages: 3,
  rpcCall: async (method, params) => {
    paginatedCalls.push({ method, params });
    const before = params[1].before;
    if (!before) {
      return [
        { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
        { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' }
      ];
    }
    assert.equal(before, olderSignature);
    return [
      { signature: oldestSignature, slot: 120, blockTime: 1788189970, err: null, confirmationStatus: 'finalized' }
    ];
  }
});
assert.equal(paginatedCalls.length, 2);
assert.deepEqual(paginatedCalls[0].params[1], { limit: 2 });
assert.deepEqual(paginatedCalls[1].params[1], { limit: 2, before: olderSignature });
assert.equal(paginated.provenance.pages_fetched, 2);
assert.equal(paginated.provenance.page_size, 2);
assert.equal(paginated.provenance.collection_complete, true);
assert.equal(paginated.provenance.signatures_observed, 3);
assert.equal(paginated.provenance.oldest_signature, oldestSignature);
assert.equal(paginated.verification_status, 'PENDING_DATA');
assert.equal(paginated.verified, false);
assert.equal(paginated.published, false);

const capped = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  limit: 2,
  maxPages: 1,
  rpcCall: async () => [
    { signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'finalized' },
    { signature: olderSignature, slot: 122, blockTime: 1788189990, err: null, confirmationStatus: 'finalized' }
  ]
});
assert.equal(capped.provenance.pages_fetched, 1);
assert.equal(capped.provenance.collection_complete, false);
assert.equal(capped.verification_status, 'PENDING_DATA');
assert.equal(capped.verified, false);
assert.equal(capped.published, false);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [
    { signature, slot: 123, blockTime: 1788190000, err: null },
    { signature, slot: 124, blockTime: 1788190001, err: null }
  ]
}), /conflicting_duplicate_signature/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [{ signature: 'not-a-solana-signature', slot: 125, blockTime: 1788190002, err: null }]
}), /invalid_rpc_signature/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [{ signature: '1'.repeat(32), slot: 125, blockTime: 1788190002, err: null }]
}), /invalid_rpc_signature/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [{ signature, slot: '123', blockTime: 1788190000, err: null }]
}), /invalid_rpc_slot/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [{ signature, slot: 123, blockTime: -1, err: null }]
}), /invalid_rpc_block_time/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  signatures: [{ signature, slot: 123, blockTime: 1788190000, err: null, confirmationStatus: 'mystery' }]
}), /invalid_rpc_confirmation_status/);

await assert.rejects(
  collectSolanaRpcEvidence({
    walletAddress: wallet,
    rpcCall: async () => [{ signature: '', slot: 126, blockTime: 1788190003, err: null }]
  }),
  /invalid_rpc_signature/
);

await assert.rejects(
  collectSolanaRpcEvidence({
    walletAddress: wallet,
    rpcCall: async () => [{ signature, slot: null, blockTime: 1788190003, err: null }]
  }),
  /invalid_rpc_slot/
);

const empty = await collectSolanaRpcEvidence({ walletAddress: wallet, rpcCall: async () => [] });
assert.equal(empty.reason, 'no_verifiable_chain_activity');
assert.equal(empty.source_reference, null);
assert.equal(empty.provenance.collection_complete, true);
assert.throws(() => buildSolanaRpcProvenance({ walletAddress: 'bad', signatures: [] }), /invalid_solana_wallet/);
assert.throws(() => buildSolanaRpcProvenance({ walletAddress: '2'.repeat(32), signatures: [] }), /invalid_solana_wallet/);
console.log('solana evidence source regression: PASS');
