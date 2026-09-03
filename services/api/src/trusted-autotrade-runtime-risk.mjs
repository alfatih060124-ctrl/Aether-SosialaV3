const MAX_SECONDS_SINCE_DECISION = 365 * 24 * 60 * 60;

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function money(value, error) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(error);
  return Math.round(n * 100) / 100;
}

function requireTokenMint(assessment) {
  const mint = String(assessment?.token_mint || '').trim();
  if (!mint) throw new Error('autotrade_token_mint_required');
  return mint;
}

function requirePortfolio(portfolio, walletAddress) {
  if (!portfolio || typeof portfolio !== 'object' || Array.isArray(portfolio)) throw new Error('autotrade_wallet_portfolio_required');
  if (portfolio.wallet !== walletAddress) throw new Error('autotrade_wallet_portfolio_mismatch');
  if (portfolio.base_currency !== 'USDC') throw new Error('autotrade_usdc_base_currency_required');
  if (portfolio.read_only !== true || portfolio.non_custodial !== true) throw new Error('autotrade_wallet_portfolio_safety_invalid');
  if (portfolio.signer_required !== false || portfolio.transaction_created !== false || portfolio.funds_moved !== false || portfolio.live_execution_authorized !== false) {
    throw new Error('autotrade_wallet_portfolio_safety_invalid');
  }
  const usdc = money(portfolio?.balances?.usdc?.amount, 'autotrade_usdc_balance_invalid');
  if (usdc <= 0) throw new Error('autotrade_usdc_balance_required');
  return { portfolio, usdc };
}

export function createTrustedAutoTradeRuntimeRiskResolver({
  pool,
  portfolioService,
  walletAddress,
  env = process.env,
  now = () => new Date()
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('autotrade_risk_pool_required');
  if (!portfolioService || typeof portfolioService.getPortfolio !== 'function') throw new Error('autotrade_portfolio_service_required');
  if (typeof walletAddress !== 'string' || walletAddress.trim() === '') throw new Error('autotrade_session_wallet_required');
  const wallet = walletAddress.trim();

  return async function resolveTrustedRuntimeRisk(context = {}) {
    const followerUserId = String(context.authenticated_follower_user_id || '').trim();
    const policyId = String(context.policy_id || '').trim();
    if (!followerUserId) throw new Error('authenticated_follower_user_id_required');
    if (!policyId) throw new Error('policy_id_required');
    const tokenMint = requireTokenMint(context.assessment);
    const observedNow = now();
    if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) throw new Error('autotrade_risk_clock_invalid');
    const utcStart = new Date(Date.UTC(observedNow.getUTCFullYear(), observedNow.getUTCMonth(), observedNow.getUTCDate()));

    const [portfolioResult, reservationResult, historyResult] = await Promise.all([
      portfolioService.getPortfolio(wallet),
      pool.query(
        `SELECT COALESCE(SUM(max_position_amount_usd),0) AS reserved_usd
           FROM copy_policies
          WHERE follower_user_id=$1
            AND policy_id<>$2
            AND enabled=true
            AND status='ACTIVE'
            AND mode='SHADOW'
            AND live_execution_authorized=false`,
        [followerUserId, policyId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS decisions_today, MAX(created_at) AS last_decision_at
           FROM auto_trade_decisions
          WHERE mandate->>'mandate_id'=$1
            AND created_at >= $2`,
        [policyId, utcStart.toISOString()]
      )
    ]);

    const { portfolio, usdc } = requirePortfolio(portfolioResult, wallet);
    const reservedOther = money(reservationResult?.rows?.[0]?.reserved_usd ?? 0, 'autotrade_reservation_balance_invalid');
    const available = Math.max(0, Math.round((usdc - reservedOther) * 100) / 100);
    const decisionsToday = Math.max(0, Number(historyResult?.rows?.[0]?.decisions_today) || 0);
    const lastDecision = historyResult?.rows?.[0]?.last_decision_at ? new Date(historyResult.rows[0].last_decision_at) : null;
    const secondsSinceLast = lastDecision && !Number.isNaN(lastDecision.getTime())
      ? Math.min(MAX_SECONDS_SINCE_DECISION, Math.max(0, Math.floor((observedNow.getTime() - lastDecision.getTime()) / 1000)))
      : MAX_SECONDS_SINCE_DECISION;

    return Object.freeze({
      capital_limit_usd: usdc,
      available_capital_usd: available,
      daily_realized_pnl_usd: 0,
      trades_today: decisionsToday,
      max_trades_per_day: boundedInt(env.AUTOTRADE_DEFAULT_MAX_TRADES_PER_DAY, 6, 1, 100),
      cooldown_seconds: boundedInt(env.AUTOTRADE_DEFAULT_COOLDOWN_SECONDS, 1800, 0, 30 * 24 * 60 * 60),
      seconds_since_last_trade: secondsSinceLast,
      min_signal_score: boundedNumber(env.SIGNAL_MIN_SCORE, 82, 0, 100),
      exit_quality_floor: boundedNumber(env.AUTOTRADE_EXIT_QUALITY_FLOOR, 55, 0, 100),
      allowed_tokens: Object.freeze([tokenMint]),
      risk_metadata: Object.freeze({
        risk_source: 'SESSION_WALLET_USDC_AND_DECISION_HISTORY',
        base_currency: 'USDC',
        wallet_binding: 'AUTHENTICATED_SESSION_PRIMARY_WALLET',
        portfolio_observed_at: portfolio.observed_at || null,
        other_active_mandate_reservations_usd: reservedOther,
        daily_pnl_accounting_ready: false,
        read_only: true,
        non_custodial: true,
        execution_dispatched: false,
        live_execution_authorized: false,
        network_submission_authorized: false,
        signer_required: false
      })
    });
  };
}
