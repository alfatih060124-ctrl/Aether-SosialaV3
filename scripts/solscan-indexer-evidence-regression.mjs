import assert from 'node:assert/strict';
import { collectSolscanIndexerEvidence, createSolscanAccountTransactionsCaller } from '../packages/data-evidence/solscan-indexer-source.mjs';

// SYNTHETIC / TEST-ONLY fixtures. Never use these identifiers as production evidence.
const WALLET = '1'.repeat(32);
const SIG_A = `${'1'.repeat(63)}2`;
const SIG_B = `${'1'.repeat(63)}3`;
const SIG_C = `${'1'.repeat(63)}4`;

const rows = [
  { tx_hash: SIG_A, slot: 300, block_time: 1_780_000_300, fee: 5000, status: 'Success' },
  { tx_hash: SIG_B, slot: 299, block_time: 1_780_000_200, fee: 6000, status: 'Fail' }
];

const collected = await collectSolscanIndexerEvidence({
  walletAddress: WALLET,
  limit: 20,
  maxPages: 3,
  pageCall: async ({ address, before, limit }) => {
    assert.equal(address, WALLET);
    assert.equal(before, null);
    assert.equal(limit, 20);
    return rows;
  }
});

assert.equal(collected.collection_status, 'PENDING_DATA');
assert.equal(collected.reason, 'reconciled_trade_performance_required');
assert.equal(collected.source_type, 'SOLSCAN_INDEXER');
assert.equal(collected.source_reference, SIG_A);
assert.equal(collected.metrics_available, false);
assert.equal(collected.trades_count, null);
assert.equal(collected.total_return_bps, null);
assert.equal(collected.win_rate_bps, null);
assert.equal(collected.drawdown_bps, null);
assert.equal(collected.reputation_score, null);
assert.equal(collected.verified, false);
assert.equal(collected.published, false);
assert.equal(collected.live_execution_authorized, false);
assert.equal(collected.provenance.provider, 'SOLSCAN_PRO_API');
assert.equal(collected.provenance.endpoint, '/v2.0/account/transactions');
assert.equal(collected.provenance.collection_complete, true);
assert.equal(collected.provenance.transactions_observed, 2);
assert.equal(collected.provenance.successful_transactions_observed, 1);
assert.equal(collected.provenance.failed_transactions_observed, 1);
assert.match(collected.provenance.source_hash, /^[a-f0-9]{64}$/);

const reordered = await collectSolscanIndexerEvidence({
  walletAddress: WALLET,
  limit: 20,
  maxPages: 3,
  pageCall: async () => [...rows].reverse()
});
assert.equal(reordered.provenance.source_hash, collected.provenance.source_hash);
assert.equal(reordered.source_reference, SIG_A);

await assert.rejects(
  collectSolscanIndexerEvidence({
    walletAddress: WALLET,
    limit: 20,
    maxPages: 3,
    pageCall: async () => [rows[0], { ...rows[0], fee: 9999 }]
  }),
  /conflicting_solscan_duplicate_tx/
);

await assert.rejects(
  collectSolscanIndexerEvidence({
    walletAddress: WALLET,
    limit: 20,
    maxPages: 3,
    pageCall: async () => [{ ...rows[0], tx_hash: 'not-a-solana-signature' }]
  }),
  /invalid_solscan_tx_hash/
);

const empty = await collectSolscanIndexerEvidence({
  walletAddress: WALLET,
  limit: 20,
  maxPages: 1,
  pageCall: async () => []
});
assert.equal(empty.collection_status, 'PENDING_DATA');
assert.equal(empty.reason, 'no_verifiable_chain_activity');
assert.equal(empty.source_reference, null);
assert.equal(empty.verified, false);
assert.equal(empty.published, false);

let capturedUrl;
let capturedHeaders;
const caller = createSolscanAccountTransactionsCaller({
  apiToken: 'SYNTHETIC_TEST_ONLY_TOKEN',
  timeoutMs: 1000,
  fetchImpl: async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return { ok: true, json: async () => ({ success: true, data: [{ ...rows[0], tx_hash: SIG_C }] }) };
  }
});
const apiRows = await caller({ address: WALLET, before: SIG_A, limit: 20 });
assert.equal(apiRows.length, 1);
assert.equal(capturedUrl.origin, 'https://pro-api.solscan.io');
assert.equal(capturedUrl.pathname, '/v2.0/account/transactions');
assert.equal(capturedUrl.searchParams.get('address'), WALLET);
assert.equal(capturedUrl.searchParams.get('before'), SIG_A);
assert.equal(capturedUrl.searchParams.get('limit'), '20');
assert.equal(capturedHeaders.token, 'SYNTHETIC_TEST_ONLY_TOKEN');

assert.throws(
  () => createSolscanAccountTransactionsCaller({ apiToken: 'x', timeoutMs: 999 }),
  /invalid_solscan_timeout_ms/
);

console.log('Solscan indexer evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
