import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';

const view = String(process.env.AETHER_MARKET_VIEW || 'trending').trim().toLowerCase();
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 10);
const limit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 10;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));

const REQUIRED_UNVERIFIED_FIELDS = Object.freeze([
  'spread_bps',
  'estimated_price_impact_bps',
  'expected_net_edge_bps',
  'net_edge_costs_included',
  'top10_holder_pct',
  'token_age_hours',
  'route_count',
  'source_count',
  'volatility_1h_bps',
  'sell_simulation_ok',
  'transferable',
  'risk_flags'
]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function poolAgeHours(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 3_600_000);
}

function preliminary(candidate) {
  const liquidityUsd = finite(candidate.liquidity_usd);
  const volume24hUsd = finite(candidate.volume_24h_usd);
  const hardRejects = [];
  if (liquidityUsd === null || liquidityUsd < minLiquidityUsd) hardRejects.push('MIN_LIQUIDITY_NOT_MET');
  if (volume24hUsd === null || volume24hUsd < minVolume24hUsd) hardRejects.push('MIN_VOLUME_NOT_MET');
  return {
    liquidity_usd: liquidityUsd,
    volume_24h_usd: volume24hUsd,
    preliminary_market_gate_passed: hardRejects.length === 0,
    preliminary_rejects: hardRejects
  };
}

const market = createMarketIntelligenceService({ timeoutMs: 8000 });

try {
  const discovery = await market.getDiscovery(view);
  const rows = discovery.items.slice(0, limit);
  const candidates = [];

  for (const row of rows) {
    const base = preliminary(row);
    let detail = null;
    let detailError = null;
    try {
      detail = await market.getToken(row.primary_mint);
    } catch (error) {
      detailError = String(error?.message || error);
    }

    candidates.push({
      token_mint: row.primary_mint,
      symbol: row.base_token?.symbol || null,
      name: row.base_token?.name || null,
      dex_id: row.dex_id || detail?.market?.dex_id || null,
      pool_address: row.pool_address || detail?.market?.pool_address || null,
      price_usd: finite(row.price_usd ?? detail?.market?.price_usd),
      liquidity_usd: base.liquidity_usd,
      volume_24h_usd: base.volume_24h_usd,
      transactions_24h: finite(row.transactions_24h),
      price_change_percentage: row.price_change_percentage || null,
      pool_age_hours_observation_only: poolAgeHours(row.pool_created_at || detail?.market?.pool_created_at),
      preliminary_market_gate_passed: base.preliminary_market_gate_passed,
      preliminary_rejects: base.preliminary_rejects,
      full_signal_gate_ready: false,
      missing_mandatory_signal_fields: REQUIRED_UNVERIFIED_FIELDS,
      detail_error: detailError,
      source: 'GECKOTERMINAL_PUBLIC',
      real_market: true,
      mode: 'SHADOW',
      execution_ready: false,
      execution_dispatched: false,
      network_submission_authorized: false,
      signer_requested: false,
      live_execution_authorized: false
    });
  }

  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_REAL_MARKET_SHADOW',
    view,
    observed_at: discovery.freshness?.observed_at || new Date().toISOString(),
    market_source_stale: Boolean(discovery.freshness?.stale),
    candidates_scanned: candidates.length,
    preliminary_market_gate_passed: candidates.filter(item => item.preliminary_market_gate_passed).length,
    full_signal_gate_ready: 0,
    note: 'Real market data is active. No candidate is allowed to reach Auto Trade until quote/sell simulation, holder/token controls, multi-source reconciliation, and net-edge-after-cost fields are independently verified.',
    mode: 'SHADOW',
    execution_ready: false,
    live_execution_authorized: false,
    candidates
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'error',
    probe: 'AETHER_REAL_MARKET_SHADOW',
    error: String(error?.message || error),
    mode: 'SHADOW',
    execution_ready: false,
    live_execution_authorized: false
  }, null, 2));
  process.exitCode = 1;
}
