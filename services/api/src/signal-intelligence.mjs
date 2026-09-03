const HARD_MIN_EXPECTED_NET_EDGE_BPS = 10;

const finite = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const linearScore = (value, low, high, points) => {
  if (!Number.isFinite(value) || high <= low) return 0;
  return clamp((value - low) / (high - low), 0, 1) * points;
};
const inverseScore = (value, good, bad, points) => {
  if (!Number.isFinite(value) || bad <= good) return 0;
  return clamp((bad - value) / (bad - good), 0, 1) * points;
};

export function getSignalQualityConfig(env = process.env) {
  return Object.freeze({
    minScore: finite(env.SIGNAL_MIN_SCORE, 82),
    minLiquidityUsd: finite(env.SIGNAL_MIN_LIQUIDITY_USD, 500000),
    minVolume24hUsd: finite(env.SIGNAL_MIN_VOLUME_24H_USD, 250000),
    maxSpreadBps: finite(env.SIGNAL_MAX_SPREAD_BPS, 50),
    maxPriceImpactBps: finite(env.SIGNAL_MAX_PRICE_IMPACT_BPS, 100),
    maxTop10HolderPct: finite(env.SIGNAL_MAX_TOP10_HOLDER_PCT, 35),
    minTokenAgeHours: finite(env.SIGNAL_MIN_TOKEN_AGE_HOURS, 24),
    maxDataAgeMs: finite(env.SIGNAL_MAX_DATA_AGE_MS, 5000),
    minRouteCount: finite(env.SIGNAL_MIN_ROUTE_COUNT, 2),
    minSourceCount: finite(env.SIGNAL_MIN_SOURCE_COUNT, 2),
    maxVolatility1hBps: finite(env.SIGNAL_MAX_VOLATILITY_1H_BPS, 1500),
    minExpectedNetEdgeBps: Math.max(HARD_MIN_EXPECTED_NET_EDGE_BPS, finite(env.SIGNAL_MIN_EXPECTED_NET_EDGE_BPS, HARD_MIN_EXPECTED_NET_EDGE_BPS))
  });
}

function validateSnapshot(snapshot, config, now) {
  const rejects = [];
  const requiredNumbers = [
    ['liquidity_usd', snapshot.liquidity_usd],
    ['volume_24h_usd', snapshot.volume_24h_usd],
    ['spread_bps', snapshot.spread_bps],
    ['estimated_price_impact_bps', snapshot.estimated_price_impact_bps],
    ['expected_net_edge_bps', snapshot.expected_net_edge_bps],
    ['top10_holder_pct', snapshot.top10_holder_pct],
    ['token_age_hours', snapshot.token_age_hours],
    ['route_count', snapshot.route_count],
    ['source_count', snapshot.source_count]
  ];

  if (!String(snapshot.token_mint || '').trim()) rejects.push('TOKEN_MINT_REQUIRED');
  for (const [name, value] of requiredNumbers) {
    if (!Number.isFinite(Number(value))) rejects.push(`MISSING_${name.toUpperCase()}`);
  }

  const observed = Date.parse(snapshot.observed_at || '');
  if (!Number.isFinite(observed)) rejects.push('OBSERVED_AT_REQUIRED');
  else {
    const ageMs = now - observed;
    if (ageMs < -2000) rejects.push('FUTURE_MARKET_SNAPSHOT');
    if (ageMs > config.maxDataAgeMs) rejects.push('STALE_MARKET_DATA');
  }

  if (finite(snapshot.liquidity_usd, 0) < config.minLiquidityUsd) rejects.push('INSUFFICIENT_LIQUIDITY');
  if (finite(snapshot.volume_24h_usd, 0) < config.minVolume24hUsd) rejects.push('INSUFFICIENT_VOLUME');
  if (finite(snapshot.spread_bps, Infinity) > config.maxSpreadBps) rejects.push('SPREAD_TOO_WIDE');
  if (finite(snapshot.estimated_price_impact_bps, Infinity) > config.maxPriceImpactBps) rejects.push('PRICE_IMPACT_TOO_HIGH');
  if (snapshot.net_edge_costs_included !== true) rejects.push('NET_EDGE_COSTS_UNVERIFIED');
  if (finite(snapshot.expected_net_edge_bps, -Infinity) < config.minExpectedNetEdgeBps) rejects.push('EXPECTED_NET_EDGE_BELOW_MINIMUM');
  if (finite(snapshot.top10_holder_pct, 100) > config.maxTop10HolderPct) rejects.push('HOLDER_CONCENTRATION_TOO_HIGH');
  if (finite(snapshot.token_age_hours, 0) < config.minTokenAgeHours) rejects.push('TOKEN_TOO_NEW');
  if (finite(snapshot.route_count, 0) < config.minRouteCount) rejects.push('INSUFFICIENT_EXECUTION_ROUTES');
  if (finite(snapshot.source_count, 0) < config.minSourceCount) rejects.push('INSUFFICIENT_DATA_SOURCES');
  if (finite(snapshot.volatility_1h_bps, 0) > config.maxVolatility1hBps) rejects.push('VOLATILITY_TOO_HIGH');
  if (snapshot.sell_simulation_ok !== true) rejects.push('SELL_PATH_NOT_VERIFIED');
  if (snapshot.transferable === false) rejects.push('TOKEN_TRANSFER_RESTRICTED');
  if (snapshot.risk_flags && Array.isArray(snapshot.risk_flags) && snapshot.risk_flags.length) rejects.push('TOKEN_RISK_FLAGGED');

  return [...new Set(rejects)];
}

