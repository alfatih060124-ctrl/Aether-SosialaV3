const SUPPORTED_DURATIONS = Object.freeze([30, 90, 180, 360]);

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function int(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) throw new Error(code);
  return numeric;
}

function atomic(value, code) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function isoOrNull(value, code) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
}

export function normalizeDynamicSubscriptionPrice(raw = {}) {
  const durationDays = int(raw.duration_days, 'subscription_duration_invalid', { min: 1, max: 366 });
  if (!SUPPORTED_DURATIONS.includes(durationDays)) throw new Error('subscription_duration_unsupported');
  const base = atomic(raw.base_price_usdc_atomic, 'subscription_base_price_invalid');
  const discountBps = int(raw.discount_bps ?? 0, 'subscription_discount_bps_invalid', { min: 0, max: 10_000 });
  const finalPrice = base * BigInt(10_000 - discountBps) / 10_000n;
  if (finalPrice <= 0n) throw new Error('subscription_final_price_invalid');
  const promoEnabled = raw.promo_enabled === true;
  const promoStart = isoOrNull(raw.promo_start, 'subscription_promo_start_invalid');
  const promoEnd = isoOrNull(raw.promo_end, 'subscription_promo_end_invalid');
  if (promoEnabled && (!promoStart || !promoEnd || Date.parse(promoStart) >= Date.parse(promoEnd))) {
    throw new Error('subscription_promo_window_invalid');
  }
  return Object.freeze({
    price_id: text(raw.price_id, 'subscription_price_id_required'),
    duration_days: durationDays,
    base_price_usdc_atomic: base.toString(),
    discount_bps: discountBps,
    final_price_usdc_atomic: finalPrice.toString(),
    promo_enabled: promoEnabled,
    promo_start: promoStart,
    promo_end: promoEnd,
    active: raw.active === true,
    price_version: int(raw.price_version, 'subscription_price_version_invalid', { min: 1 }),
    currency: 'USDC',
    network: 'SOLANA'
  });
}

export function isDynamicSubscriptionPriceEffective(price, now = new Date()) {
  const normalized = normalizeDynamicSubscriptionPrice(price);
  if (!normalized.active) return false;
  if (!normalized.promo_enabled) return true;
  const current = now instanceof Date ? now : new Date(now);
  const ts = current.getTime();
  if (!Number.isFinite(ts)) throw new Error('subscription_now_invalid');
  return ts >= Date.parse(normalized.promo_start) && ts < Date.parse(normalized.promo_end);
}

export function selectEffectiveSubscriptionPrice(prices, durationDays, now = new Date()) {
  if (!Array.isArray(prices)) throw new Error('subscription_prices_required');
  const duration = int(durationDays, 'subscription_duration_invalid', { min: 1, max: 366 });
  if (!SUPPORTED_DURATIONS.includes(duration)) throw new Error('subscription_duration_unsupported');
  const eligible = prices
    .map(normalizeDynamicSubscriptionPrice)
    .filter(price => price.duration_days === duration && isDynamicSubscriptionPriceEffective(price, now))
    .sort((a, b) => b.price_version - a.price_version);
  if (!eligible.length) throw new Error('subscription_price_unavailable');
  return eligible[0];
}

export function createSubscriptionQuote({ quote_id, user_id, member_wallet, price, quoted_at, expires_at }) {
  const normalized = normalizeDynamicSubscriptionPrice(price);
  const quoted = new Date(text(quoted_at, 'subscription_quoted_at_required'));
  const expires = new Date(text(expires_at, 'subscription_expires_at_required'));
  if (!Number.isFinite(quoted.getTime()) || !Number.isFinite(expires.getTime()) || expires <= quoted) {
    throw new Error('subscription_quote_window_invalid');
  }
  if (!isDynamicSubscriptionPriceEffective(normalized, quoted)) {
    throw new Error(normalized.active ? 'subscription_price_not_effective' : 'subscription_price_inactive');
  }
  return Object.freeze({
    quote_id: text(quote_id, 'subscription_quote_id_required'),
    user_id: text(user_id, 'subscription_user_id_required'),
    member_wallet: text(member_wallet, 'subscription_member_wallet_required'),
    price_id: normalized.price_id,
    price_version: normalized.price_version,
    duration_days: normalized.duration_days,
    base_price_usdc_atomic: normalized.base_price_usdc_atomic,
    discount_bps: normalized.discount_bps,
    final_price_usdc_atomic: normalized.final_price_usdc_atomic,
    currency: 'USDC',
    network: 'SOLANA',
    quoted_at: quoted.toISOString(),
    expires_at: expires.toISOString(),
    status: 'PENDING_PAYMENT'
  });
}

export const DYNAMIC_SUBSCRIPTION_CONTRACT = Object.freeze({
  durations_days: SUPPORTED_DURATIONS,
  server_authoritative: true,
  prospective_only: true,
  versioned_pricing: true,
  client_price_override_allowed: false,
  payment_asset: 'USDC',
  payment_network: 'SOLANA',
  live_execution_authorized: false
});
