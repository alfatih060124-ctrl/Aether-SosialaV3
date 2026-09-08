const MIN_USDC_ATOMIC = 50_000_000n;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function date(value, code) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed;
}

function positiveAtomic(value, code) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function usdcRawFromPortfolio(portfolio) {
  const balance = portfolio?.balances?.usdc;
  if (!balance) return { verified: true, amount_atomic: 0n, decimals: 6 };
  const decimals = Number(balance.decimals);
  if (decimals !== 6 || balance.raw_balance_verified !== true || balance.mint !== USDC_MINT) {
    return { verified: false, amount_atomic: 0n, decimals };
  }
  try {
    const amount = BigInt(String(balance.amount_raw));
    if (amount < 0n) return { verified: false, amount_atomic: 0n, decimals };
    return { verified: true, amount_atomic: amount, decimals };
  } catch {
    return { verified: false, amount_atomic: 0n, decimals };
  }
}

async function loadAuthority(pool, session, current) {
  const activeResult = await pool.query(`
    SELECT authority_id, wallet_address, status, allowed_strategy, allowed_dex_pair,
           min_net_edge_bps, max_notional_usdc_atomic, max_daily_loss_usdc_atomic, expires_at
    FROM member_delegated_authorities
    WHERE user_id=$1
      AND wallet_address=$2
      AND status='ACTIVE'
      AND allowed_strategy='TWO_LEG_ARBITRAGE'
      AND allowed_dex_pair='ORCA_RAYDIUM'
      AND min_net_edge_bps >= 20
      AND expires_at > $3
    ORDER BY expires_at DESC, created_at DESC
    LIMIT 1
  `, [session.user_id, session.primary_wallet, current.toISOString()]);
  if (activeResult.rows[0]) return activeResult.rows[0];

  const latestResult = await pool.query(`
    SELECT authority_id, wallet_address, status, allowed_strategy, allowed_dex_pair,
           min_net_edge_bps, max_notional_usdc_atomic, max_daily_loss_usdc_atomic, expires_at
    FROM member_delegated_authorities
    WHERE user_id=$1
    ORDER BY created_at DESC
    LIMIT 1
  `, [session.user_id]);
  return latestResult.rows[0] || null;
}

export async function evaluateMemberLiveFundingPreflight(pool, session, {
  portfolioService,
  now = new Date(),
  minSolReserveLamports = process.env.LIVE_MIN_SOL_RESERVE_LAMPORTS
} = {}) {
  if (!pool) throw new Error('database_unconfigured');
  if (!session?.user_id || !session?.primary_wallet) throw new Error('session_required');
  if (!portfolioService || typeof portfolioService.getPortfolio !== 'function') throw new Error('portfolio_service_required');
  const current = date(now, 'live_preflight_now_invalid');
  const blockers = [];

  const subscriptionResult = await pool.query(`
    SELECT subscription_id, status, service_started_at, service_expires_at
    FROM member_subscriptions
    WHERE user_id=$1
    ORDER BY service_expires_at DESC
    LIMIT 1
  `, [session.user_id]);
  const subscription = subscriptionResult.rows[0] || null;
  const subscriptionActive = Boolean(subscription && subscription.status === 'ACTIVE' && new Date(subscription.service_expires_at) > current);
  if (!subscriptionActive) blockers.push('SUBSCRIPTION_INACTIVE');

  const authority = await loadAuthority(pool, session, current);
  if (!authority) blockers.push('DELEGATED_AUTHORITY_MISSING');
  else {
    if (authority.status !== 'ACTIVE') blockers.push('DELEGATED_AUTHORITY_INACTIVE');
    if (new Date(authority.expires_at) <= current) blockers.push('DELEGATED_AUTHORITY_EXPIRED');
    if (authority.wallet_address !== session.primary_wallet) blockers.push('DELEGATED_AUTHORITY_WALLET_MISMATCH');
    if (authority.allowed_strategy !== 'TWO_LEG_ARBITRAGE' || authority.allowed_dex_pair !== 'ORCA_RAYDIUM' || Number(authority.min_net_edge_bps) < 20) blockers.push('DELEGATED_AUTHORITY_SCOPE_INVALID');
  }

  const portfolio = await portfolioService.getPortfolio(session.primary_wallet, { force: true });
  if (portfolio?.source !== 'SOLANA_RPC' || portfolio?.read_only !== true || portfolio?.wallet !== session.primary_wallet) blockers.push('PORTFOLIO_EVIDENCE_INVALID');

  const usdc = usdcRawFromPortfolio(portfolio);
  if (!usdc.verified) blockers.push('USDC_BALANCE_UNVERIFIED');
  else if (usdc.amount_atomic < MIN_USDC_ATOMIC) blockers.push('USDC_BELOW_50_MINIMUM');

  let reserveThreshold = null;
  try { reserveThreshold = positiveAtomic(minSolReserveLamports, 'live_min_sol_reserve_unconfigured'); }
  catch { blockers.push('SOL_FEE_RESERVE_THRESHOLD_UNCONFIGURED'); }

  let solLamports = 0n;
  try { solLamports = BigInt(String(portfolio?.balances?.sol?.lamports)); }
  catch { blockers.push('SOL_BALANCE_UNVERIFIED'); }
  if (reserveThreshold !== null && solLamports < reserveThreshold) blockers.push('SOL_FEE_RESERVE_BELOW_MINIMUM');

  return Object.freeze({
    schema: 'aether.member_live_funding_preflight.v1',
    checked_at: current.toISOString(),
    wallet_address: session.primary_wallet,
    subscription: subscription ? {
      subscription_id: subscription.subscription_id,
      active: subscriptionActive,
      service_expires_at: new Date(subscription.service_expires_at).toISOString()
    } : null,
    delegated_authority: authority ? {
      authority_id: authority.authority_id,
      status: authority.status,
      expires_at: new Date(authority.expires_at).toISOString(),
      max_notional_usdc_atomic: String(authority.max_notional_usdc_atomic),
      max_daily_loss_usdc_atomic: String(authority.max_daily_loss_usdc_atomic)
    } : null,
    funding: {
      usdc_mint: USDC_MINT,
      usdc_balance_atomic: usdc.verified ? usdc.amount_atomic.toString() : null,
      minimum_usdc_atomic: MIN_USDC_ATOMIC.toString(),
      sol_balance_lamports: solLamports.toString(),
      minimum_sol_reserve_lamports: reserveThreshold?.toString() || null,
      source: portfolio?.source || null,
      observed_at: portfolio?.observed_at || null,
      read_only: true
    },
    blockers: Object.freeze(blockers),
    funding_preflight_passed: blockers.length === 0,
    transaction_submission_authorized: false,
    signer_authorized: false,
    fund_movement_authorized: false,
    live_execution_authorized: false,
    fail_closed: true
  });
}

export const MEMBER_LIVE_FUNDING_PREFLIGHT = Object.freeze({
  minimum_usdc_atomic: MIN_USDC_ATOMIC.toString(),
  minimum_usdc: '50',
  sol_reserve_threshold_source: 'LIVE_MIN_SOL_RESERVE_LAMPORTS',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  live_execution_authorized: false
});
