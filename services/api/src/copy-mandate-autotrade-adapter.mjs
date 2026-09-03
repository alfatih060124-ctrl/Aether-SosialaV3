import { assertPersistedCopyMandateAllowsIntent } from './copy-mandate-runtime.mjs';

function safeNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || !Number.isSafeInteger(n * 100)) {
    throw new Error(`invalid_${field}`);
  }
  return n;
}

function safeInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid_${field}`);
  return n;
}

function trustedRuntimeRisk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('autotrade_runtime_risk_required');
  const capitalLimitUsd = safeNumber(input.capital_limit_usd, 'capital_limit_usd', { min: 0.01 });
  const availableCapitalUsd = safeNumber(input.available_capital_usd, 'available_capital_usd', { min: 0 });
  if (availableCapitalUsd > capitalLimitUsd) throw new Error('available_capital_exceeds_capital_limit');

  return Object.freeze({
    capital_limit_usd: capitalLimitUsd,
    available_capital_usd: availableCapitalUsd,
    daily_realized_pnl_usd: safeNumber(input.daily_realized_pnl_usd ?? 0, 'daily_realized_pnl_usd', { min: -Number.MAX_SAFE_INTEGER }),
    trades_today: safeInt(input.trades_today ?? 0, 'trades_today'),
    max_trades_per_day: safeInt(input.max_trades_per_day, 'max_trades_per_day', { min: 1, max: 1000 }),
    cooldown_seconds: safeInt(input.cooldown_seconds, 'cooldown_seconds', { min: 0, max: 86400 * 30 }),
    seconds_since_last_trade: safeInt(input.seconds_since_last_trade, 'seconds_since_last_trade', { min: 0, max: 86400 * 365 }),
    min_signal_score: safeNumber(input.min_signal_score, 'min_signal_score', { min: 0, max: 100 }),
    exit_quality_floor: safeNumber(input.exit_quality_floor, 'exit_quality_floor', { min: 0, max: 100 }),
    allowed_tokens: Array.isArray(input.allowed_tokens) ? Object.freeze(input.allowed_tokens.map((value) => String(value))) : Object.freeze([])
  });
}

function persistedBps(row, field, { min = 1, max = 10000 } = {}) {
  return safeInt(row?.[field], field, { min, max });
}

export function buildAutoTradeMandateFromPersisted(row, authenticatedFollowerUserId, runtimeRisk) {
  if (typeof authenticatedFollowerUserId !== 'string' || authenticatedFollowerUserId.trim() === '') {
    throw new Error('authenticated_follower_user_id_required');
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('copy_mandate_not_found');

  const boundary = assertPersistedCopyMandateAllowsIntent(row, {
    follower_user_id: authenticatedFollowerUserId.trim(),
    trader_id: String(row.trader_id || '')
  });
  const mandate = boundary.mandate;
  const risk = trustedRuntimeRisk(runtimeRisk);

  if (mandate.policy.type !== 'FIXED_USD') throw new Error('copy_mandate_policy_runtime_unsupported');

  const allocationBps = persistedBps(row, 'allocation_bps');
  const maxSlippageBps = persistedBps(row, 'max_slippage_bps', { max: 1000 });
  const maxDailyLossBps = persistedBps(row, 'max_daily_loss_bps', { max: 5000 });
  const stopDrawdownBps = persistedBps(row, 'stop_drawdown_bps', { max: 9000 });

  const capitalLimitUsd = Math.min(risk.capital_limit_usd, mandate.policy.max_position_amount_usd);
  const availableCapitalUsd = Math.min(risk.available_capital_usd, capitalLimitUsd);
  const maxTradeUsd = Math.min(mandate.policy.value, mandate.policy.max_copy_amount_usd, availableCapitalUsd);
  const maxDailyLossUsd = Math.round((capitalLimitUsd * maxDailyLossBps / 10000) * 100) / 100;

  return Object.freeze({
    schema: 'aether.autotrade.persisted_mandate_adapter.v1',
    mandate_id: mandate.mandate_id,
    follower_user_id: mandate.follower_user_id,
    trader_id: mandate.trader_id,
    consent_version: mandate.consent_version,
    consented_at: mandate.consented_at,
    authorization: boundary.authorization,
    engine_mandate: Object.freeze({
      enabled: true,
      mode: 'SHADOW',
      capital_limit_usd: capitalLimitUsd,
      available_capital_usd: availableCapitalUsd,
      max_trade_usd: maxTradeUsd,
      max_allocation_bps: allocationBps,
      max_daily_loss_usd: maxDailyLossUsd,
      daily_realized_pnl_usd: risk.daily_realized_pnl_usd,
      max_trades_per_day: risk.max_trades_per_day,
      trades_today: risk.trades_today,
      cooldown_seconds: risk.cooldown_seconds,
      seconds_since_last_trade: risk.seconds_since_last_trade,
      max_slippage_bps: maxSlippageBps,
      min_signal_score: risk.min_signal_score,
      stop_loss_bps: stopDrawdownBps,
      trailing_stop_bps: stopDrawdownBps,
      exit_quality_floor: risk.exit_quality_floor,
      allowed_tokens: risk.allowed_tokens
    }),
    audit_metadata: Object.freeze({
      mandate_schema: mandate.schema,
      adapter_schema: 'aether.autotrade.persisted_mandate_adapter.v1',
      policy_type: mandate.policy.type,
      policy_value: mandate.policy.value,
      max_copy_amount_usd: mandate.policy.max_copy_amount_usd,
      max_position_amount_usd: mandate.policy.max_position_amount_usd,
      allocation_bps: allocationBps,
      max_slippage_bps: maxSlippageBps,
      max_daily_loss_bps: maxDailyLossBps,
      stop_drawdown_bps: stopDrawdownBps,
      execution_mode: 'SHADOW',
      execution_scope: 'INTENT_ONLY',
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false,
      execution_dispatched: false
    }),
    execution_dispatched: false,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}
