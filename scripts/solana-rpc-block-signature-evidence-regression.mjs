import assert from 'node:assert/strict';
import {
  collectSolanaRpcBlockSignatureEvidence,
  verifySolanaRpcBlockSignatureEvidence,
} from '../services/api/src/solana-rpc-block-signature-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. These are not production signatures, hashes, trades, or evidence.
const SIG = '1'.repeat(64);
const OTHER_SIG = `${'1'.repeat(63)}2`;
const BLOCKHASH = '1'.repeat(32);
const PREVIOUS_BLOCKHASH = `${'1'.repeat(31)}2`;
const REF = `solana_rpc:${SIG}@100`;
const BLOCK_TIME = 1_788_393_600; // 2026-09-03T00:00:00Z, TEST-ONLY.

function clockSequence(...iso) {
  const values = iso.map((v) => new Date(v));
  return () => values.shift();
}

const calls = [];
const rpc = {
  async call(method, params) {
    calls.push({ method, params });
    return { result: {
      blockhash: BLOCKHASH,
      previousBlockhash: PREVIOUS_BLOCKHASH,
      parentSlot: 99,
      blockTime: BLOCK_TIME,
      signatures: [OTHER_SIG, SIG],
    } };
  },
};

const evidence = await collectSolanaRpcBlockSignatureEvidence({
  rpc,
  source_reference: REF,
  rpc_endpoint_label: 'mainnet-readonly-a',
  commitment: 'finalized',
  clock: clockSequence('2026-09-03T00:00:00.000Z', '2026-09-03T00:00:01.000Z'),
});
assert.deepEqual(calls[0], { method: 'getBlock', params: [100, {
  commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0,
}] });
assert.equal(evidence.collection_status, 'PENDING_DATA');
assert.equal(evidence.status_reason, 'block_signature_corroborated_reconciliation_required');
assert.equal(evidence.source_reference, REF);
assert.equal(evidence.signature_found_in_block, true);
assert.equal(evidence.signatures_count, 2);
assert.equal(evidence.metrics_available, false);
assert.equal(evidence.trades_count, null);
assert.equal(evidence.total_return_bps, null);
assert.equal(evidence.win_rate_bps, null);
assert.equal(evidence.drawdown_bps, null);
assert.equal(evidence.reputation_score, null);
assert.equal(evidence.verified, false);
assert.equal(evidence.published, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(verifySolanaRpcBlockSignatureEvidence(evidence), true);

const tampered = structuredClone(evidence);
tampered.block_signatures[1] = OTHER_SIG;
assert.equal(verifySolanaRpcBlockSignatureEvidence(tampered), false);

const absent = await collectSolanaRpcBlockSignatureEvidence({
  rpc: { call: async () => ({ result: {
    blockhash: BLOCKHASH, previousBlockhash: PREVIOUS_BLOCKHASH, parentSlot: 99, blockTime: BLOCK_TIME, signatures: [OTHER_SIG],
  } }) },
  source_reference: REF,
  rpc_endpoint_label: 'mainnet-readonly-a',
  clock: clockSequence('2026-09-03T00:00:00.000Z', '2026-09-03T00:00:01.000Z'),
});
assert.equal(absent.status_reason, 'signature_not_present_in_claimed_slot');
assert.equal(absent.source_reference, null);
assert.equal(absent.verified, false);
assert.equal(absent.published, false);

const missingBlock = await collectSolanaRpcBlockSignatureEvidence({
  rpc: { call: async () => ({ result: null }) }, source_reference: REF, rpc_endpoint_label: 'mainnet-readonly-a',
  clock: clockSequence('2026-09-03T00:00:00.000Z', '2026-09-03T00:00:01.000Z'),
});
assert.equal(missingBlock.status_reason, 'block_not_found');
assert.equal(missingBlock.source_reference, null);
assert.equal(verifySolanaRpcBlockSignatureEvidence(missingBlock), true);

await assert.rejects(collectSolanaRpcBlockSignatureEvidence({
  rpc: { call: async () => { throw new Error('must not be called'); } },
  source_reference: 'solana_rpc:not-a-signature@100', rpc_endpoint_label: 'mainnet-readonly-a',
}), /64-byte Solana Base58 signature/);

await assert.rejects(collectSolanaRpcBlockSignatureEvidence({
  rpc: { call: async () => ({ result: null }) }, source_reference: REF,
  rpc_endpoint_label: 'https://rpc.example/?api-key=TEST_ONLY',
}), /opaque identifier/);

await assert.rejects(collectSolanaRpcBlockSignatureEvidence({
  rpc: { call: async () => ({ result: {
    blockhash: BLOCKHASH, previousBlockhash: PREVIOUS_BLOCKHASH, parentSlot: 100, blockTime: BLOCK_TIME, signatures: [SIG],
  } }) },
  source_reference: REF, rpc_endpoint_label: 'mainnet-readonly-a',
  clock: clockSequence('2026-09-03T00:00:00.000Z', '2026-09-03T00:00:01.000Z'),
}), /parentSlot must precede requested slot/);

console.log('solana rpc block signature evidence regression: ok');
