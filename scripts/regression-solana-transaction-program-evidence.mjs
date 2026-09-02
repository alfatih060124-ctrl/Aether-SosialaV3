import assert from 'node:assert/strict';
import {
  collectSolanaTransactionProgramEvidence,
  verifySolanaTransactionProgramEvidence,
} from '../services/api/src/solana-transaction-program-evidence.mjs';

const SIGNATURE = '1'.repeat(64); // SYNTHETIC / TEST-ONLY: decodes to 64 zero bytes.
const WALLET = '1'.repeat(32); // SYNTHETIC / TEST-ONLY: decodes to 32 zero bytes.
const PROGRAM = WALLET; // SYNTHETIC / TEST-ONLY only; not a production program identifier.
const STARTED = '2026-01-01T00:00:01.000Z';
const OBSERVED = '2026-01-01T00:00:05.000Z';

function response(result) {
  return async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, result }; } });
}

function txResult(overrides = {}) {
  return {
    slot: 123,
    blockTime: 1767225602,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [{ pubkey: WALLET }],
        instructions: [{ programId: PROGRAM }],
      },
    },
    ...overrides,
  };
}

const common = {
  rpc_url: 'https://rpc.test.invalid',
  rpc_endpoint_label: 'synthetic_rpc',
  signature: SIGNATURE,
  trader_wallet: WALLET,
  request_started_at: STARTED,
  observed_at: OBSERVED,
};

const found = await collectSolanaTransactionProgramEvidence({ ...common, fetch_fn: response(txResult()) });
assert.equal(found.collection_status, 'PENDING_DATA');
assert.equal(found.metrics_available, false);
assert.equal(found.verified, false);
assert.equal(found.published, false);
assert.equal(found.live_execution_authorized, false);
assert.equal(found.trades_count, null);
assert.equal(found.total_return_bps, null);
assert.equal(found.win_rate_bps, null);
assert.equal(found.drawdown_bps, null);
assert.equal(found.reputation_score, null);
assert.equal(found.source_reference, `solana_rpc:${SIGNATURE}@123`);
assert.deepEqual(found.program_ids, [PROGRAM]);
assert.equal(found.reconciliation_required, true);
assert.equal(verifySolanaTransactionProgramEvidence(found), true);

const tampered = structuredClone(found);
tampered.provenance.program_ids = [];
assert.equal(verifySolanaTransactionProgramEvidence(tampered), false);

const notFound = await collectSolanaTransactionProgramEvidence({ ...common, fetch_fn: response(null) });
assert.equal(notFound.collection_status, 'PENDING_DATA');
assert.equal(notFound.source_reference, null);
assert.equal(verifySolanaTransactionProgramEvidence(notFound), true);

await assert.rejects(
  collectSolanaTransactionProgramEvidence({
    ...common,
    rpc_endpoint_label: 'https://rpc.example/?token=TEST_ONLY_SECRET',
    fetch_fn: response(null),
  }),
  /rpc_endpoint_label_invalid/,
);

await assert.rejects(
  collectSolanaTransactionProgramEvidence({
    ...common,
    signature: '1'.repeat(63),
    fetch_fn: response(null),
  }),
  /signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionProgramEvidence({
    ...common,
    fetch_fn: response(txResult({ transaction: { signatures: ['1'.repeat(63)], message: { accountKeys: [{ pubkey: WALLET }], instructions: [{ programId: PROGRAM }] } } })),
  }),
  /returned_signature_invalid/,
);

await assert.rejects(
  collectSolanaTransactionProgramEvidence({
    ...common,
    fetch_fn: response(txResult({ transaction: { signatures: [SIGNATURE], message: { accountKeys: [], instructions: [{ programId: PROGRAM }] } } })),
  }),
  /trader_wallet_not_in_transaction/,
);

await assert.rejects(
  collectSolanaTransactionProgramEvidence({
    ...common,
    fetch_fn: response(txResult({ blockTime: 1767225610 })),
  }),
  /transaction_block_time_after_observation/,
);

console.log('Solana transaction program evidence regression: PASS');
