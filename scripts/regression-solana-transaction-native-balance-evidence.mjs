import assert from 'node:assert/strict';
import {
  collectSolanaTransactionNativeBalanceEvidence,
  verifySolanaTransactionNativeBalanceEvidence,
} from '../services/api/src/solana-transaction-native-balance-evidence.mjs';

const SIGNATURE = '1'.repeat(64); // SYNTHETIC / TEST-ONLY: 64 zero bytes.
const TRADER = '1'.repeat(32); // SYNTHETIC / TEST-ONLY: 32 zero bytes.
const OTHER = `2${'1'.repeat(31)}`; // SYNTHETIC / TEST-ONLY only.
const STARTED = '2026-01-01T00:00:01.000Z';
const OBSERVED = '2026-01-01T00:00:05.000Z';

function response(result) {
  return async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, result }; } });
}

function txResult({
  pre = [2_000_000_000, 100_000],
  post = [1_750_000_000, 100_000],
  err = null,
  walletPresent = true,
  duplicate = false,
  blockTime = 1767225602,
} = {}) {
  const accountKeys = walletPresent
    ? [{ pubkey: TRADER, signer: true, writable: true }, { pubkey: OTHER, signer: false, writable: false }]
    : [{ pubkey: OTHER, signer: true, writable: true }];
  if (duplicate) accountKeys.push({ pubkey: TRADER, signer: false, writable: false });
  return {
    slot: 456,
    blockTime,
    meta: { err, preBalances: pre, postBalances: post },
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

const found = await collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult()) });
assert.equal(found.collection_status, 'PENDING_DATA');
assert.equal(found.metrics_available, false);
assert.equal(found.trades_count, null);
assert.equal(found.total_return_bps, null);
assert.equal(found.win_rate_bps, null);
assert.equal(found.drawdown_bps, null);
assert.equal(found.reputation_score, null);
assert.equal(found.verified, false);
assert.equal(found.published, false);
assert.equal(found.live_execution_authorized, false);
assert.equal(found.reconciliation_required, true);
assert.equal(found.source_reference, `solana_rpc:${SIGNATURE}@456`);
assert.equal(found.pre_lamports, '2000000000');
assert.equal(found.post_lamports, '1750000000');
assert.equal(found.delta_lamports, '-250000000');
assert.equal(found.transaction_succeeded, true);
assert.equal(verifySolanaTransactionNativeBalanceEvidence(found), true);

const failedTx = await collectSolanaTransactionNativeBalanceEvidence({
  ...common,
  fetch_fn: response(txResult({ err: { InstructionError: [0, 'Custom'] } })),
});
assert.equal(failedTx.collection_status, 'PENDING_DATA');
assert.equal(failedTx.transaction_succeeded, false);
assert.equal(failedTx.source_reference, `solana_rpc:${SIGNATURE}@456`);
assert.equal(verifySolanaTransactionNativeBalanceEvidence(failedTx), true);

const notFound = await collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(null) });
assert.equal(notFound.collection_status, 'PENDING_DATA');
assert.equal(notFound.source_reference, null);
assert.equal(notFound.pre_lamports, null);
assert.equal(notFound.post_lamports, null);
assert.equal(notFound.delta_lamports, null);
assert.equal(notFound.transaction_succeeded, null);
assert.equal(verifySolanaTransactionNativeBalanceEvidence(notFound), true);

const tampered = structuredClone(found);
tampered.provenance.delta_lamports = '-1';
tampered.delta_lamports = '-1';
tampered.source_hash = '0'.repeat(64);
assert.equal(verifySolanaTransactionNativeBalanceEvidence(tampered), false);

const selfConsistentTamper = structuredClone(found);
selfConsistentTamper.provenance.post_lamports = '1750000001';
selfConsistentTamper.post_lamports = '1750000001';
assert.equal(verifySolanaTransactionNativeBalanceEvidence(selfConsistentTamper), false);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({
    ...common,
    rpc_endpoint_label: 'https://rpc.example/?token=TEST_ONLY_SECRET',
    fetch_fn: response(null),
  }),
  /rpc_endpoint_label_invalid/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, signature: '1'.repeat(63), fetch_fn: response(null) }),
  /signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({
    ...common,
    fetch_fn: response({ ...txResult(), transaction: { signatures: ['1'.repeat(63)], message: txResult().transaction.message } }),
  }),
  /returned_signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult({ walletPresent: false, pre: [100], post: [90] })) }),
  /trader_wallet_not_in_transaction/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult({ duplicate: true, pre: [100, 100, 100], post: [90, 100, 100] })) }),
  /duplicate_account_key/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult({ pre: [Number.MAX_SAFE_INTEGER + 1, 100_000] })) }),
  /pre_balances_invalid/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult({ post: [1_750_000_000] })) }),
  /post_balances_invalid/,
);

await assert.rejects(
  collectSolanaTransactionNativeBalanceEvidence({ ...common, fetch_fn: response(txResult({ blockTime: 1767225610 })) }),
  /transaction_block_time_after_observation/,
);

console.log('Solana transaction native balance evidence regression: PASS');
