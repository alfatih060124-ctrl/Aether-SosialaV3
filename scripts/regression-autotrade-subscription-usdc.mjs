import assert from 'node:assert/strict';
import {
  AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  AUTO_TRADE_PACKAGES,
  createSubscriptionOrder,
  verifyUsdcSubscriptionPayment,
  getSubscriptionAccess
} from '../services/api/src/autotrade-subscription.mjs';

const USDC_MINT = 'USDC_MINT_CONFIGURED_BY_ENV';
const wallet = 'MemberWallet111111111111111111111111111111';
const createdAt = '2026-09-05T02:30:00.000Z';

assert.equal(AUTO_TRADE_PACKAGES.DAYS_30.price_usdc_atomic, 35_000_000n);
assert.equal(AUTO_TRADE_PACKAGES.DAYS_90.price_usdc_atomic, 89_250_000n);
assert.equal(AUTO_TRADE_PACKAGES.DAYS_180.price_usdc_atomic, 157_500_000n);
assert.equal(AUTO_TRADE_PACKAGES.DAYS_360.price_usdc_atomic, 273_000_000n);

assert.throws(() => createSubscriptionOrder({
  order_id: 'ord-no-consent', user_id: 'u1', member_wallet: wallet,
  package_id: 'DAYS_30', service_authorized: false, created_at: createdAt
}), /service_authorization_required/);

const order = createSubscriptionOrder({
  order_id: 'ord-90', user_id: 'u1', member_wallet: wallet,
  package_id: 'DAYS_90', service_authorized: true, created_at: createdAt
});
assert.equal(order.status, 'PENDING_PAYMENT');
assert.equal(order.expected_price_usdc_atomic, '89250000');

const basePayment = {
  signature: 'sig-90-days',
  finalized: true,
  success: true,
  sender_wallet: wallet,
  recipient_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  mint: USDC_MINT,
  amount_usdc_atomic: '89250000'
};

assert.throws(() => verifyUsdcSubscriptionPayment({
  order,
  payment: { ...basePayment, amount_usdc_atomic: '89249999' },
  configured_treasury_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  configured_usdc_mint: USDC_MINT,
  verified_at: '2026-09-05T02:31:00.000Z'
}), /payment_amount_mismatch/);

assert.throws(() => verifyUsdcSubscriptionPayment({
  order,
  payment: { ...basePayment, recipient_wallet: 'WrongTreasury' },
  configured_treasury_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  configured_usdc_mint: USDC_MINT,
  verified_at: '2026-09-05T02:31:00.000Z'
}), /payment_recipient_mismatch/);

assert.throws(() => verifyUsdcSubscriptionPayment({
  order,
  payment: { ...basePayment, finalized: false },
  configured_treasury_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  configured_usdc_mint: USDC_MINT,
  verified_at: '2026-09-05T02:31:00.000Z'
}), /payment_not_finalized/);

assert.throws(() => verifyUsdcSubscriptionPayment({
  order,
  payment: basePayment,
  configured_treasury_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  configured_usdc_mint: USDC_MINT,
  verified_at: '2026-09-05T02:31:00.000Z',
  signature_already_used: true
}), /payment_signature_already_used/);

const active = verifyUsdcSubscriptionPayment({
  order,
  payment: basePayment,
  configured_treasury_wallet: AETHER_SUBSCRIPTION_TREASURY_CANDIDATE,
  configured_usdc_mint: USDC_MINT,
  verified_at: '2026-09-05T02:31:00.000Z'
});
assert.equal(active.status, 'SERVICE_ACTIVE');
assert.equal(active.payment_status, 'PAYMENT_VERIFIED');
assert.equal(active.service_started_at, '2026-09-05T02:31:00.000Z');
assert.equal(active.service_expires_at, '2026-12-04T02:31:00.000Z');
assert.equal(getSubscriptionAccess(null).paper_access, true);
assert.equal(getSubscriptionAccess(null).live_service_access, false);
assert.equal(getSubscriptionAccess(active, '2026-10-01T00:00:00.000Z').live_service_access, true);
assert.equal(getSubscriptionAccess(active, '2026-12-05T00:00:00.000Z').live_service_access, false);

console.log('autotrade subscription USDC regression: PASS');
