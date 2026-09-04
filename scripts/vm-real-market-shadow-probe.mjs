import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';
import { createSolanaHolderConcentrationService } from '../services/api/src/solana-holder-concentration.mjs';
import { createJupiterQuoteEvidenceService } from '../services/api/src/jupiter-quote-evidence.mjs';
import { createSolanaFeeEvidenceService } from '../services/api/src/solana-fee-evidence.mjs';

const view = String(process.env.AETHER_MARKET_VIEW || 'trending').trim().toLowerCase();
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 10);
const limit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 10;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const maxPriceImpactBps = Math.max(0, Number(process.env.SIGNAL_MAX_PRICE_IMPACT_BPS || 100));
const maxRetriesRaw = Number(process.env.AETHER_MARKET_PROBE_MAX_RETRIES || 3);
const maxRetries = Number.isSafeInteger(maxRetriesRaw) ? Math.min(5, Math.max(0, maxRetriesRaw)) : 3;
const quoteUsdcRaw = String(process.env.AETHER_JUPITER_QUOTE_USDC_RAW || '100000000').trim();

const BASE_MISSING_FIELDS = Object.freeze([
  'spread_bps',
  'expected_net_edge_bps',
  'net_edge_costs_included',
  'token_age_hours',
  'route_count',
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

let quotes = null;
let quoteServiceError = null;
try {
  quotes = createJupiterQuoteEvidenceService({ timeoutMs: 10_000 });
} catch (error) {
  quoteServiceError = String(error?.message || error);
}

let feeEvidence = null;
let feeEvidenceError = null;
try {
  const fees = createSolanaFeeEvidenceService({ timeoutMs: 8000 });
  feeEvidence = await fees.getRecentFeeEvidence();
} catch (error) {
  feeEvidenceError = String(error?.message || error);
}

try {
  const discovery = await withRateLimitBackoff('discovery', () => market.getDiscovery(view));
  const rows = discovery.items.slice(0, limit);
  const candidates = [];
  let quoteAttempts = 0;

  for (const row of rows) {
    const base = preliminary(row);
    let holderEvidence = null;
    let holderError = null;
    let quoteEvidence = null;
    let quoteError = null;

    if (base.preliminary_market_gate_passed) {
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
      holderError = 'holder_check_skipped_preliminary_gate_rejected';
    }

    const top10HolderPct = finite(holderEvidence?.top10_holder_pct);
    const holderGatePassed = top10HolderPct !== null && top10HolderPct <= maxTop10HolderPct;

    if (base.preliminary_market_gate_passed && holderGatePassed) {
      if (quotes) {
        if (quoteAttempts > 0) await sleep(quotes.inter_quote_delay_ms);
        quoteAttempts += 1;
        try {
          quoteEvidence = await quotes.getUsdcRoundTripEvidence(row.primary_mint, { usdcAmountRaw: quoteUsdcRaw });
        } catch (error) {
          quoteError = String(error?.message || error);
        }
      } else {
        quoteError = quoteServiceError || 'jupiter_quote_service_unavailable';
      }
    } else {
      quoteError = 'quote_skipped_prequote_gate_rejected';
    }

    const observedPriceImpactBps = finite(quoteEvidence?.max_price_impact_bps);
    const priceImpactGatePassed = observedPriceImpactBps !== null && observedPriceImpactBps <= maxPriceImpactBps;
    const roundtripQuoteEdgeBps = finite(quoteEvidence?.roundtrip_quote_edge_bps);
    const observedRoundtripCostBps = roundtripQuoteEdgeBps === null ? null : Math.max(0, -roundtripQuoteEdgeBps);
    const evidenceRejects = [...base.preliminary_rejects];
    if (base.preliminary_market_gate_passed && top10HolderPct !== null && !holderGatePassed) evidenceRejects.push('TOP10_HOLDER_CONCENTRATION_TOO_HIGH');
    if (base.preliminary_market_gate_passed && top10HolderPct === null) evidenceRejects.push('TOP10_HOLDER_CONCENTRATION_UNVERIFIED');
    if (base.preliminary_market_gate_passed && holderGatePassed && quoteEvidence && !priceImpactGatePassed) evidenceRejects.push('PRICE_IMPACT_TOO_HIGH');
    if (base.preliminary_market_gate_passed && holderGatePassed && !quoteEvidence) evidenceRejects.push('JUPITER_QUOTE_UNVERIFIED');
    if (quoteEvidence && roundtripQuoteEdgeBps !== null && roundtripQuoteEdgeBps < 0) evidenceRejects.push('ROUNDTRIP_QUOTE_COST_OBSERVED');
    if (!feeEvidence) evidenceRejects.push('SOLANA_FEE_EVIDENCE_UNVERIFIED');

    const missingFields = [...BASE_MISSING_FIELDS];
    if (top10HolderPct === null) missingFields.splice(4, 0, 'top10_holder_pct');
    if (!quoteEvidence) missingFields.push('estimated_price_impact_bps', 'source_count');
    if (!feeEvidence) missingFields.push('network_fee_evidence');

    candidates.push({
      token_mint: row.primary_mint,
      symbol: row.base_token?.symbol || null,
      name: row.base_token?.name || null,
      dex_id: row.dex_id || null,
      pool_address: row.pool_address || null,
      price_usd: finite(row.price_usd),
      liquidity_usd: base.liquidity_usd,
      volume_24h_usd: base.volume_24h_usd,
      transactions_24h: finite(row.transactions_24h),
      price_change_percentage: row.price_change_percentage || null,
      pool_age_hours_observation_only: poolAgeHours(row.pool_created_at),
      top10_holder_pct: top10HolderPct,
      token_decimals: Number.isSafeInteger(Number(holderEvidence?.token_decimals)) ? Number(holderEvidence.token_decimals) : null,
      holder_gate_passed: holderGatePassed,
      preliminary_market_gate_passed: base.preliminary_market_gate_passed,
      quote_stage_attempted: base.preliminary_market_gate_passed && holderGatePassed,
      buy_quote_ok: Boolean(quoteEvidence?.buy_quote_ok),
      sell_quote_ok: Boolean(quoteEvidence?.sell_quote_ok),
      sell_path_verified_by_quote: Boolean(quoteEvidence?.sell_path_verified_by_quote),
      estimated_price_impact_bps: observedPriceImpactBps,
      price_impact_gate_passed: priceImpactGatePassed,
      roundtrip_quote_edge_bps: roundtripQuoteEdgeBps,
      observed_roundtrip_cost_bps: observedRoundtripCostBps,
      gross_executable_spread_bps: null,
      expected_net_edge_bps: null,
      buy_route_hops: finite(quoteEvidence?.buy?.route_hop_count),
      sell_route_hops: finite(quoteEvidence?.sell?.route_hop_count),
      buy_distinct_amm_count: finite(quoteEvidence?.buy?.distinct_amm_count),
      sell_distinct_amm_count: finite(quoteEvidence?.sell?.distinct_amm_count),
      buy_amm_labels: quoteEvidence?.buy?.amm_labels || [],
      sell_amm_labels: quoteEvidence?.sell?.amm_labels || [],
      source_count_observed: finite(quoteEvidence?.source_count_observed),
      fee_evidence_available: Boolean(feeEvidence),
      exact_transaction_fee_ready: Boolean(feeEvidence?.exact_transaction_fee_ready),
      net_edge_costs_included: false,
      sell_simulation_ok: false,
      preliminary_rejects: evidenceRejects,
      full_signal_gate_ready: false,
      missing_mandatory_signal_fields: [...new Set(missingFields)],
      detail_error: 'detail_not_requested_provider_quota_preserved',
      holder_error: holderError,
      holder_source: holderEvidence?.source || null,
      quote_error: quoteError,
      quote_source: quoteEvidence ? 'JUPITER_QUOTE_API' : null,
      source: 'GECKOTERMINAL_PUBLIC',
      real_market: true,
      mode: 'SHADOW',
      execution_ready: false,
      execution_dispatched: false,
      transaction_built: false,
      network_submission_authorized: false,
      signer_requested: false,
      live_execution_authorized: false
    });
  }

  const quoteStage = candidates.filter(item => item.preliminary_market_gate_passed && item.holder_gate_passed);
  const quoted = quoteStage.filter(item => item.buy_quote_ok && item.sell_quote_ok);

  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_REAL_MARKET_SHADOW',
    view,
    observed_at: discovery.freshness?.observed_at || new Date().toISOString(),
    market_source_stale: Boolean(discovery.freshness?.stale),
    candidates_scanned: candidates.length,
    preliminary_market_gate_passed: candidates.filter(item => item.preliminary_market_gate_passed).length,
    holder_gate_passed: quoteStage.length,
    quote_stage_attempted: quoteStage.length,
    quote_stage_succeeded: quoted.length,
    quote_price_impact_gate_passed: quoted.filter(item => item.price_impact_gate_passed).length,
    fee_evidence: feeEvidence ? {
      samples: feeEvidence.samples,
      prioritization_fee_rpc_p50: feeEvidence.prioritization_fee_rpc_p50,
      prioritization_fee_rpc_p75: feeEvidence.prioritization_fee_rpc_p75,
      prioritization_fee_rpc_p90: feeEvidence.prioritization_fee_rpc_p90,
      base_fee_lamports_per_signature_reference: feeEvidence.base_fee_lamports_per_signature_reference,
      exact_transaction_fee_ready: false
    } : null,
    fee_evidence_error: feeEvidenceError,
    quote_stage_results: quoteStage.map(item => ({
      token_mint: item.token_mint,
      symbol: item.symbol,
      top10_holder_pct: item.top10_holder_pct,
      buy_quote_ok: item.buy_quote_ok,
      sell_quote_ok: item.sell_quote_ok,
      sell_path_verified_by_quote: item.sell_path_verified_by_quote,
      estimated_price_impact_bps: item.estimated_price_impact_bps,
      price_impact_gate_passed: item.price_impact_gate_passed,
      roundtrip_quote_edge_bps: item.roundtrip_quote_edge_bps,
      observed_roundtrip_cost_bps: item.observed_roundtrip_cost_bps,
      gross_executable_spread_bps: null,
      expected_net_edge_bps: null,
      quote_error: item.quote_error
    })),
    full_signal_gate_ready: 0,
    provider_quota_policy: {
      geckoterminal_requests: 'discovery_only',
      token_detail_deferred: true,
      jupiter_key_present: Boolean(String(process.env.JUPITER_API_KEY || '').trim()),
      jupiter_inter_quote_delay_ms: quotes?.inter_quote_delay_ms || null,
      rate_limit_retries: maxRetries
    },
    note: 'Round-trip Jupiter output is treated as observed route cost, not arbitrage profit. Final expected net edge remains unavailable until an executable gross spread is independently proven and exact transaction fees are obtained from an unsigned transaction message/simulation.',
    mode: 'SHADOW',
    execution_ready: false,
    transaction_built: false,
    network_submission_authorized: false,
    signer_requested: false,
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
    transaction_built: false,
    network_submission_authorized: false,
    signer_requested: false,
    live_execution_authorized: false
  }, null, 2));
  process.exitCode = 1;
}
