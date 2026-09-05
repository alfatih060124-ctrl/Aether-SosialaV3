import assert from 'node:assert/strict';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { createSolanaUnsignedMessageCompiler } from '../services/api/src/solana-unsigned-message-compiler.mjs';

const compiler = createSolanaUnsignedMessageCompiler();
const evidence = Object.freeze({
  verified: true,
  unsigned: true,
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  recent_blockhash: '11111111111111111111111111111111',
  source_slot: 900,
  observed_at: '2026-09-05T17:10:00.000Z',
  transaction_signed: false,
  signer_requested: false,
  private_key_present: false,
  signature_present: false,
  network_submission_authorized: false,
  live_execution_authorized: false,
  instructions: [
    {
      program_id: '11111111111111111111111111111111',
      accounts: [
        { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
        { pubkey: 'So11111111111111111111111111111111111111112', isSigner: false, isWritable: true }
      ],
      data_base64: 'AQID'
    }
  ]
});

const result = compiler.compile(evidence, { feePayer: 'Vote111111111111111111111111111111111111111' });
assert.equal(result.verified, true);
assert.equal(result.transaction_signed, false);
assert.equal(result.signer_requested, false);
assert.equal(result.private_key_present, false);
assert.equal(result.signature_present, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.source_slot, 900);
assert.match(result.message_hash, /^[a-f0-9]{64}$/);
assert.match(result.transaction_hash, /^[a-f0-9]{64}$/);
assert.match(result.source_reference, /^SOLANA_UNSIGNED_V0:/);

const messageBytes = Buffer.from(result.message_base64, 'base64');
const decodedMessage = VersionedMessage.deserialize(messageBytes);
assert.equal(decodedMessage.version, 0);
assert.equal(decodedMessage.recentBlockhash, evidence.recent_blockhash);

const txBytes = Buffer.from(result.transaction_base64, 'base64');
const decodedTx = VersionedTransaction.deserialize(txBytes);
assert.equal(decodedTx.message.version, 0);
assert.ok(decodedTx.signatures.length >= 1);
for (const signature of decodedTx.signatures) assert.ok(signature.every(byte => byte === 0));

assert.throws(
  () => compiler.compile({ ...evidence, private_key_present: true }, { feePayer: 'Vote111111111111111111111111111111111111111' }),
  /solana_compiler_safety_boundary_violation/
);
assert.throws(
  () => compiler.compile({ ...evidence, transaction_signed: true }, { feePayer: 'Vote111111111111111111111111111111111111111' }),
  /solana_compiler_safety_boundary_violation/
);
assert.throws(
  () => compiler.compile({ ...evidence, live_execution_authorized: true }, { feePayer: 'Vote111111111111111111111111111111111111111' }),
  /solana_compiler_live_boundary_violation/
);
assert.throws(
  () => compiler.compile(evidence, { feePayer: 'not-a-public-key' }),
  /solana_compiler_fee_payer_invalid/
);
assert.throws(
  () => compiler.compile({ ...evidence, instructions: [{ ...evidence.instructions[0], accounts: [{ pubkey: 'not-a-key', isSigner: false, isWritable: false }] }] }, { feePayer: 'Vote111111111111111111111111111111111111111' }),
  /solana_compiler_account_pubkey_invalid/
);

console.log('solana unsigned message compiler regression ok');
