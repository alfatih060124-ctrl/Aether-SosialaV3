import assert from 'node:assert/strict';
import {
  collectSolanaTokenBalanceEvidence,
  verifySolanaTokenBalanceEvidence
} from '../services/api/src/solana-token-balance-evidence-source.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production wallet, signature, tx hash, source reference, or trader metric is used.
const signature = '1'.repeat(64);
const wallet = '1'.repeat(32);
const mintA = '2'.repeat(44);
const mintB = '3'.repeat(44);
const otherOwner = '4'.repeat(44);

function clockSequence(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const response = {
  slot: 222222,
  blockTime: 1788360000,
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 2, mint: mintA, owner: wallet, uiTokenAmount: { decimals: 6, amount: '2500000' } },
      { accountIndex: 3, mint: mintB, owner: wallet, uiTokenAmount: { decimals: 9, amount: '1000000000' } },
      { accountIndex: 4, mint: mintA, owner: otherOwner, uiTokenAmount: { decimals: 6, amount: '9000000' } }
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: mintA, owner: wallet, uiTokenAmount: { decimals: 6, amount: '1500000' } },
      { accountIndex: 3, mint: mintB, owner: wallet, uiTokenAmount: { decimals: 9, amount: '1200000000' } },
      { accountIndex: 4, mint: mintA, owner: otherOwner, uiTokenAmount: { decimals: 6, amount: '8000000' } }
    ]
  },
  transaction: { signatures: [signature] }
};

const collected = await collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  endpointLabel: 'test-rpc',
  rpcCall: async (method, params) => {
    assert.equal(method, 'getTransaction');
    assert.equal(params[0], signature);
    assert.deepEqual(params[1], { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 });
    return response;
  },
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
});

assert.equal(collected.collection_status, 'PENDING_DATA');
assert.equal(collected.reason, 'wallet_token_balance_evidence_reconciliation_required');
assert.equal(collected.source_reference, `solana_rpc:${signature}@222222`);
assert.deepEqual(collected.provenance.wallet_token_deltas, [
  { account_index: 2, mint: mintA, owner: wallet, decimals: 6, pre_amount_raw: '2500000', post_amount_raw: '1500000', delta_raw: '-1000000' },
  { account_index: 3, mint: mintB, owner: wallet, decimals: 9, pre_amount_raw: '1000000000', post_amount_raw: '1200000000', delta_raw: '200000000' }
]);
assert.equal(collected.metrics_available, false);
assert.equal(collected.trades_count, null);
assert.equal(collected.total_return_bps, null);
assert.equal(collected.win_rate_bps, null);
assert.equal(collected.drawdown_bps, null);
assert.equal(collected.reputation_score, null);
assert.equal(collected.verified, false);
assert.equal(collected.published, false);
assert.equal(collected.live_execution_authorized, false);
assert.equal(verifySolanaTokenBalanceEvidence(collected), true);

const notFound = await collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  rpcCall: async () => null,
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
});
assert.equal(notFound.reason, 'transaction_not_found_at_requested_commitment');
assert.equal(notFound.source_reference, null);
assert.equal(verifySolanaTokenBalanceEvidence(notFound), true);

const failed = await collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  rpcCall: async () => ({ ...response, meta: { ...response.meta, err: { InstructionError: [0, 'SyntheticFailure'] } } }),
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
});
assert.equal(failed.reason, 'failed_transaction_not_trade_evidence');
assert.equal(failed.metrics_available, false);
assert.equal(failed.verified, false);

const tampered = structuredClone(collected);
tampered.provenance.wallet_token_deltas[0].delta_raw = '-999999';
assert.equal(verifySolanaTokenBalanceEvidence(tampered), false);

await assert.rejects(() => collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  rpcCall: async () => ({ ...response, meta: { ...response.meta, postTokenBalances: [
    { accountIndex: 2, mint: mintA, owner: wallet, uiTokenAmount: { decimals: 7, amount: '1500000' } }
  ] } }),
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
}), /token_balance_identity_changed/);

await assert.rejects(() => collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  endpointLabel: 'https://secret.example/?token=test-only',
  rpcCall: async () => response,
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
}), /invalid_rpc_endpoint_label/);

await assert.rejects(() => collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  rpcCall: async () => ({ ...response, meta: { ...response.meta, preTokenBalances: [
    { accountIndex: 2, mint: mintA, owner: wallet, uiTokenAmount: { decimals: 6, amount: '18446744073709551616' } }
  ] } }),
  clock: clockSequence('2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z')
}), /invalid_token_raw_amount/);

console.log('solana token balance evidence regression: ok');
