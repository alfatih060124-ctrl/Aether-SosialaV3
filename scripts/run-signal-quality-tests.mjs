import assert from 'node:assert/strict';
import { evaluateSignalQuality } from '../services/api/src/signal-intelligence.mjs';
import { evaluateAutoTrade } from '../services/api/src/auto-trade-engine.mjs';

const now = Date.parse('2026-08-30T15:00:00.000Z');
const strong = {
  token_mint: 'TOKEN_QUALITY_TEST',
  quote_mint: 'USDC',
  observed_at: new Date(now - 1000).toISOString(),
  liquidity_usd: 8_000_000,
  volume_24h_usd: 5_000_000,
  spread_bps: 8,
  estimated_price_impact_bps: 12,
  top10_holder_pct: 14,
  token_age_hours: 720,
  route_count: 6,
  source_count: 5,
  volatility_1h_bps: 220,
  momentum_5m_bps: 320,
  momentum_1h_bps: 800,
  buy_sell_imbalance: 0.4,
  sell_simulation_ok: true,
  transferable: true,
  risk_flags: []
};

const assessment = evaluateSignalQuality(strong, { now });
assert.equal(assessment.verdict, 'QUALIFIED');
assert.ok(assessment.quality_score >= 82);

const lowLiquidity = evaluateSignalQuality({ ...strong, liquidity_usd: 10_000 }, { now });
assert.equal(lowLiquidity.verdict, 'REJECTED');
assert.ok(lowLiquidity.hard_rejects.includes('INSUFFICIENT_LIQUIDITY'));

const stale = evaluateSignalQuality({ ...strong, observed_at: new Date(now - 30_000).toISOString() }, { now });
assert.ok(stale.hard_rejects.includes('STALE_MARKET_DATA'));

const concentrated = evaluateSignalQuality({ ...strong, top10_holder_pct: 70 }, { now });
assert.ok(concentrated.hard_rejects.includes('HOLDER_CONCENTRATION_TOO_HIGH'));

const buy = evaluateAutoTrade({
  assessment,
  mandate: { enabled: true, mode: 'SHADOW', capital_limit_usd: 1000, available_capital_usd: 1000, max_trade_usd: 100, trades_today: 0, seconds_since_last_trade: 3600 },
  runtime: { liveEnabled: false }
});
assert.equal(buy.action, 'BUY');
assert.equal(buy.requested_amount_usd, 100);
assert.equal(buy.live_execution_authorized, false);

const tradeCap = evaluateAutoTrade({
  assessment,
  mandate: { enabled: true, mode: 'SHADOW', capital_limit_usd: 1000, max_trade_usd: 100, trades_today: 6, max_trades_per_day: 6, seconds_since_last_trade: 3600 }
});
assert.equal(tradeCap.action, 'REJECT');
assert.ok(tradeCap.reason_codes.includes('DAILY_TRADE_LIMIT_REACHED'));

const stopLoss = evaluateAutoTrade({
  assessment,
  mandate: { enabled: true, mode: 'SHADOW', capital_limit_usd: 1000, max_trade_usd: 100, stop_loss_bps: 500, max_slippage_bps: 100 },
  position: { position_value_usd: 92, entry_price_usd: 100, current_price_usd: 92, peak_price_usd: 105 }
});
assert.equal(stopLoss.action, 'SELL');
assert.ok(stopLoss.reason_codes.includes('STOP_LOSS'));

const trailing = evaluateAutoTrade({
  assessment,
  mandate: { enabled: true, mode: 'SHADOW', capital_limit_usd: 1000, trailing_stop_bps: 350, max_slippage_bps: 100 },
  position: { position_value_usd: 103, entry_price_usd: 100, current_price_usd: 103, peak_price_usd: 110 }
});
assert.equal(trailing.action, 'SELL');
assert.ok(trailing.reason_codes.includes('TRAILING_STOP'));

console.log(JSON.stringify({ ok: true, tests: 8, qualified_score: assessment.quality_score, philosophy: 'quality_over_quantity' }));
