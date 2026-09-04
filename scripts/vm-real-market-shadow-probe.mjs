import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';
import { createSolanaHolderConcentrationService } from '../services/api/src/solana-holder-concentration.mjs';

const view = String(process.env.AETHER_MARKET_VIEW || 'trending').trim().toLowerCase();
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 10);
const limit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 10;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const detailDelayMsRaw = Number(process.env.AETHER_MARKET_PROBE_DETAIL_DELAY_MS || 1200);
const detailDelayMs = Number.isFinite(detailDelayMsRaw) ? Math.min(10000, Math.max(250, detailDelayMsRaw)) : 1200;
const maxRetriesRaw = Number(process.env.AETHER_MARKET_PROBE_MAX_RETRIES || 3);
const maxRetries = Number.isSafeInteger(maxRetriesRaw) ? Math.min(5, Math.max(0, maxRetriesRaw)) : 3;

const BASE_MISSING_FIELDS = Object.freeze([
  'spread_bps',
  'estimated_price_impact_bps',
  'expected_net_edge_bps',
  'net_edge_costs_included',
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRateLimitBackoff(label, operation) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const reason = String(error?.message || error);
      if (reason !== 'market_provider_rate_limited' || attempt >= maxRetries) throw error;
      const waitMs = Math.min(15000, 1500 * (2 ** attempt));
      console.error(`[aether-real-market] ${label} rate-limited; retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

const market = createMarketIntelligenceService({ timeoutMs: 8000 });
let holders = null;
let holderServiceError = null;
try {
  holders = createSolanaHolderConcentrationService({ timeoutMs: 8000 });
} catch (error) {
  holderServiceError = String(error?.message || error);
}

try {
  const discovery = await withRateLimitBackoff('discovery', () => market.getDiscovery(view));
  const rows = discovery.items.slice(0, limit);
  const candidates = [];

  for (const row of rows) {
    const base = preliminary(row);
    let detail = null;
    let detailError = null;
    let holderEvidence = null;
    let holderError = null;

    if (base.preliminary_market_gate_passed) {
      if (candidates.length > 0) await sleep(detailDelayMs);
      try {
        detail = await withRateLimitBackoff(`token:${row.primary_mint}`, () => market.getToken(row.primary_mint));
      } catch (error) {
        detailError = String(error?.message || error);
      }
      if (holders) {
        try {
          holderEvidence = await holders.getTop10HolderPct(row.primary_mint);
        } catch (error) {
          holderError = String(error?.message || error);
        }
      } else {
        holderError = holderServiceError || 'solana_holder_service_unavailable';
      }
    } else {
      detailError = 'detail_skipped_preliminary_gate_rejected';
      holderError = 'holder_check_skipped_preliminary_gate_rejected';
    }

    const top10HolderPct = finite(holderEvidence?.top10_holder_pct);
    const holderGatePassed = top10HolderPct !== null && top10HolderPct <= maxTop10HolderPct;
    const evidenceRejects = [...base.preliminary_rejects];
    if (base.preliminary_market_gate_passed && top10HolderPct !== null && !holderGatePassed) evidenceRejects.push('TOP10_HOLDER_CONCENTRATION_TOO_HIGH');
    if (base.preliminary_market_gate_passed && top10HolderPct === null) evidenceRejects.push('TOP10_HOLDER_CONCENTRATION_UNVERIFIED');
    const missingFields = [...BASE_MISSING_FIELDS];
    if (top10HolderPct === null) missingFields.splice(4, 0, 'top10_holder_pct');

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
      top10_holder_pct: top10HolderPct,
      holder_gate_passed: holderGatePassed,
      preliminary_market_gate_passed: base.preliminary_market_gate_passed,
      preliminary_rejects: evidenceRejects,
      full_signal_gate_ready: false,
      missing_mandatory_signal_fields: missingFields,
      detail_error: detailError,
      holder_error: holderError,
      holder_source: holderEvidence?.source || null,
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
    holder_gate_passed: candidates.filter(item => item.preliminary_market_gate_passed && item.holder_gate_passed).length,
    full_signal_gate_ready: 0,
    provider_quota_policy: {
      detail_only_after_preliminary_gate: true,
      detail_delay_ms: detailDelayMs,
      rate_limit_retries: maxRetries
    },
    note: 'Real market data and on-chain holder evidence are fail-closed. No candidate reaches Auto Trade until quote/sell simulation, token controls, multi-source reconciliation, and net-edge-after-cost fields are independently verified.',
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
    retry_policy_exhausted: String(error?.message || error) === 'market_provider_rate_limited',
    mode: 'SHADOW',
    execution_ready: false,
    live_execution_authorized: false
  }, null, 2));
  process.exitCode = 1;
}
