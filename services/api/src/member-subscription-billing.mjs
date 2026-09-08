import { randomUUID } from 'node:crypto';
import {
  createSubscriptionQuote,
  selectEffectiveSubscriptionPrice,
  DYNAMIC_SUBSCRIPTION_CONTRACT
} from './dynamic-subscription.mjs';
import { createSolanaUsdcSubscriptionPaymentVerifier } from './solana-usdc-subscription-payment-verifier.mjs';

const DURATIONS = DYNAMIC_SUBSCRIPTION_CONTRACT.durations_days;
const QUOTE_TTL_MS = 15 * 60_000;

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function nowDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('subscription_now_invalid');
  return date;
}

function priceRow(row) {
  return {
    price_id: row.price_id,
    duration_days: Number(row.duration_days),
    base_price_usdc_atomic: String(row.base_price_usdc_atomic),
    discount_bps: Number(row.discount_bps),
    promo_enabled: row.promo_enabled === true,
    promo_start: row.promo_start ? new Date(row.promo_start).toISOString() : null,
    promo_end: row.promo_end ? new Date(row.promo_end).toISOString() : null,
    active: row.active === true,
    price_version: Number(row.price_version)
  };
}

async function loadPriceRows(pool) {
  const result = await pool.query(`
    SELECT price_id, duration_days, base_price_usdc_atomic, discount_bps,
           promo_enabled, promo_start, promo_end, active, price_version
    FROM subscription_price_versions
    ORDER BY duration_days, price_version DESC
  `);
  return result.rows.map(priceRow);
}

