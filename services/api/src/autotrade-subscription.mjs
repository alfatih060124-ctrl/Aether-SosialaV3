export const AETHER_SUBSCRIPTION_TREASURY_CANDIDATE = 'DPwJ2m52bmFV5ghDT3dVeDTrv1aSQste5jTxPEsqGTJt';
export const USDC_DECIMALS = 6;

export const AUTO_TRADE_PACKAGES = Object.freeze({
  DAYS_30: Object.freeze({ package_id: 'DAYS_30', duration_days: 30, base_price_usdc_atomic: 35_000_000n, discount_bps: 0, price_usdc_atomic: 35_000_000n }),
  DAYS_90: Object.freeze({ package_id: 'DAYS_90', duration_days: 90, base_price_usdc_atomic: 105_000_000n, discount_bps: 1500, price_usdc_atomic: 89_250_000n }),
  DAYS_180: Object.freeze({ package_id: 'DAYS_180', duration_days: 180, base_price_usdc_atomic: 210_000_000n, discount_bps: 2500, price_usdc_atomic: 157_500_000n }),
  DAYS_360: Object.freeze({ package_id: 'DAYS_360', duration_days: 360, base_price_usdc_atomic: 420_000_000n, discount_bps: 3500, price_usdc_atomic: 273_000_000n })
});

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name}_required`);
  return value.trim();
}

function requirePackage(packageId) {
  const pkg = AUTO_TRADE_PACKAGES[packageId];
  if (!pkg) throw new Error('unsupported_package');
  return pkg;
}

function requireIsoDate(value, name) {
  const text = requireText(value, name);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${name}_invalid`);
  return date;
}

export function createSubscriptionOrder({ order_id, user_id, member_wallet, package_id, service_authorized, created_at }) {
  if (service_authorized !== true) throw new Error('service_authorization_required');
  const pkg = requirePackage(package_id);
  const created = requireIsoDate(created_at, 'created_at');

  return Object.freeze({
    order_id: requireText(order_id, 'order_id'),
    user_id: requireText(user_id, 'user_id'),
    member_wallet: requireText(member_wallet, 'member_wallet'),
    package_id: pkg.package_id,
    duration_days: pkg.duration_days,
    base_price_usdc_atomic: pkg.base_price_usdc_atomic.toString(),
    discount_bps: pkg.discount_bps,
    expected_price_usdc_atomic: pkg.price_usdc_atomic.toString(),
    payment_network: 'SOLANA',
    payment_asset: 'USDC',
    status: 'PENDING_PAYMENT',
    created_at: created.toISOString()
  });
}

export function verifyUsdcSubscriptionPayment({
  order,
  payment,
  configured_treasury_wallet,
  configured_usdc_mint,
  verified_at,
  signature_already_used = false
}) {
  if (!order || order.status !== 'PENDING_PAYMENT') throw new Error('order_not_pending_payment');
  if (!payment || typeof payment !== 'object') throw new Error('payment_evidence_required');
  if (signature_already_used === true) throw new Error('payment_signature_already_used');

  const treasury = requireText(configured_treasury_wallet, 'configured_treasury_wallet');
  const usdcMint = requireText(configured_usdc_mint, 'configured_usdc_mint');
  if (treasury !== AETHER_SUBSCRIPTION_TREASURY_CANDIDATE) throw new Error('treasury_not_approved');

  const signature = requireText(payment.signature, 'payment_signature');
  if (payment.finalized !== true) throw new Error('payment_not_finalized');
  if (payment.success !== true) throw new Error('payment_transaction_failed');
  if (requireText(payment.sender_wallet, 'payment_sender_wallet') !== order.member_wallet) throw new Error('payment_sender_mismatch');
  if (requireText(payment.recipient_wallet, 'payment_recipient_wallet') !== treasury) throw new Error('payment_recipient_mismatch');
  if (requireText(payment.mint, 'payment_mint') !== usdcMint) throw new Error('payment_mint_mismatch');

  const receivedAtomic = BigInt(requireText(String(payment.amount_usdc_atomic), 'payment_amount_usdc_atomic'));
  const expectedAtomic = BigInt(order.expected_price_usdc_atomic);
  if (receivedAtomic !== expectedAtomic) throw new Error('payment_amount_mismatch');

  const verified = requireIsoDate(verified_at, 'verified_at');
  const expires = new Date(verified.getTime() + (order.duration_days * 86_400_000));

  return Object.freeze({
    ...order,
    status: 'SERVICE_ACTIVE',
    payment_status: 'PAYMENT_VERIFIED',
    payment_signature: signature,
    payment_mint: usdcMint,
    payment_recipient_wallet: treasury,
    paid_price_usdc_atomic: receivedAtomic.toString(),
    payment_verified_at: verified.toISOString(),
    service_started_at: verified.toISOString(),
    service_expires_at: expires.toISOString(),
    live_subscription_eligible: true
  });
}

export function getSubscriptionAccess(subscription, now = new Date()) {
  if (!subscription || subscription.status !== 'SERVICE_ACTIVE') {
    return Object.freeze({ paper_access: true, live_service_access: false, reason: 'ACTIVE_SUBSCRIPTION_REQUIRED' });
  }

  const current = now instanceof Date ? now : new Date(now);
  const expires = new Date(subscription.service_expires_at);
  const active = Number.isFinite(current.getTime()) && Number.isFinite(expires.getTime()) && current < expires;

  return Object.freeze({
    paper_access: true,
    live_service_access: active,
    reason: active ? 'ACTIVE_SUBSCRIPTION' : 'SUBSCRIPTION_EXPIRED'
  });
}
