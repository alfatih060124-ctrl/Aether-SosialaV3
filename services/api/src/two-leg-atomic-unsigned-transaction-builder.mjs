import crypto from 'node:crypto';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function publicKey(value, code) {
  try { return new PublicKey(text(value, code)); }
  catch { throw new Error(code); }
}

function number(value, code) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(code);
  return normalized;
}

function requireLeg(leg, dex, decision) {
  if (!leg || typeof leg !== 'object') throw new Error(`two_leg_atomic_${dex.toLowerCase()}_leg_required`);
  if (String(leg.dex || '').toUpperCase() !== dex) throw new Error('two_leg_atomic_leg_dex_mismatch');
  if (leg.verified !== true || leg.unsigned !== true || leg.transaction_signed === true) throw new Error('two_leg_atomic_verified_unsigned_leg_required');
  if (leg.strategy !== STRATEGY || leg.network_submission_authorized === true || leg.live_execution_authorized === true) throw new Error('two_leg_atomic_leg_safety_boundary_violation');
  if (text(leg.token_mint, 'two_leg_atomic_leg_token_mint_required') !== decision.token_mint) throw new Error('two_leg_atomic_leg_token_mint_mismatch');
  if (text(leg.quote_mint, 'two_leg_atomic_leg_quote_mint_required') !== decision.quote_mint) throw new Error('two_leg_atomic_leg_quote_mint_mismatch');
  const instructions = Array.isArray(leg.instructions) ? leg.instructions : [];
  if (!instructions.length) throw new Error('two_leg_atomic_leg_instructions_required');
  return instructions.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('two_leg_atomic_instruction_required');
    const programId = publicKey(raw.program_id, 'two_leg_atomic_program_id_invalid');
    const keys = Array.isArray(raw.accounts) ? raw.accounts.map(meta => ({
      pubkey: publicKey(meta?.pubkey, 'two_leg_atomic_account_pubkey_invalid'),
      isSigner: Boolean(meta?.isSigner),
      isWritable: Boolean(meta?.isWritable)
    })) : [];
    if (!keys.length) throw new Error('two_leg_atomic_instruction_accounts_required');
    const data = Buffer.from(text(raw.data_base64, 'two_leg_atomic_instruction_data_required'), 'base64');
    return new TransactionInstruction({ programId, keys, data });
  });
}

export function createTwoLegAtomicUnsignedTransactionBuilder() {
  return Object.freeze({
    build({ decision, orcaLeg, raydiumLeg, feePayer, recentBlockhash } = {}) {
      if (!decision || typeof decision !== 'object') throw new Error('two_leg_atomic_decision_required');
      if (decision.strategy !== STRATEGY || decision.dex_pair !== DEX_PAIR || decision.action !== 'ARBITRAGE_SETTLE') throw new Error('two_leg_atomic_decision_scope_invalid');
      if (decision.qualified !== true || decision.risk_verified !== true || decision.costs_verified !== true || decision.freshness_verified !== true) throw new Error('two_leg_atomic_decision_not_verified');
      const tokenMint = text(decision.token_mint, 'two_leg_atomic_token_mint_required');
      const quoteMint = text(decision.quote_mint, 'two_leg_atomic_quote_mint_required');
      const notionalUsdc = number(decision.notional_usdc, 'two_leg_atomic_notional_required');
      const payerKey = publicKey(feePayer, 'two_leg_atomic_fee_payer_invalid');
      const blockhash = text(recentBlockhash, 'two_leg_atomic_recent_blockhash_required');
      const checkedDecision = Object.freeze({ ...decision, token_mint: tokenMint, quote_mint: quoteMint, notional_usdc: notionalUsdc });

      const orcaInstructions = requireLeg(orcaLeg, 'ORCA', checkedDecision);
      const raydiumInstructions = requireLeg(raydiumLeg, 'RAYDIUM', checkedDecision);
      const orderedLegs = String(decision.buy_dex || '').toUpperCase() === 'ORCA'
        ? [...orcaInstructions, ...raydiumInstructions]
        : [...raydiumInstructions, ...orcaInstructions];

      const message = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: orderedLegs }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      if (!transaction.signatures.every(signature => signature.every(byte => byte === 0))) throw new Error('two_leg_atomic_nonzero_signature_detected');

      const serialized = Buffer.from(transaction.serialize());
      const messageBytes = Buffer.from(message.serialize());
      return Object.freeze({
        schema: 'aether.two_leg_atomic_unsigned_plan.v1',
        strategy: STRATEGY,
        dex_pair: DEX_PAIR,
        atomic: true,
        leg_count: 2,
        token_mint: tokenMint,
        quote_mint: quoteMint,
        notional_usdc: notionalUsdc,
        buy_dex: String(decision.buy_dex || '').toUpperCase(),
        sell_dex: String(decision.sell_dex || '').toUpperCase(),
        legs: Object.freeze([
          Object.freeze({ dex: 'ORCA', direction: String(orcaLeg.side || '').toUpperCase() }),
          Object.freeze({ dex: 'RAYDIUM', direction: String(raydiumLeg.side || '').toUpperCase() })
        ]),
        fee_payer: payerKey.toBase58(),
        recent_blockhash: blockhash,
        message_hash: crypto.createHash('sha256').update(messageBytes).digest('hex'),
        transaction_hash: crypto.createHash('sha256').update(serialized).digest('hex'),
        unsigned_transaction_base64: serialized.toString('base64'),
        signed: false,
        transaction_signed: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const TWO_LEG_ATOMIC_UNSIGNED_TRANSACTION_BUILDER = Object.freeze({
  schema: 'aether.two_leg_atomic_unsigned_builder.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  atomic_required: true,
  leg_count: 2,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false,
  fail_closed: true
});
