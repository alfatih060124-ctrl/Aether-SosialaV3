import assert from 'node:assert/strict';
import {
  collectSolanaTransactionNativeBalanceEvidence,
  verifySolanaTransactionNativeBalanceEvidence,
} from '../services/api/src/solana-transaction-native-balance-evidence.mjs';

const SIGNATURE = '1'.repeat(64); // SYNTHETIC / TEST-ONLY
const TRADER = '1'.repeat(32); // SYNTHETIC / TEST-ONLY
const OTHER = `2${'1'.repeat(31)}`; // SYNTHETIC / TEST-ONLY

const evidence = await collectSolanaTransactionNativeBalanceEvidence({
  rpc_url: 'https://rpc.test.invalid',
  rpc_endpoint_label: 'synthetic_rpc',
  signature: SIGNATURE,
  trader_wallet: TRADER,
  request_started_at: '2026-01-01T00:00:01.000Z',
  observed_at: '2026-01-01T00:00:05.000Z',
  fetch_fn: async () => ({
    ok: true,
    async json() {
      return {
        jsonrpc: '2.0',
        id: 1,
        result: {
          slot: 456,
          blockTime: 1767225602,
          meta: { err: null, preBalances: [2_000_000_000, 100_000], postBalances: [1_750_000_000, 100_000] },
          transaction: {
            signatures: [SIGNATURE],
            message: {
              accountKeys: [
                { pubkey: TRADER, signer: true, writable: true },
                { pubkey: OTHER, signer: false, writable: false },
              ],
              instructions: [],
            },
          },
        },
      };
    },
  }),
});

assert.equal(verifySolanaTransactionNativeBalanceEvidence(evidence), true);
assert.ok(Array.isArray(evidence.provenance.account_keys), 'found evidence must bind ordered account_keys into provenance');
assert.equal(evidence.provenance.account_keys[evidence.provenance.account_index], evidence.provenance.requested_wallet, 'requested wallet must be bound to the claimed account_index');

const tampered = structuredClone(evidence);
tampered.provenance.account_keys[tampered.provenance.account_index] = OTHER;
assert.equal(verifySolanaTransactionNativeBalanceEvidence(tampered), false, 'verifier must reject a wallet/index provenance rewrite');

console.log('Solana native balance wallet/index binding regression: PASS');
