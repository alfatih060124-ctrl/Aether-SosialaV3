import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';
import { createSolanaHolderConcentrationService } from '../services/api/src/solana-holder-concentration.mjs';
import { createJupiterQuoteEvidenceService } from '../services/api/src/jupiter-quote-evidence.mjs';

const DISCOVERY_VIEWS = new Set(['trending', 'new', 'gainers', 'volume']);
const legacyView = String(process.env.AETHER_MARKET_VIEW || '').trim().toLowerCase();
const discoveryViewsRaw = String(process.env.AETHER_MARKET_VIEWS || legacyView || 'trending,new,gainers,volume');
const discoveryViews = [...new Set(discoveryViewsRaw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
if (!discoveryViews.length || discoveryViews.some(item => !DISCOVERY_VIEWS.has(item))) throw new Error('invalid_market_discovery_views');

const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 20);
const perViewLimit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 20;
const candidateLimitRaw = Number(process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT || 60);
const candidateLimit = Number.isSafeInteger(candidateLimitRaw) ? Math.min(60, Math.max(1, candidateLimitRaw)) : 60;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const maxPriceImpactBps = Math.max(0, Number(process.env.SIGNAL_MAX_PRICE_IMPACT_BPS || 100));
const quoteUsdcRaw = String(process.env.AETHER_JUPITER_QUOTE_USDC_RAW || '100000000').trim();

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function discoveryScore(row) {
  return (finite(row?.liquidity_usd) ?? 0) + (finite(row?.volume_24h_usd) ?? 0);
}

const market = createMarketIntelligenceService({ timeoutMs: 8000 });
const holders = createSolanaHolderConcentrationService({ timeoutMs: 8000 });
const quotes = createJupiterQuoteEvidenceService({ timeoutMs: 10000 });

try {
  const candidateMap = new Map();
  const discoveryErrors = [];

  for (const view of discoveryViews) {
    try {
      const discovery = await market.getDiscovery(view);
      for (const row of discovery.items.slice(0, perViewLimit)) {
        const mint = String(row?.primary_mint || '').trim();
        if (!mint) continue;
        const existing = candidateMap.get(mint);
        if (!existing || discoveryScore(row) > discoveryScore(existing)) candidateMap.set(mint, row);
      }
    } catch (error) {
      discoveryErrors.push({ view, error: String(error?.message || error) });
    }
  }

  if (!candidateMap.size) throw new Error('market_discovery_unavailable');

  const rows = [...candidateMap.values()].sort((a, b) => discoveryScore(b) - discoveryScore(a)).slice(0, candidateLimit);
  const counters = {
    candidates_discovered: candidateMap.size,
    candidates_scanned: rows.length,
    liquidity_volume_passed: 0,
    holder_checked: 0,
    holder_passed: 0,
    broad_quote_attempted: 0,
    broad_quote_ready: 0,
    broad_price_impact_passed: 0
  };
  const rejection_counts = {};
  const samples = [];

  function reject(reason, row, extra = {}) {
    rejection_counts[reason] = (rejection_counts[reason] || 0) + 1;
    if (samples.length < 20) samples.push({ symbol: row?.base_token?.symbol || null, reason, ...extra });
  }

  for (const row of rows) {
    const liquidity = finite(row.liquidity_usd);
    const volume = finite(row.volume_24h_usd);
    if (liquidity === null || liquidity < minLiquidityUsd) {
      reject('MIN_LIQUIDITY_NOT_MET', row, { liquidity_usd: liquidity });
      continue;
    }
    if (volume === null || volume < minVolume24hUsd) {
      reject('MIN_VOLUME_NOT_MET', row, { volume_24h_usd: volume });
      continue;
    }
    counters.liquidity_volume_passed += 1;

    counters.holder_checked += 1;
    let holder;
    try {
      holder = await holders.getTop10HolderPct(row.primary_mint);
    } catch (error) {
      reject('HOLDER_EVIDENCE_UNAVAILABLE', row, { error: String(error?.message || error) });
      continue;
    }
    const top10 = finite(holder?.top10_holder_pct);
    if (top10 === null) {
      reject('HOLDER_EVIDENCE_UNAVAILABLE', row);
      continue;
    }
    if (top10 > maxTop10HolderPct) {
      reject('TOP10_HOLDER_LIMIT_EXCEEDED', row, { top10_holder_pct: top10 });
      continue;
    }
    counters.holder_passed += 1;

    counters.broad_quote_attempted += 1;
    let broad;
    try {
      broad = await quotes.getUsdcRoundTripEvidence(row.primary_mint, { usdcAmountRaw: quoteUsdcRaw });
    } catch (error) {
      reject('BROAD_QUOTE_UNAVAILABLE', row, { error: String(error?.message || error) });
      continue;
    }
    counters.broad_quote_ready += 1;

    const impact = finite(broad?.max_price_impact_bps);
    if (impact === null) {
      reject('BROAD_PRICE_IMPACT_UNAVAILABLE', row);
      continue;
    }
    if (impact > maxPriceImpactBps) {
      reject('BROAD_PRICE_IMPACT_REJECTED', row, { max_price_impact_bps: impact });
      continue;
    }
    counters.broad_price_impact_passed += 1;
  }

  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_CROSS_VENUE_STAGE_DIAGNOSTIC_SHADOW',
    observed_at: new Date().toISOString(),
    discovery_views: discoveryViews,
    discovery_errors: discoveryErrors,
    gates: {
      min_liquidity_usd: minLiquidityUsd,
      min_volume_24h_usd: minVolume24hUsd,
      max_top10_holder_pct: maxTop10HolderPct,
      max_price_impact_bps: maxPriceImpactBps
    },
    counters,
    rejection_counts,
    rejection_samples: samples,
    mode: 'SHADOW',
    execution_ready: false,
    execution_dispatched: false,
    transaction_signed: false,
    signer_requested: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    status: 'error',
    probe: 'AETHER_CROSS_VENUE_STAGE_DIAGNOSTIC_SHADOW',
    error: String(error?.message || error),
    mode: 'SHADOW',
    execution_ready: false,
    execution_dispatched: false,
    transaction_signed: false,
    signer_requested: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  }, null, 2));
  process.exitCode = 1;
}
