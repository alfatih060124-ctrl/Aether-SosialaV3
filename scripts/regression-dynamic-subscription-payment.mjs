import assert from 'node:assert/strict';
import {
  normalizeDynamicSubscriptionPrice,
  selectEffectiveSubscriptionPrice,
  createSubscriptionQuote,
  DYNAMIC_SUBSCRIPTION_CONTRACT
} from '../services/api/src/dynamic-subscription.mjs';
import {
  createSolanaUsdcSubscriptionPaymentVerifier,
  SOLANA_USDC_SUBSCRIPTION_PAYMENT_VERIFIER
} from '../services/api/src/solana-usdc-subscription-payment-verifier.mjs';

const now = new Date('2026-09-06T08:00:00.000Z');
const price = normalizeDynamicSubscriptionPrice({
  price_id: 'price-30-v2',
  duration_days: 30,
  base_price_usdc_atomic: '40000000',
  discount_bps: 1250,
  promo_enabled: true,
  promo_start: '2026-09-01T00:00:00.000Z',
  promo_end: '2026-09-30T00:00:00.000Z',
  active: true,
  price_version: 2
});
assert.equal(price.final_price_usdc_atomic, '35000000');
assert.equal(price.currency, 'USDC');
assert.equal(price.network, 'SOLANA');

const selected = selectEffectiveSubscriptionPrice([
  { ...price, price_id: 'price-30-v1', price_version: 1 },
  price
], 30, now);
assert.equal(selected.price_id, 'price-30-v2');

const quote = createSubscriptionQuote({
  quote_id: 'quote-1',
  user_id: 'user-1',
  member_wallet: 'MemberWallet111111111111111111111111111111',
  price,
  quoted_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
});
assert.equal(quote.final_price_usdc_atomic, '35000000');
assert.equal(quote.status, 'PENDING_PAYMENT');
assert.equal(DYNAMIC_SUBSCRIPTION_CONTRACT.client_price_override_allowed, false);

const signature = 'Sig111111111111111111111111111111111111111111111111111111111111111';
const memberWallet = quote.member_wallet;
const treasuryWallet = 'Treasury11111111111111111111111111111111111';
const usdcMint = 'USDC111111111111111111111111111111111111111';
const accountRows = (memberAmount, treasuryAmount) => [
  { mint: usdcMint, owner: memberWallet, uiTokenAmount: { amount: String(memberAmount) } },
  { mint: usdcMint, owner: treasuryWallet, uiTokenAmount: { amount: String(treasuryAmount) } }
];

const rpcReplies = {
  getSignatureStatuses: { value: [{ err: null, confirmationStatus: 'finalized' }] },
  getTransaction: {
    slot: 123456,
    blockTime: 1788681600,
    transaction: { signatures: [signature] },
    meta: {
      err: null,
      preTokenBalances: accountRows(100000000n, 500000000n),
      postTokenBalances: accountRows(65000000n, 535000000n)
    }
  }
};

const fetchImpl = async (_url, options) => {
  const body = JSON.parse(options.body);
  return {
    ok: true,
    async json() { return { jsonrpc: '2.0', id: 1, result: rpcReplies[body.method] }; }
  };
};

const verifier = createSolanaUsdcSubscriptionPaymentVerifier({
  rpcUrl: 'https://rpc.example.test',
  fetchImpl,
  configuredUsdcMint: usdcMint,
  configuredTreasuryWallet: treasuryWallet
});
const evidence = await verifier.verify({
  signature,
  member_wallet: memberWallet,
  expected_amount_usdc_atomic: quote.final_price_usdc_atomic
});
assert.equal(evidence.verified, true);
assert.equal(evidence.finalized, true);
assert.equal(evidence.amount_usdc_atomic, '35000000');
assert.equal(evidence.transaction_submission_authorized, false);
assert.equal(evidence.signing_authorized, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(SOLANA_USDC_SUBSCRIPTION_PAYMENT_VERIFIER.replay_protection_requires_unique_persistence, true);

await assert.rejects(
  verifier.verify({ signature, member_wallet: memberWallet, expected_amount_usdc_atomic: '34000000' }),
  /subscription_payment_sender_amount_mismatch/
);

assert.throws(() => normalizeDynamicSubscriptionPrice({
  ...price,
  duration_days: 60
}), /subscription_duration_unsupported/);

console.log(JSON.stringify({
  ok: true,
  schema: 'aether.dynamic_subscription_payment.regression.v1',
  durations: DYNAMIC_SUBSCRIPTION_CONTRACT.durations_days,
  finalized_required: SOLANA_USDC_SUBSCRIPTION_PAYMENT_VERIFIER.finalized_required,
  live_execution_authorized: false
}));
