import assert from 'node:assert/strict';
import {
  createTwoLegAtomicUnsignedTransactionBuilder,
  TWO_LEG_ATOMIC_UNSIGNED_TRANSACTION_BUILDER
} from '../services/api/src/two-leg-atomic-unsigned-transaction-builder.mjs';

const KEY = '11111111111111111111111111111111';
const TOKEN = 'So11111111111111111111111111111111111111112';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const decision = Object.freeze({
  strategy: 'TWO_LEG_ARBITRAGE', dex_pair: 'ORCA_RAYDIUM', action: 'ARBITRAGE_SETTLE',
  qualified: true, risk_verified: true, costs_verified: true, freshness_verified: true,
  token_mint: TOKEN, quote_mint: QUOTE, notional_usdc: 10,
  buy_dex: 'ORCA', sell_dex: 'RAYDIUM'
});
const instruction = Object.freeze({
  program_id: KEY,
  accounts: Object.freeze([{ pubkey: KEY, isSigner: false, isWritable: false }]),
  data_base64: 'AQ=='
});
const leg = (dex, side) => Object.freeze({
  dex, side, verified: true, unsigned: true, transaction_signed: false,
  strategy: 'TWO_LEG_ARBITRAGE', token_mint: TOKEN, quote_mint: QUOTE,
  network_submission_authorized: false, live_execution_authorized: false,
  instructions: Object.freeze([instruction])
});

assert.equal(TWO_LEG_ATOMIC_UNSIGNED_TRANSACTION_BUILDER.atomic_required, true);
assert.equal(TWO_LEG_ATOMIC_UNSIGNED_TRANSACTION_BUILDER.leg_count, 2);
assert.equal(TWO_LEG_ATOMIC_UNSIGNED_TRANSACTION_BUILDER.transaction_signing_authorized, false);

const builder = createTwoLegAtomicUnsignedTransactionBuilder();
const plan = builder.build({
  decision,
  orcaLeg: leg('ORCA', 'BUY'),
  raydiumLeg: leg('RAYDIUM', 'SELL'),
  feePayer: KEY,
  recentBlockhash: KEY
});
assert.equal(plan.atomic, true);
assert.equal(plan.leg_count, 2);
assert.equal(plan.token_mint, TOKEN);
assert.equal(plan.quote_mint, QUOTE);
assert.equal(plan.notional_usdc, 10);
assert.equal(plan.buy_dex, 'ORCA');
assert.equal(plan.sell_dex, 'RAYDIUM');
assert.equal(plan.signed, false);
assert.equal(plan.network_submission_authorized, false);
assert.ok(plan.unsigned_transaction_base64.length > 0);
assert.match(plan.message_hash, /^[0-9a-f]{64}$/);
assert.match(plan.transaction_hash, /^[0-9a-f]{64}$/);

assert.throws(() => builder.build({
  decision,
  orcaLeg: { ...leg('ORCA', 'BUY'), transaction_signed: true },
  raydiumLeg: leg('RAYDIUM', 'SELL'), feePayer: KEY, recentBlockhash: KEY
}), /verified_unsigned_leg_required/);
assert.throws(() => builder.build({
  decision,
  orcaLeg: { ...leg('ORCA', 'BUY'), token_mint: QUOTE },
  raydiumLeg: leg('RAYDIUM', 'SELL'), feePayer: KEY, recentBlockhash: KEY
}), /token_mint_mismatch/);

console.log('two-leg atomic unsigned transaction builder regression: PASS');
