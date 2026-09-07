import assert from 'node:assert/strict';
import {
  collectSolanaTransactionInnerInstructionEvidence,
  verifySolanaTransactionInnerInstructionEvidence,
} from '../services/api/src/solana-transaction-inner-instruction-evidence.mjs';

const SIGNATURE = '6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbhiKjrKokLb9o111kxTD5KkPVd7UBSCcFcnWFkrJ82Hu6';
const OTHER_SIGNATURE = '7z8GcFcMNwCGuiNX7AzpkXrzhnqenSpYoA6hdHqfmbKSezHczNJCuakboR7M9FVPVsC9XxpKe8W99CuWRMYdMH7';
const WALLET = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const PROGRAM_A = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const PROGRAM_B = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const ACCOUNT = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const STARTED = '2026-09-03T00:00:00.000Z';
const OBSERVED = '2026-09-03T00:00:10.000Z';

function rpcResponse(result) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.method, 'getTransaction');
    assert.equal(body.params[0], SIGNATURE);
    assert.deepEqual(body.params[1], { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result }; } };
  };
}

function transactionResult({ signature = SIGNATURE, wallet = WALLET, innerInstructions, err = null, blockTime = 1788393605, loadedWritable = [PROGRAM_B], loadedReadonly = [ACCOUNT] } = {}) {
  return {
    slot: 123456789,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [wallet, PROGRAM_A],
        instructions: [{ programIdIndex: 1, accounts: [0], data: '2' }, { programIdIndex: 1, accounts: [0], data: '3' }],
      },
    },
    meta: {
      err,
      loadedAddresses: { writable: loadedWritable, readonly: loadedReadonly },
      innerInstructions: innerInstructions ?? [
        { index: 0, instructions: [{ programIdIndex: 1, accounts: [0, 3], data: '2', stackHeight: 2 }] },
        { index: 1, instructions: [{ programIdIndex: 2, accounts: [0], data: '3', stackHeight: 3 }] },
      ],
    },
  };
}

async function collect(result) {
  return collectSolanaTransactionInnerInstructionEvidence({
    rpc_url: 'https://synthetic.invalid',
    rpc_endpoint_label: 'synthetic-test-only',
    signature: SIGNATURE,
    trader_wallet: WALLET,
    commitment: 'confirmed',
    request_started_at: STARTED,
    observed_at: OBSERVED,
    fetch_fn: rpcResponse(result),
  });
}

const evidence = await collect(transactionResult());
assert.equal(evidence.collection_status, 'PENDING_DATA');
assert.equal(evidence.metrics_available, false);
assert.equal(evidence.verified, false);
assert.equal(evidence.published, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(evidence.reconciliation_required, true);
assert.equal(evidence.trades_count, null);
assert.equal(evidence.total_return_bps, null);
assert.equal(evidence.win_rate_bps, null);
assert.equal(evidence.drawdown_bps, null);
assert.equal(evidence.reputation_score, null);
assert.equal(evidence.source_reference, `solana_rpc:${SIGNATURE}@123456789`);
assert.deepEqual(evidence.inner_program_ids, [PROGRAM_A, PROGRAM_B].sort());
assert.equal(evidence.provenance.combined_account_keys.length, 4);
assert.equal(evidence.provenance.static_account_count, 2);
assert.equal(evidence.provenance.loaded_writable_count, 1);
assert.equal(evidence.provenance.loaded_readonly_count, 1);
assert.equal(evidence.provenance.inner_topology[0].instructions[0].program_id, PROGRAM_A);
assert.equal(evidence.provenance.inner_topology[1].instructions[0].program_id, PROGRAM_B);
assert.equal(verifySolanaTransactionInnerInstructionEvidence(evidence), true);

const tamperedProgram = structuredClone(evidence);
tamperedProgram.provenance.inner_topology[0].instructions[0].program_id = PROGRAM_B;
assert.equal(verifySolanaTransactionInnerInstructionEvidence(tamperedProgram), false);

const tamperedAccountBinding = structuredClone(evidence);
tamperedAccountBinding.provenance.combined_account_keys[0] = ACCOUNT;
assert.equal(verifySolanaTransactionInnerInstructionEvidence(tamperedAccountBinding), false);

const tamperedSourceHash = structuredClone(evidence);
tamperedSourceHash.source_hash = '0'.repeat(64);
assert.equal(verifySolanaTransactionInnerInstructionEvidence(tamperedSourceHash), false);

const noCpi = await collect(transactionResult({ innerInstructions: [] }));
assert.equal(noCpi.collection_status, 'PENDING_DATA');
assert.equal(noCpi.source_reference, null);
assert.deepEqual(noCpi.inner_program_ids, []);
assert.equal(noCpi.provenance.cpi_available, false);
assert.equal(verifySolanaTransactionInnerInstructionEvidence(noCpi), true);

const notFound = await collect(null);
assert.equal(notFound.source_reference, null);
assert.equal(notFound.provenance.found, false);
assert.deepEqual(notFound.inner_program_ids, []);
assert.equal(verifySolanaTransactionInnerInstructionEvidence(notFound), true);

const failedTx = await collect(transactionResult({ err: { InstructionError: [1, 'Custom'] } }));
assert.equal(failedTx.collection_status, 'PENDING_DATA');
assert.equal(failedTx.verified, false);
assert.deepEqual(failedTx.provenance.transaction_error, { InstructionError: [1, 'Custom'] });
assert.equal(verifySolanaTransactionInnerInstructionEvidence(failedTx), true);

await assert.rejects(
  () => collect(transactionResult({ signature: OTHER_SIGNATURE })),
  /returned_signature_mismatch/,
);

await assert.rejects(
  () => collect(transactionResult({ wallet: ACCOUNT })),
  /trader_wallet_not_in_transaction/,
);

await assert.rejects(
  () => collect(transactionResult({ loadedWritable: [WALLET] })),
  /transaction_account_keys_duplicate/,
);

await assert.rejects(
  () => collect(transactionResult({ blockTime: 1788393620 })),
  /transaction_block_time_after_observation/,
);

await assert.rejects(
  () => collect(transactionResult({ innerInstructions: [{ index: 2, instructions: [{ programIdIndex: 1, accounts: [0], data: '2' }] }] })),
  /inner_outer_index_invalid/,
);

await assert.rejects(
  () => collect(transactionResult({ innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 99, accounts: [0], data: '2' }] }] })),
  /inner_program_id_index_invalid/,
);

await assert.rejects(
  () => collect(transactionResult({ innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [99], data: '2' }] }] })),
  /inner_account_index_invalid/,
);

await assert.rejects(
  () => collectSolanaTransactionInnerInstructionEvidence({
    rpc_url: 'https://synthetic.invalid',
    rpc_endpoint_label: 'https://rpc.example/?token=TEST_ONLY_SECRET',
    signature: SIGNATURE,
    trader_wallet: WALLET,
    request_started_at: STARTED,
    observed_at: OBSERVED,
    fetch_fn: rpcResponse(null),
  }),
  /rpc_endpoint_label_invalid/,
);

console.log('solana transaction inner instruction evidence regression: PASS');