export async function getMemberSubscriptionOverview(pool, userId, { now = new Date() } = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const user = text(userId, 'subscription_user_id_required');
  const current = nowDate(now);
  const prices = await loadPriceRows(pool);
  const catalog = DURATIONS.map(duration => {
    try {
      const price = selectEffectiveSubscriptionPrice(prices, duration, current);
      return {
        duration_days: duration,
        available: true,
        price_id: price.price_id,
        price_version: price.price_version,
        base_price_usdc_atomic: price.base_price_usdc_atomic,
        discount_bps: price.discount_bps,
        final_price_usdc_atomic: price.final_price_usdc_atomic,
        promo_enabled: price.promo_enabled,
        promo_start: price.promo_start,
        promo_end: price.promo_end
      };
    } catch {
      return { duration_days: duration, available: false };
    }
  });

  const subscription = await pool.query(`
    SELECT subscription_id, service_started_at, service_expires_at, status
    FROM member_subscriptions
    WHERE user_id = $1
    ORDER BY service_expires_at DESC
    LIMIT 1
  `, [user]);
  const latest = subscription.rows[0] || null;
  const active = Boolean(latest && latest.status === 'ACTIVE' && new Date(latest.service_expires_at) > current);

  const order = await pool.query(`
    SELECT order_id, quote_id, duration_days, final_price_usdc_atomic,
           payment_recipient_wallet, payment_mint, quoted_at, quote_expires_at, status
    FROM subscription_orders
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [user]);
  const latestOrder = order.rows[0] || null;

  return Object.freeze({
    catalog,
    subscription: latest ? {
      subscription_id: latest.subscription_id,
      status: active ? 'ACTIVE' : latest.status,
      service_started_at: new Date(latest.service_started_at).toISOString(),
      service_expires_at: new Date(latest.service_expires_at).toISOString(),
      active
    } : null,
    latest_order: latestOrder ? {
      order_id: latestOrder.order_id,
      quote_id: latestOrder.quote_id,
      duration_days: Number(latestOrder.duration_days),
      final_price_usdc_atomic: String(latestOrder.final_price_usdc_atomic),
      payment_recipient_wallet: latestOrder.payment_recipient_wallet,
      payment_mint: latestOrder.payment_mint,
      quoted_at: new Date(latestOrder.quoted_at).toISOString(),
      expires_at: new Date(latestOrder.quote_expires_at).toISOString(),
      status: latestOrder.status
    } : null,
    payment_asset: 'USDC',
    payment_network: 'SOLANA',
    server_authoritative: true,
    live_execution_authorized: false
  });
}

export async function createMemberSubscriptionQuote(pool, session, {
  duration_days,
  configuredTreasuryWallet = process.env.SUBSCRIPTION_TREASURY_WALLET,
  configuredUsdcMint = process.env.SUBSCRIPTION_USDC_MINT,
  now = new Date(),
  quoteTtlMs = QUOTE_TTL_MS
} = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const userId = text(session?.user_id, 'session_required');
  const memberWallet = text(session?.primary_wallet, 'subscription_member_wallet_required');
  const treasury = text(configuredTreasuryWallet, 'subscription_treasury_wallet_required');
  const usdcMint = text(configuredUsdcMint, 'subscription_usdc_mint_required');
  const current = nowDate(now);
  const prices = await loadPriceRows(pool);
  const price = selectEffectiveSubscriptionPrice(prices, Number(duration_days), current);
  const quoteId = randomUUID();
  const orderId = randomUUID();
  const quote = createSubscriptionQuote({
    quote_id: quoteId,
    user_id: userId,
    member_wallet: memberWallet,
    price,
    quoted_at: current.toISOString(),
    expires_at: new Date(current.getTime() + Math.max(60_000, Math.min(60 * 60_000, Number(quoteTtlMs) || QUOTE_TTL_MS))).toISOString()
  });

  await pool.query(`
    INSERT INTO subscription_orders (
      order_id, quote_id, user_id, member_wallet, price_id, price_version, duration_days,
      base_price_usdc_atomic, discount_bps, final_price_usdc_atomic,
      payment_network, payment_asset, payment_recipient_wallet, payment_mint,
      status, quoted_at, quote_expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SOLANA','USDC',$11,$12,'PENDING_PAYMENT',$13,$14)
  `, [
    orderId, quote.quote_id, userId, memberWallet, quote.price_id, quote.price_version, quote.duration_days,
    quote.base_price_usdc_atomic, quote.discount_bps, quote.final_price_usdc_atomic,
    treasury, usdcMint, quote.quoted_at, quote.expires_at
  ]);

  return Object.freeze({
    order_id: orderId,
    ...quote,
    payment_recipient_wallet: treasury,
    payment_mint: usdcMint,
    payment_asset: 'USDC',
    payment_network: 'SOLANA',
    transaction_submission_authorized: false,
    signing_authorized: false,
    live_execution_authorized: false
  });
}

export async function verifyMemberSubscriptionPayment(pool, session, {
  order_id,
  signature,
  rpcUrl = process.env.SOLANA_RPC_URL,
  fetchImpl = globalThis.fetch,
  currentTreasuryWallet = process.env.SUBSCRIPTION_TREASURY_WALLET,
  currentUsdcMint = process.env.SUBSCRIPTION_USDC_MINT,
  now = new Date()
} = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const userId = text(session?.user_id, 'session_required');
  const memberWallet = text(session?.primary_wallet, 'subscription_member_wallet_required');
  const orderId = text(order_id, 'subscription_order_id_required');
  const txSignature = text(signature, 'subscription_payment_signature_required');
  const current = nowDate(now);

  const lookup = await pool.query(`
    SELECT * FROM subscription_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1
  `, [orderId, userId]);
  const order = lookup.rows[0];
  if (!order) throw new Error('subscription_order_not_found');
  if (order.status !== 'PENDING_PAYMENT') throw new Error('subscription_order_not_pending');
  if (order.member_wallet !== memberWallet) throw new Error('subscription_member_wallet_mismatch');
  if (current >= new Date(order.quote_expires_at)) throw new Error('subscription_quote_expired');

  const currentTreasury = text(currentTreasuryWallet, 'subscription_treasury_wallet_required');
  const currentMint = text(currentUsdcMint, 'subscription_usdc_mint_required');
  if (currentTreasury !== order.payment_recipient_wallet) throw new Error('subscription_treasury_configuration_changed');
  if (currentMint !== order.payment_mint) throw new Error('subscription_usdc_mint_configuration_changed');

  const verifier = createSolanaUsdcSubscriptionPaymentVerifier({
    rpcUrl,
    fetchImpl,
    configuredUsdcMint: order.payment_mint,
    configuredTreasuryWallet: order.payment_recipient_wallet
  });
  const evidence = await verifier.verify({
    signature: txSignature,
    member_wallet: memberWallet,
    expected_amount_usdc_atomic: String(order.final_price_usdc_atomic),
    quoted_at: new Date(order.quoted_at).toISOString(),
    expires_at: new Date(order.quote_expires_at).toISOString()
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM subscription_orders WHERE order_id = $1 AND user_id = $2 FOR UPDATE`, [orderId, userId]);
    const lockedOrder = locked.rows[0];
    if (!lockedOrder || lockedOrder.status !== 'PENDING_PAYMENT') throw new Error('subscription_order_not_pending');

    const previous = await client.query(`
      SELECT subscription_id, service_expires_at
      FROM member_subscriptions
      WHERE user_id = $1 AND status = 'ACTIVE'
      ORDER BY service_expires_at DESC
      LIMIT 1
      FOR UPDATE
    `, [userId]);
    const previousExpiry = previous.rows[0]?.service_expires_at ? new Date(previous.rows[0].service_expires_at) : null;
    const base = previousExpiry && previousExpiry > current ? previousExpiry : current;
    const expires = new Date(base.getTime() + Number(lockedOrder.duration_days) * 86_400_000);
    const paymentId = randomUUID();
    const subscriptionId = randomUUID();

    await client.query(`
      INSERT INTO subscription_payments (
        payment_id, order_id, signature, sender_wallet, recipient_wallet, mint,
        amount_usdc_atomic, slot, block_time, verification_source, source_reference, verified_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SOLANA_FINALIZED_RPC',$10,$11)
    `, [
      paymentId, orderId, evidence.signature, evidence.sender_wallet, evidence.recipient_wallet, evidence.mint,
      evidence.amount_usdc_atomic, evidence.slot, evidence.block_time, evidence.source_reference, current.toISOString()
    ]);

    await client.query(`UPDATE member_subscriptions SET status = 'EXPIRED' WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
    await client.query(`
      INSERT INTO member_subscriptions (
        subscription_id, user_id, order_id, payment_id, service_started_at, service_expires_at, status
      ) VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')
    `, [subscriptionId, userId, orderId, paymentId, current.toISOString(), expires.toISOString()]);
    await client.query(`UPDATE subscription_orders SET status = 'PAYMENT_VERIFIED' WHERE order_id = $1`, [orderId]);
    await client.query('COMMIT');

    return Object.freeze({
      verified: true,
      order_id: orderId,
      payment_id: paymentId,
      subscription_id: subscriptionId,
      service_started_at: current.toISOString(),
      service_expires_at: expires.toISOString(),
      status: 'ACTIVE',
      payment_evidence: evidence,
      funds_moved_by_aether: false,
      transaction_submission_authorized: false,
      signing_authorized: false,
      live_execution_authorized: false
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error?.code === '23505') throw new Error('subscription_payment_signature_already_used');
    throw error;
  } finally {
    client.release();
  }
}

export const MEMBER_SUBSCRIPTION_BILLING = Object.freeze({
  durations_days: DURATIONS,
  quote_ttl_ms: QUOTE_TTL_MS,
  payment_asset: 'USDC',
  payment_network: 'SOLANA',
  server_authoritative: true,
  replay_protection: 'UNIQUE_SIGNATURE',
  transaction_submission_authorized: false,
  signing_authorized: false,
  live_execution_authorized: false
});
