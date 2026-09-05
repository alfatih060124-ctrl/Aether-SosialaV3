import { evaluateSignalQuality } from './signal-intelligence.mjs';

const HARD_MIN_NET_EDGE_BPS = 20;
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round8 = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;

function assertRoute(route, side) {
  if (!route || typeof route !== 'object') throw new Error(`${side}_route_required`);
  const price = finite(route.price_usd);
  if (!(price > 0)) throw new Error(`${side}_price_required`);
  if (!String(route.pool_address || '').trim()) throw new Error(`${side}_pool_required`);
  if (!String(route.dex_id || '').trim()) throw new Error(`${side}_dex_required`);
  if (route.quote_verified !== true) throw new Error(`${side}_quote_unverified`);
  return {
    pool_address: String(route.pool_address),
    dex_id: String(route.dex_id),
    price_usd: price,
    fee_bps: clamp(finite(route.fee_bps, 0), 0, 10000),
    price_impact_bps: clamp(finite(route.price_impact_bps, 0), 0, 10000),
    liquidity_usd: finite(route.liquidity_usd, null),
    quote_source: String(route.quote_source || 'UNKNOWN'),
    quote_verified: true
  };
}

export function simulateTwoLegArbitrage({ notional_usdc, buy_route, sell_route, network_fee_usdc = 0 }) {
  const notional = finite(notional_usdc);
  if (!(notional > 0)) throw new Error('arbitrage_notional_required');
  const buy = assertRoute(buy_route, 'buy');
  const sell = assertRoute(sell_route, 'sell');
  if (buy.pool_address === sell.pool_address) throw new Error('arbitrage_distinct_pools_required');

  const buyCostFactor = 1 - (buy.fee_bps + buy.price_impact_bps) / 10000;
  const sellCostFactor = 1 - (sell.fee_bps + sell.price_impact_bps) / 10000;
  if (!(buyCostFactor > 0) || !(sellCostFactor > 0)) throw new Error('arbitrage_route_cost_invalid');

  const tokenOut = (notional * buyCostFactor) / buy.price_usd;
  const grossSellUsdc = tokenOut * sell.price_usd;
  const networkFee = clamp(finite(network_fee_usdc, 0), 0, notional);
  const finalUsdc = Math.max(0, grossSellUsdc * sellCostFactor - networkFee);
  const grossEdgeBps = ((sell.price_usd / buy.price_usd) - 1) * 10000;
  const netEdgeBps = ((finalUsdc / notional) - 1) * 10000;

  return Object.freeze({
    notional_usdc: round8(notional),
    token_out: round8(tokenOut),
    gross_sell_usdc: round8(grossSellUsdc),
    final_usdc: round8(finalUsdc),
    gross_edge_bps: Math.round(grossEdgeBps * 100) / 100,
    net_edge_bps: Math.round(netEdgeBps * 100) / 100,
    net_pnl_usdc: round8(finalUsdc - notional),
    cost_breakdown: Object.freeze({
      buy_fee_bps: buy.fee_bps,
      buy_price_impact_bps: buy.price_impact_bps,
      sell_fee_bps: sell.fee_bps,
      sell_price_impact_bps: sell.price_impact_bps,
      network_fee_usdc: round8(networkFee),
      costs_verified: true
    }),
    buy_route: Object.freeze(buy),
    sell_route: Object.freeze(sell)
  });
}

export function evaluateRealMarketArbitrageShadow({ opportunity = {}, notional_usdc, risk_evidence = {}, now = Date.now(), signal_options = {} }) {
  const observedAt = String(opportunity.observed_at || '');
  const simulation = simulateTwoLegArbitrage({
    notional_usdc,
    buy_route: opportunity.buy_route,
    sell_route: opportunity.sell_route,
    network_fee_usdc: opportunity.network_fee_usdc
  });

  const liquidityValues = [simulation.buy_route.liquidity_usd, simulation.sell_route.liquidity_usd].filter(Number.isFinite);
  const snapshot = {
    token_mint: String(opportunity.token_mint || ''),
    quote_mint: String(opportunity.quote_mint || ''),
    observed_at: observedAt,
    liquidity_usd: liquidityValues.length === 2 ? Math.min(...liquidityValues) : risk_evidence.liquidity_usd,
    volume_24h_usd: risk_evidence.volume_24h_usd,
    spread_bps: risk_evidence.spread_bps,
    estimated_price_impact_bps: simulation.buy_route.price_impact_bps + simulation.sell_route.price_impact_bps,
    expected_net_edge_bps: simulation.net_edge_bps,
    net_edge_costs_included: true,
    top10_holder_pct: risk_evidence.top10_holder_pct,
    token_age_hours: risk_evidence.token_age_hours,
    route_count: risk_evidence.route_count,
    source_count: risk_evidence.source_count,
    volatility_1h_bps: risk_evidence.volatility_1h_bps,
    momentum_5m_bps: risk_evidence.momentum_5m_bps,
    momentum_1h_bps: risk_evidence.momentum_1h_bps,
    buy_sell_imbalance: risk_evidence.buy_sell_imbalance,
    sell_simulation_ok: risk_evidence.sell_simulation_ok,
    transferable: risk_evidence.transferable,
    risk_flags: Array.isArray(risk_evidence.risk_flags) ? risk_evidence.risk_flags : []
  };

  const assessment = evaluateSignalQuality(snapshot, {
    ...signal_options,
    now,
    config: {
      ...(signal_options.config || {}),
      minExpectedNetEdgeBps: Math.max(HARD_MIN_NET_EDGE_BPS, finite(signal_options.config?.minExpectedNetEdgeBps, HARD_MIN_NET_EDGE_BPS))
    }
  });
  const qualified = assessment.verdict === 'QUALIFIED' && simulation.net_edge_bps >= HARD_MIN_NET_EDGE_BPS;

  return Object.freeze({
    product: 'AETHER Auto Trade Arbitrage',
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    market_data_mode: 'REAL_MARKET_SHADOW',
    benchmark_eligible: qualified,
    training_fixture: false,
    market_source: String(opportunity.market_source || 'REAL_MARKET'),
    observed_at: observedAt || null,
    assessment,
    decision: Object.freeze({
      action: qualified ? 'ARBITRAGE_SETTLE' : 'REJECT',
      requested_amount_usd: qualified ? simulation.notional_usdc : 0,
      reason_codes: qualified ? ['TWO_LEG_ARBITRAGE_QUALIFIED','EXPECTED_NET_EDGE_AT_OR_ABOVE_0_20_PERCENT'] : assessment.hard_rejects.length ? assessment.hard_rejects : ['SIGNAL_QUALITY_NOT_QUALIFIED']
    }),
    arbitrage: simulation,
    execution_dispatched: false,
    transaction_created: false,
    signer_requested: false,
    funds_moved: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  });
}

export const REAL_MARKET_ARBITRAGE_MIN_NET_EDGE_BPS = HARD_MIN_NET_EDGE_BPS;
