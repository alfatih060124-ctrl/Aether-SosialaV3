import assert from 'node:assert/strict';
import {
  collectSolanaTransactionSignerEvidence,
  verifySolanaTransactionSignerEvidence,
} from '../services/api/src/solana-transaction-signer-evidence.mjs';

const SIGNATURE = '1'.repeat(64); // SYNTHETIC / TEST-ONLY: 64 zero bytes.
const TRADER = '1'.repeat(32); // SYNTHETIC / TEST-ONLY: 32 zero bytes.
const OTHER = `${'1'.repeat(31)}2`; // SYNTHETIC / TEST-ONLY: distinct 32-byte key.
const STARTED = '2026-01-01T00:00:01.000Z';
const OBSERVED = '2026-01-01T00:00:05.000Z';

function response(result) {
  return async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, result }; } });
}

function txResult({ traderSigner = true, duplicate = false, blockTime = 1767225602 } = {}) {
  const accountKeys = [
    { pubkey: TRADER, signer: traderSigner, writable: true },
    { pubkey: OTHER, signer: !traderSigner, writable: false },
  ];
  if (duplicate) accountKeys.push({ pubkey: TRADER, signer: false, writable: false });
  return {
    slot: 123,
    blockTime,
    transaction: {
      signatures: [SIGNATURE],
      message: { accountKeys, instructions: [] },
    },
  };
}

const common = {
  rpc_url: 'https://rpc.test.invalid',
  rpc_endpoint_label: 'synthetic_rpc',
  signature: SIGNATURE,
  trader_wallet: TRADER,
  request_started_at: STARTED,
  observed_at: OBSERVED,
};

const signed = await collectSolanaTransactionSignerEvidence({ ...common, fetch_fn: response(txResult()) });
assert.equal(signed.collection_status, 'PENDING_DATA');
assert.equal(signed.metrics_available, false);
assert.equal(signed.verified, false);
assert.equal(signed.published, false);
assert.equal(signed.live_execution_authorized, false);
assert.equal(signed.trades_count, null);
assert.equal(signed.total_return_bps, null);
assert.equal(signed.win_rate_bps, null);
assert.equal(signed.drawdown_bps, null);
assert.equal(signed.reputation_score, null);
assert.equal(signed.trader_signed, true);
assert.equal(signed.source_reference, `solana_rpc:${SIGNATURE}@123`);
assert.deepEqual(signed.signer_keys, [TRADER]);
assert.deepEqual(signed.provenance.account_keys, [TRADER, OTHER]);
assert.equal(signed.reconciliation_required, true);
assert.equal(verifySolanaTransactionSignerEvidence(signed), true);

const notSigner = await collectSolanaTransactionSignerEvidence({ ...common, fetch_fn: response(txResult({ traderSigner: false })) });
assert.equal(notSigner.collection_status, 'PENDING_DATA');
assert.equal(notSigner.trader_signed, false);
assert.equal(notSigner.source_reference, null);
assert.deepEqual(notSigner.signer_keys, [OTHER]);
assert.deepEqual(notSigner.provenance.account_keys, [TRADER, OTHER]);
assert.equal(verifySolanaTransactionSignerEvidence(notSigner), true);

const notFound = await collectSolanaTransactionSignerEvidence({ ...common, fetch_fn: response(null) });
assert.equal(notFound.collection_status, 'PENDING_DATA');
assert.equal(notFound.trader_signed, false);
assert.equal(notFound.source_reference, null);
assert.deepEqual(notFound.signer_keys, []);
assert.deepEqual(notFound.provenance.account_keys, []);
assert.equal(verifySolanaTransactionSignerEvidence(notFound), true);

const tampered = structuredClone(signed);
tampered.provenance.trader_signed = false;
tampered.provenance.source_reference = null;
tampered.source_reference = null;
assert.equal(verifySolanaTransactionSignerEvidence(tampered), false);

const signerTampered = structuredClone(signed);
signerTampered.provenance.signer_keys = [OTHER];
signerTampered.signer_keys = [OTHER];
assert.equal(verifySolanaTransactionSignerEvidence(signerTampered), false);

const participantTampered = structuredClone(notSigner);
participantTampered.provenance.account_keys = [OTHER];
participantTampered.source_hash = '0'.repeat(64);
assert.equal(verifySolanaTransactionSignerEvidence(participantTampered), false);

await assert.rejects(
  collectSolanaTransactionSignerEvidence({
    ...common,
    rpc_endpoint_label: 'https://rpc.example/?token=TEST_ONLY_SECRET',
    fetch_fn: response(null),
  }),
  /rpc_endpoint_label_invalid/,
);

await assert.rejects(
  collectSolanaTransactionSignerEvidence({ ...common, signature: '1'.repeat(63), fetch_fn: response(null) }),
  /signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionSignerEvidence({
    ...common,
    fetch_fn: response({ ...txResult(), transaction: { signatures: ['1'.repeat(63)], message: txResult().transaction.message } }),
  }),
  /returned_signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionSignerEvidence({ ...common, fetch_fn: response(txResult({ duplicate: true })) }),
  /duplicate_account_key/,
);

await assert.rejects(
  collectSolanaTransactionSignerEvidence({ ...common, fetch_fn: response(txResult({ blockTime: 1767225610 })) }),
  /transaction_block_time_after_observation/,
);

console.log('Solana transaction signer evidence regression: PASS');
