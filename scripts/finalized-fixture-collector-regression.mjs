import assert from 'node:assert/strict';
import { captureFinalizedFixture, executedProgramIds } from '../packages/decoder-fixtures/finalized-fixture-collector.mjs';

const SIGNATURE = '1'.repeat(64);
const OTHER_SIGNATURE = `${'1'.repeat(63)}2`;
const PROGRAM_ID = '1'.repeat(32);
const OTHER_PROGRAM_ID = `${'1'.repeat(31)}2`;

function transaction({ programId = PROGRAM_ID, slot = 123456, blockTime = 1788257000, metaErr = null, signatures = [SIGNATURE] } = {}) {
  return {
    slot,
    blockTime,
    meta: {
      err: metaErr,
      fee: 5000,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: PROGRAM_ID, signer: false, writable: false },
          { pubkey: OTHER_PROGRAM_ID, signer: false, writable: false },
        ],
        instructions: [{ programId, accounts: [], data: '' }],
      },
      signatures,
    },
  };
}

function rpcMock({ signature = SIGNATURE, status = 'finalized', statusErr = null, tx = transaction() } = {}) {
  return async (method, params) => {
    if (method === 'getSignatureStatuses') {
      assert.deepEqual(params, [[signature], { searchTransactionHistory: true }]);
      return { value: [{ confirmationStatus: status, err: statusErr, confirmations: null, slot: tx?.slot || 123456 }] };
    }
    if (method === 'getTransaction') {
      assert.equal(params[0], signature);
      assert.deepEqual(params[1], { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 });
      return tx;
    }
    throw new Error(`unexpected_rpc_method:${method}`);
  };
}

const base = {
  rpcCall: rpcMock(),
  signature: SIGNATURE,
  dex: 'jupiter',
  version: 'router-v6',
  programId: PROGRAM_ID,
  expected: 'EVENT',
  endpointLabel: 'synthetic-rpc-test-only',
};

const captured = await captureFinalizedFixture(base);
assert.equal(captured.fixture_class, 'RAW_CAPTURE');
assert.equal(captured.capture_kind, 'SOLANA_FINALIZED_TRANSACTION');
assert.equal(captured.review_state, 'PENDING_REVIEW');
assert.equal(captured.countable_for_live_manifest, false);
assert.equal(captured.commitment, 'finalized');
assert.equal(captured.program_execution_proven, true);
assert.equal(captured.dex, 'jupiter');
assert.equal(captured.version, 'router-v6');
assert.equal(captured.program_id, PROGRAM_ID);
assert.equal(captured.signature, SIGNATURE);
assert.equal(captured.safety.network_read_only, true);
assert.equal(captured.safety.network_submission, false);
assert.equal(captured.safety.signer_used, false);
assert.equal(captured.safety.live_execution_authorized, false);
assert.equal(captured.safety.promotion_required_before_live_counting, true);
assert.match(captured.evidence_sha256, /^[0-9a-f]{64}$/);
assert.ok(captured.executed_program_ids.includes(PROGRAM_ID));
assert.deepEqual(executedProgramIds(transaction()), [PROGRAM_ID]);

const repeated = await captureFinalizedFixture(base);
assert.equal(repeated.evidence_sha256, captured.evidence_sha256, 'same finalized evidence must hash deterministically');

const changed = await captureFinalizedFixture({ ...base, rpcCall: rpcMock({ tx: transaction({ slot: 123457 }) }) });
assert.notEqual(changed.evidence_sha256, captured.evidence_sha256, 'changed chain evidence must change evidence hash');

const negative = await captureFinalizedFixture({ ...base, expected: 'REJECT', dex: 'orca', version: 'whirlpool-v2' });
assert.equal(negative.expected, 'REJECT');
assert.equal(negative.fixture_class, 'RAW_CAPTURE');
assert.equal(negative.countable_for_live_manifest, false, 'raw negative capture still requires review');

await assert.rejects(
  () => captureFinalizedFixture({ ...base, rpcCall: rpcMock({ status: 'confirmed' }) }),
  /transaction_not_finalized/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, rpcCall: rpcMock({ statusErr: { InstructionError: [0, 'Custom'] } }) }),
  /transaction_failed_onchain/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, rpcCall: rpcMock({ tx: transaction({ programId: OTHER_PROGRAM_ID }) }) }),
  /required_dex_program_not_executed/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, rpcCall: rpcMock({ tx: transaction({ metaErr: { InstructionError: [0, 'Custom'] } }) }) }),
  /transaction_meta_not_successful/
);
await assert.rejects(
  () => captureFinalizedFixture({
    ...base,
    signature: OTHER_SIGNATURE,
    rpcCall: rpcMock({ signature: OTHER_SIGNATURE, tx: transaction({ signatures: [SIGNATURE] }) }),
  }),
  /transaction_signature_mismatch/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, signature: 'not-a-solana-signature' }),
  /invalid_solana_signature/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, programId: 'bad-program' }),
  /invalid_program_id/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, dex: 'unknown-dex' }),
  /unsupported_fixture_dex/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, version: 'REPLACE_WITH_EXACT_DEPLOYED_VERSION' }),
  /placeholder_version_not_allowed/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, endpointLabel: 'https://rpc.example/?api-key=secret' }),
  /rpc_endpoint_label_must_not_contain_secret_or_url/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, expected: 'PASS' }),
  /invalid_fixture_expected/
);
await assert.rejects(
  () => captureFinalizedFixture({ ...base, rpcCall: async method => method === 'getSignatureStatuses' ? { value: [null] } : null }),
  /signature_status_not_found/
);

const serialized = JSON.stringify(captured);
assert.equal(serialized.includes('rpc_url'), false);
assert.equal(serialized.includes('private_key'), false);
assert.equal(serialized.includes('seed_phrase'), false);
assert.equal(serialized.includes('signing_key'), false);
assert.equal(serialized.includes('VERIFIED_ONCHAIN'), false, 'raw capture must never self-assert verified fixture class');

console.log('finalized fixture collector regression: PASS');
