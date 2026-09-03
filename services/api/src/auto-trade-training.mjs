import { evaluateSignalQuality } from './signal-intelligence.mjs';
import { evaluateAutoTrade } from './auto-trade-engine.mjs';

const SCENARIOS = Object.freeze({
  qualified_entry: 'Qualified entry · BUY',
  healthy_position: 'Healthy position · HOLD',
  stop_loss_exit: 'Stop loss protection · SELL',
  trailing_stop_exit: 'Trailing stop protection · SELL',
  risk_reject: 'Unsafe market guardrail · REJECT',
});

const finite = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function qualifiedSnapshot(now) {
  return {
    token_mint: 'TRAINING_FIXTURE_SOLANA',
    quote_mint: 'TRAINING_FIXTURE_USDC',
    liquidity_usd: 5_000_000,
    volume_24h_usd: 3_000_000,
    spread_bps: 8,
    estimated_price_impact_bps: 15,
    expected_net_edge_bps: 25,
    net_edge_costs_included: true,
    top10_holder_pct: 12,
    token_age_hours: 240,
    route_count: 6,
    source_count: 5,
    volatility_1h_bps: 250,
    momentum_5m_bps: 300,
    momentum_1h_bps: 700,
    buy_sell_imbalance: 0.35,
    sell_simulation_ok: true,
    transferable: true,
    risk_flags: [],
    observed_at: new Date(now).toISOString(),
  };
}

function trainingScenario(key, now) {
  const snapshot = qualifiedSnapshot(now);
  if (key === 'risk_reject') {
    Object.assign(snapshot, {
      liquidity_usd: 120_000,
      volume_24h_usd: 75_000,
      spread_bps: 120,
      estimated_price_impact_bps: 240,
      expected_net_edge_bps: 2,
      top10_holder_pct: 61,
      token_age_hours: 3,
      route_count: 1,
      source_count: 1,
      volatility_1h_bps: 2400,
      sell_simulation_ok: false,
      risk_flags: ['TRAINING_UNSAFE_MARKET'],
    });
  }

  const positions = {
    qualified_entry: {},
    risk_reject: {},
    healthy_position: {
      position_value_usd: 50,
      entry_price_usd: 1,
      current_price_usd: 1.05,
      peak_price_usd: 1.07,
      unrealized_pnl_bps: 500,
    },
    stop_loss_exit: {
      position_value_usd: 50,
      entry_price_usd: 1,
      current_price_usd: 0.93,
      peak_price_usd: 1.03,
      unrealized_pnl_bps: -700,
    },
    trailing_stop_exit: {
      position_value_usd: 50,
      entry_price_usd: 1,
      current_price_usd: 1.08,
      peak_price_usd: 1.18,
      unrealized_pnl_bps: 800,
    },
  };

  return { snapshot, position: positions[key] || {} };
}

export function listAutoTradeTrainingScenarios() {
  return Object.entries(SCENARIOS).map(([id, label]) => ({ id, label }));
}

export function runAutoTradeTraining(input = {}, options = {}) {
  const scenario = String(input.scenario || 'qualified_entry').trim().toLowerCase();
  if (!SCENARIOS[scenario]) throw new Error('invalid_training_scenario');

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const capital = clamp(finite(input.capital_usd, 100), 10, 100_000);
  const allocationBps = clamp(Math.round(finite(input.max_allocation_bps, 1000)), 100, 10_000);
  const maxTradeUsd = clamp(finite(input.max_trade_usd, capital * 0.1), 1, capital);
  const dailyLossUsd = clamp(finite(input.max_daily_loss_usd, capital * 0.02), 0, capital);
  const maxSlippageBps = clamp(Math.round(finite(input.max_slippage_bps, 100)), 1, 1000);
  const minSignalScore = clamp(finite(input.min_signal_score, 82), 0, 100);
  const stopLossBps = clamp(Math.round(finite(input.stop_loss_bps, 500)), 1, 5000);
  const trailingStopBps = clamp(Math.round(finite(input.trailing_stop_bps, 350)), 1, 5000);

  const { snapshot, position } = trainingScenario(scenario, now);
  const assessment = evaluateSignalQuality(snapshot, { now });
  const mandate = {
    enabled: true,
    mode: 'SHADOW',
    capital_limit_usd: capital,
    available_capital_usd: capital,
    max_trade_usd: maxTradeUsd,
    max_allocation_bps: allocationBps,
    max_daily_loss_usd: dailyLossUsd,
    daily_realized_pnl_usd: 0,
    max_trades_per_day: 6,
    trades_today: 0,
    cooldown_seconds: 1800,
    seconds_since_last_trade: 3600,
    max_slippage_bps: maxSlippageBps,
    min_signal_score: minSignalScore,
    stop_loss_bps: stopLossBps,
    trailing_stop_bps: trailingStopBps,
    exit_quality_floor: 55,
    allowed_tokens: [],
  };
  const decision = evaluateAutoTrade({ assessment, mandate, position, runtime: { liveEnabled: false } });

  return {
    product: 'AETHER Auto Strategy',
    mode: 'SHADOW',
    training_fixture: true,
    training_scenario: scenario,
    scenario_label: SCENARIOS[scenario],
    assessment,
    decision,
    position,
    mandate: {
      capital_limit_usd: capital,
      max_trade_usd: maxTradeUsd,
      max_allocation_bps: allocationBps,
      max_daily_loss_usd: dailyLossUsd,
      max_slippage_bps: maxSlippageBps,
      min_signal_score: minSignalScore,
      stop_loss_bps: stopLossBps,
      trailing_stop_bps: trailingStopBps,
    },
    execution_dispatched: false,
    transaction_created: false,
    signer_requested: false,
    funds_moved: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    educational_notice: 'Training fixtures exercise the same SHADOW signal and auto-trade decision logic. They are not live market records and never authorize execution.',
  };
}
