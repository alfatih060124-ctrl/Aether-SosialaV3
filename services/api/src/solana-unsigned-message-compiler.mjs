import crypto from 'node:crypto';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function publicKey(value, code) {
  try {
    return new PublicKey(text(value, code));
  } catch {
    throw new Error(code);
  }
}

function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('solana_compiler_account_meta_required');
  if (typeof raw.isSigner !== 'boolean') throw new Error('solana_compiler_account_signer_flag_required');
  if (typeof raw.isWritable !== 'boolean') throw new Error('solana_compiler_account_writable_flag_required');
  return Object.freeze({
    pubkey: publicKey(raw.pubkey, 'solana_compiler_account_pubkey_invalid'),
    isSigner: raw.isSigner,
    isWritable: raw.isWritable
  });
}

function normalizeInstruction(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('solana_compiler_instruction_required');
  const programId = publicKey(raw.program_id, 'solana_compiler_program_id_invalid');
  const keys = Array.isArray(raw.accounts) ? raw.accounts.map(normalizeMeta) : [];
  if (!keys.length) throw new Error('solana_compiler_instruction_accounts_required');
  let data;
  try {
    data = Buffer.from(text(raw.data_base64, 'solana_compiler_instruction_data_required'), 'base64');
  } catch {
    throw new Error('solana_compiler_instruction_data_invalid');
  }
  return new TransactionInstruction({ programId, keys, data });
}

function allZeroSignatures(transaction) {
  return transaction.signatures.every(signature => signature.every(byte => byte === 0));
}

export function createSolanaUnsignedMessageCompiler() {
  return Object.freeze({
    compile(evidence = {}, { feePayer } = {}) {
      if (!evidence || typeof evidence !== 'object' || evidence.verified !== true) throw new Error('solana_compiler_verified_evidence_required');
      if (evidence.unsigned !== true) throw new Error('solana_compiler_unsigned_evidence_required');
      if (evidence.transaction_signed === true || evidence.signer_requested === true || evidence.private_key_present === true || evidence.signature_present === true) {
        throw new Error('solana_compiler_safety_boundary_violation');
      }
      if (evidence.network_submission_authorized === true || evidence.live_execution_authorized === true) throw new Error('solana_compiler_live_boundary_violation');
      if (evidence.read_only !== true || evidence.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('solana_compiler_context_invalid');

      const payerKey = publicKey(feePayer, 'solana_compiler_fee_payer_invalid');
      const recentBlockhash = text(evidence.recent_blockhash, 'solana_compiler_recent_blockhash_required');
      const sourceSlot = Number(evidence.source_slot);
      if (!Number.isSafeInteger(sourceSlot) || sourceSlot < 0) throw new Error('solana_compiler_source_slot_required');
      const instructions = Array.isArray(evidence.instructions) ? evidence.instructions.map(normalizeInstruction) : [];
      if (!instructions.length) throw new Error('solana_compiler_instructions_required');

      const message = new TransactionMessage({ payerKey, recentBlockhash, instructions }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      if (!allZeroSignatures(transaction)) throw new Error('solana_compiler_nonzero_signature_detected');

      const messageBytes = Buffer.from(message.serialize());
      const transactionBytes = Buffer.from(transaction.serialize());
      const messageBase64 = messageBytes.toString('base64');
      const transactionBase64 = transactionBytes.toString('base64');
      const messageHash = crypto.createHash('sha256').update(messageBytes).digest('hex');
      const transactionHash = crypto.createHash('sha256').update(transactionBytes).digest('hex');

      return Object.freeze({
        verified: true,
        message_base64: messageBase64,
        transaction_base64: transactionBase64,
        message_hash: messageHash,
        transaction_hash: transactionHash,
        fee_payer: payerKey.toBase58(),
        source_slot: sourceSlot,
        source_reference: `SOLANA_UNSIGNED_V0:${messageHash}:${transactionHash}`,
        observed_at: text(evidence.observed_at, 'solana_compiler_observed_at_required'),
        account_keys: Object.freeze(message.staticAccountKeys.map(key => key.toBase58())),
        transaction_signed: false,
        signer_requested: false,
        private_key_present: false,
        signature_present: false,
        network_submission_authorized: false,
        live_execution_authorized: false,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      });
    }
  });
}

export const SOLANA_UNSIGNED_MESSAGE_COMPILER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  version: 0,
  requires_public_fee_payer_only: true,
  private_key_allowed: false,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
