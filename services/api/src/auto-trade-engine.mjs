const finite = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeAutoTradeMandate(mandate = {}, env = process.env) {
  const capital = Math.max(0, finite(mandate.capital_limit_usd, 0));
  const maxTradeDefault = capital > 0 ? capital * 0.1 : 0;
  return {
    enabled: mandate.enabled === true,
    mode: String(mandate.mode || 'SHADOW').toUpperCase(),
    capital_limit_usd: capital,
    available_capital_usd: Math.max(0, finite(mandate.available_capital_usd, capital)),
    max_trade_usd: Math.max(0, finite(mandate.max_trade_usd, maxTradeDefault)),
    max_allocation_bps: clamp(finite(mandate.max_allocation_bps, 1000), 1, 10000),
    max_daily_loss_usd: Math.max(0, finite(mandate.max_daily_loss_usd, capital * 0.02)),
    daily_realized_pnl_usd: finite(mandate.daily_realized_pnl_usd, 0),
    max_trades_per_day: Math.max(1, Math.floor(finite(mandate.max_trades_per_day, finite(env.AUTOTRADE_DEFAULT_MAX_TRADES_PER_DAY, 6)))),
    trades_today: Math.max(0, Math.floor(finite(mandate.trades_today, 0))),
    cooldown_seconds: Math.max(0, finite(mandate.cooldown_seconds, finite(env.AUTOTRADE_DEFAULT_COOLDOWN_SECONDS, 1800))),
    seconds_since_last_trade: finite(mandate.seconds_since_last_trade, Infinity),
    max_slippage_bps: Math.max(1, finite(mandate.max_slippage_bps, 100)),
    min_signal_score: clamp(finite(mandate.min_signal_score, finite(env.SIGNAL_MIN_SCORE, 82)), 0, 100),
    stop_loss_bps: Math.max(1, finite(mandate.stop_loss_bps, finite(env.AUTOTRADE_DEFAULT_STOP_LOSS_BPS, 500))),
    trailing_stop_bps: Math.max(1, finite(mandate.trailing_stop_bps, finite(env.AUTOTRADE_DEFAULT_TRAILING_STOP_BPS, 350))),
    exit_quality_floor: clamp(finite(mandate.exit_quality_floor, 55), 0, 100),
    allowed_tokens: Array.isArray(mandate.allowed_tokens) ? mandate.allowed_tokens.map(String) : []
  };
}

function positionMetrics(position = {}) {
  const sizeUsd = Math.max(0, finite(position.position_value_usd, 0));
  const entry = finite(position.entry_price_usd, null);
  const current = finite(position.current_price_usd, null);
  const peak = finite(position.peak_price_usd, current);
  const pnlBps = finite(position.unrealized_pnl_bps, entry && current ? ((current / entry) - 1) * 10000 : 0);
  const drawdownFromPeakBps = peak && current ? ((current / peak) - 1) * 10000 : 0;
  return { hasPosition: sizeUsd > 0, sizeUsd, entry, current, peak, pnlBps, drawdownFromPeakBps };
}

function sellPathSafe(assessment, mandate) {
  const snapshot = assessment?.snapshot || {};
  return snapshot.sell_simulation_ok === true && finite(snapshot.estimated_price_impact_bps, Infinity) <= mandate.max_slippage_bps;
}

