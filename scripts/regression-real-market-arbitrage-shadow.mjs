import assert from 'node:assert/strict';
import { evaluateRealMarketArbitrageShadow, simulateTwoLegArbitrage } from '../services/api/src/real-market-arbitrage-shadow.mjs';
import { settleDemoArbitrage } from '../services/api/src/demo-autotrade-ledger.mjs';

const observedAt = '2026-09-05T01:45:00.000Z';
const now = Date.parse(observedAt);
const route = (overrides = {}) => ({
  pool_address: 'pool-a', dex_id: 'orca', price_usd: 1,
  fee_bps: 5, price_impact_bps: 5, liquidity_usd: 5_000_000,
  quote_source: 'READ_ONLY_QUOTE_TEST', quote_verified: true, ...overrides
});
const risk = {
  volume_24h_usd: 3_000_000, spread_bps: 8, top10_holder_pct: 12,
  token_age_hours: 240, route_count: 2, source_count: 2,
  volatility_1h_bps: 250, momentum_5m_bps: 300, momentum_1h_bps: 700,
  buy_sell_imbalance: 0.35, sell_simulation_ok: true, transferable: true, risk_flags: []
};
const opportunity = {
  token_mint: 'TOKEN_MINT_TEST', quote_mint: 'USDC_MINT_TEST', observed_at: observedAt,
  market_source: 'ORCA_RAYDIUM_REAL_MARKET_TEST', network_fee_usdc: 0.01, network_fee_verified: true,
  buy_route: route(),
  sell_route: route({ pool_address: 'pool-b', dex_id: 'raydium', price_usd: 1.01 })
};

const sim = simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: opportunity.buy_route, sell_route: opportunity.sell_route, network_fee_usdc: 0.01, network_fee_verified: true });
assert.ok(sim.final_usdc > 1000);
assert.ok(sim.net_edge_bps >= 20);
assert.equal(sim.buy_route.dex_id, 'orca');
assert.equal(sim.sell_route.dex_id, 'raydium');
assert.deepEqual(sim.dex_scope, ['ORCA','RAYDIUM']);
assert.equal(sim.cost_breakdown.buy_route_costs_verified, true);
assert.equal(sim.cost_breakdown.sell_route_costs_verified, true);
assert.equal(sim.cost_breakdown.network_fee_verified, true);
assert.equal(sim.cost_breakdown.costs_verified, true);

const reverse = simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ dex_id: 'raydium' }), sell_route: route({ pool_address: 'pool-b', dex_id: 'orca', price_usd: 1.01 }), network_fee_usdc: 0.01, network_fee_verified: true });
assert.equal(reverse.buy_route.dex_id, 'raydium');
assert.equal(reverse.sell_route.dex_id, 'orca');

const qualified = evaluateRealMarketArbitrageShadow({ opportunity, notional_usdc: 1000, risk_evidence: risk, now });
assert.equal(qualified.mode, 'SHADOW');
assert.equal(qualified.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(qualified.market_discovery_scope, 'ORCA_RAYDIUM_ONLY');
assert.equal(qualified.market_data_mode, 'REAL_MARKET_SHADOW');
assert.equal(qualified.decision.action, 'ARBITRAGE_SETTLE');
assert.equal(qualified.assessment.verdict, 'QUALIFIED');
assert.equal(qualified.benchmark_eligible, true);
assert.equal(qualified.execution_dispatched, false);
assert.equal(qualified.funds_moved, false);
assert.equal(qualified.live_execution_authorized, false);
assert.ok(!['BUY','SELL','HOLD'].includes(qualified.decision.action));

const settled = settleDemoArbitrage({ account: { cash_balance_usdc: 2000, open_position: {} }, notionalUsdc: qualified.arbitrage.notional_usdc, finalUsdc: qualified.arbitrage.final_usdc, performanceFeeBps: 1000 });
assert.equal(settled.settlement_status, 'ARBITRAGE_CLOSED');
assert.equal(settled.open_position.notional_usdc, undefined);
assert.equal(settled.trades_closed_delta, 1);
assert.ok(settled.cash_balance_usdc > 2000);
assert.equal(settled.live_execution_authorized, false);

const below = evaluateRealMarketArbitrageShadow({ opportunity: { ...opportunity, sell_route: route({ pool_address: 'pool-b', dex_id: 'raydium', price_usd: 1.001 }) }, notional_usdc: 1000, risk_evidence: risk, now });
assert.equal(below.decision.action, 'REJECT');
assert.ok(below.assessment.hard_rejects.includes('EXPECTED_NET_EDGE_BELOW_MINIMUM'));
assert.equal(below.benchmark_eligible, false);

const missingStrictEvidence = evaluateRealMarketArbitrageShadow({ opportunity, notional_usdc: 1000, risk_evidence: { ...risk, top10_holder_pct: undefined }, now });
assert.equal(missingStrictEvidence.decision.action, 'REJECT');
assert.ok(missingStrictEvidence.assessment.hard_rejects.includes('MISSING_TOP10_HOLDER_PCT'));

assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ quote_verified: false }), sell_route: opportunity.sell_route, network_fee_usdc: 0.01, network_fee_verified: true }), /buy_quote_unverified/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ fee_bps: undefined }), sell_route: opportunity.sell_route, network_fee_usdc: 0.01, network_fee_verified: true }), /buy_fee_bps_required/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ price_impact_bps: undefined }), sell_route: opportunity.sell_route, network_fee_usdc: 0.01, network_fee_verified: true }), /buy_price_impact_bps_required/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: opportunity.buy_route, sell_route: opportunity.sell_route, network_fee_verified: true }), /network_fee_usdc_required/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: opportunity.buy_route, sell_route: opportunity.sell_route, network_fee_usdc: 0.01 }), /network_fee_unverified/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ dex_id: 'meteora' }), sell_route: opportunity.sell_route, network_fee_usdc: 0.01, network_fee_verified: true }), /buy_dex_not_allowed/);
assert.throws(() => simulateTwoLegArbitrage({ notional_usdc: 1000, buy_route: route({ dex_id: 'orca' }), sell_route: route({ pool_address: 'pool-b', dex_id: 'orca', price_usd: 1.01 }), network_fee_usdc: 0.01, network_fee_verified: true }), /arbitrage_cross_dex_required/);
assert.throws(() => settleDemoArbitrage({ account: { cash_balance_usdc: 2000, open_position: { notional_usdc: 10 } }, notionalUsdc: 1000, finalUsdc: 1010 }), /arbitrage_open_position_not_allowed/);

console.log('real-market-arbitrage-shadow regression: ok');