function scoreSnapshot(snapshot, config) {
  const liquidity = finite(snapshot.liquidity_usd, 0);
  const volume = finite(snapshot.volume_24h_usd, 0);
  const spread = finite(snapshot.spread_bps, config.maxSpreadBps * 2);
  const impact = finite(snapshot.estimated_price_impact_bps, config.maxPriceImpactBps * 2);
  const routes = finite(snapshot.route_count, 0);
  const top10 = finite(snapshot.top10_holder_pct, 100);
  const momentum5m = finite(snapshot.momentum_5m_bps, 0);
  const momentum1h = finite(snapshot.momentum_1h_bps, 0);
  const imbalance = finite(snapshot.buy_sell_imbalance, 0);
  const volatility = finite(snapshot.volatility_1h_bps, config.maxVolatility1hBps);
  const sourceCount = finite(snapshot.source_count, 0);

  const components = {
    liquidity: linearScore(liquidity, config.minLiquidityUsd, config.minLiquidityUsd * 10, 20),
    volume: linearScore(volume, config.minVolume24hUsd, config.minVolume24hUsd * 12, 15),
    spread: inverseScore(spread, 8, config.maxSpreadBps, 8),
    price_impact: inverseScore(impact, 15, config.maxPriceImpactBps, 8),
    routing: linearScore(routes, config.minRouteCount, Math.max(6, config.minRouteCount + 4), 4),
    distribution: inverseScore(top10, 12, config.maxTop10HolderPct, 10),
    momentum: clamp(linearScore(momentum5m, 10, 300, 7) + linearScore(momentum1h, 20, 700, 8), 0, 15),
    order_flow: linearScore(imbalance, -0.05, 0.35, 8),
    volatility: inverseScore(volatility, 250, config.maxVolatility1hBps, 7),
    data_quality: linearScore(sourceCount, config.minSourceCount, config.minSourceCount + 3, 5)
  };
  const raw = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score: Math.round(clamp(raw, 0, 100) * 100) / 100, components };
}

export function evaluateSignalQuality(snapshot = {}, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const baseConfig = getSignalQualityConfig(options.env);
  const config = {
    ...baseConfig,
    ...(options.config || {}),
    minExpectedNetEdgeBps: Math.max(
      HARD_MIN_EXPECTED_NET_EDGE_BPS,
      finite(options.config?.minExpectedNetEdgeBps, baseConfig.minExpectedNetEdgeBps)
    )
  };
  const hardRejects = validateSnapshot(snapshot, config, now);
  const { score, components } = scoreSnapshot(snapshot, config);
  const verdict = hardRejects.length ? 'REJECTED' : score >= config.minScore ? 'QUALIFIED' : 'WATCH';
  return {
    source_type: 'MACHINE_INTELLIGENCE',
    token_mint: String(snapshot.token_mint || '').trim() || null,
    quote_mint: String(snapshot.quote_mint || '').trim() || null,
    quality_score: score,
    verdict,
    hard_rejects: hardRejects,
    components,
    expected_net_edge_bps: finite(snapshot.expected_net_edge_bps, null),
    minimum_expected_net_edge_bps: config.minExpectedNetEdgeBps,
    net_edge_costs_included: snapshot.net_edge_costs_included === true,
    observed_at: snapshot.observed_at || null,
    evaluated_at: new Date(now).toISOString(),
    quality_first: true,
    live_execution_authorized: false,
    snapshot: { ...snapshot }
  };
}