export function evaluateAutoTrade({ assessment, mandate: rawMandate = {}, position = {}, runtime = {} } = {}) {
  const mandate = normalizeAutoTradeMandate(rawMandate, runtime.env);
  const metrics = positionMetrics(position);
  const tokenMint = assessment?.token_mint || assessment?.snapshot?.token_mint || null;
  const common = {
    source_type: 'ALGORITHMIC_STRATEGY',
    token_mint: tokenMint,
    mode: 'SHADOW',
    live_execution_authorized: false,
    quality_first: true
  };

  if (!assessment) return { ...common, action: 'REJECT', reason_codes: ['SIGNAL_ASSESSMENT_REQUIRED'], requested_amount_usd: 0 };
  if (!mandate.enabled) return { ...common, action: 'HOLD', reason_codes: ['AUTOTRADE_DISABLED'], requested_amount_usd: 0 };
  if (mandate.mode !== 'SHADOW') return { ...common, action: 'REJECT', reason_codes: ['NON_SHADOW_MODE_BLOCKED'], requested_amount_usd: 0 };
  if (runtime.liveEnabled === true) return { ...common, action: 'REJECT', reason_codes: ['LIVE_AUTOTRADE_FAIL_CLOSED'], requested_amount_usd: 0 };
  if (mandate.allowed_tokens.length && !mandate.allowed_tokens.includes(String(tokenMint))) {
    return { ...common, action: metrics.hasPosition ? 'HOLD' : 'REJECT', reason_codes: ['TOKEN_NOT_ALLOWED'], requested_amount_usd: 0 };
  }

  if (metrics.hasPosition) {
    const exitReasons = [];
    if (metrics.pnlBps <= -mandate.stop_loss_bps) exitReasons.push('STOP_LOSS');
    if (metrics.drawdownFromPeakBps <= -mandate.trailing_stop_bps && metrics.peak > metrics.entry) exitReasons.push('TRAILING_STOP');
    if (assessment.verdict === 'REJECTED') exitReasons.push('SIGNAL_HARD_DETERIORATION');
    if (finite(assessment.quality_score, 0) < mandate.exit_quality_floor) exitReasons.push('QUALITY_FLOOR_BREACHED');
    const momentum5m = finite(assessment.snapshot?.momentum_5m_bps, 0);
    const momentum1h = finite(assessment.snapshot?.momentum_1h_bps, 0);
    if (metrics.pnlBps > 100 && momentum5m <= -150 && momentum1h < 0) exitReasons.push('MOMENTUM_REVERSAL_PROFIT_PROTECTION');

    if (exitReasons.length) {
      if (!sellPathSafe(assessment, mandate)) {
        return { ...common, action: 'HOLD', reason_codes: [...exitReasons, 'EXIT_BLOCKED_UNSAFE_SELL_PATH'], requested_amount_usd: 0, risk_alert: true };
      }
      return { ...common, action: 'SELL', reason_codes: exitReasons, requested_amount_usd: metrics.sizeUsd };
    }
    return { ...common, action: 'HOLD', reason_codes: ['POSITION_HEALTHY'], requested_amount_usd: 0 };
  }

  const entryRejects = [];
  if (assessment.verdict !== 'QUALIFIED') entryRejects.push('SIGNAL_NOT_QUALIFIED');
  if (finite(assessment.quality_score, 0) < mandate.min_signal_score) entryRejects.push('QUALITY_SCORE_BELOW_MANDATE');
  if (mandate.max_daily_loss_usd > 0 && mandate.daily_realized_pnl_usd <= -mandate.max_daily_loss_usd) entryRejects.push('DAILY_LOSS_LIMIT_REACHED');
  if (mandate.trades_today >= mandate.max_trades_per_day) entryRejects.push('DAILY_TRADE_LIMIT_REACHED');
  if (mandate.seconds_since_last_trade < mandate.cooldown_seconds) entryRejects.push('COOLDOWN_ACTIVE');
  if (finite(assessment.snapshot?.estimated_price_impact_bps, Infinity) > mandate.max_slippage_bps) entryRejects.push('MANDATE_SLIPPAGE_LIMIT');
  if (assessment.snapshot?.sell_simulation_ok !== true) entryRejects.push('SELL_PATH_NOT_VERIFIED');
  if (entryRejects.length) return { ...common, action: 'REJECT', reason_codes: [...new Set(entryRejects)], requested_amount_usd: 0 };

  const allocationCap = mandate.capital_limit_usd * (mandate.max_allocation_bps / 10000);
  const requested = Math.min(mandate.max_trade_usd, allocationCap, mandate.available_capital_usd);
  if (!Number.isFinite(requested) || requested <= 0) return { ...common, action: 'REJECT', reason_codes: ['NO_EXECUTION_BUDGET'], requested_amount_usd: 0 };

  return {
    ...common,
    action: 'BUY',
    reason_codes: ['STRICT_SIGNAL_QUALIFIED', 'MANDATE_LIMITS_PASSED'],
    requested_amount_usd: Math.round(requested * 100) / 100
  };
}
