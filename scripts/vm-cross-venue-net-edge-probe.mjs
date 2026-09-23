import fs from 'node:fs';
import path from 'node:path';
import { createMarketIntelligenceService, normalizeSolanaMint } from '../services/api/src/market-intelligence.mjs';
import { createSolanaHolderConcentrationService } from '../services/api/src/solana-holder-concentration.mjs';
import { createJupiterQuoteEvidenceService } from '../services/api/src/jupiter-quote-evidence.mjs';
import { createJupiterUnsignedSimulationService } from '../services/api/src/jupiter-unsigned-simulation.mjs';
import { createRaydiumReadonlyQuoteService } from '../services/api/src/raydium-readonly-quote.mjs';
import { createRaydiumNativeReadonlyQuoteService } from '../services/api/src/raydium-native-readonly-quote.mjs';
import { createOrcaReadonlyQuoteService } from '../services/api/src/orca-readonly-quote.mjs';
import { createMeteoraNativeReadonlyQuoteService } from '../services/api/src/meteora-native-readonly-quote.mjs';
import { createNativeRoundTripSimulationService } from '../services/api/src/native-roundtrip-simulation.mjs';
import { createJupiterDirectReadonlyLegService } from '../services/api/src/jupiter-direct-readonly-leg.mjs';
import { createDexScreenerPoolUniverseService } from '../services/api/src/dexscreener-pool-universe.mjs';
import {
  computeExecutableRoundTripEdgeBps,
  finalizeExpectedNetEdge,
  rankCrossVenueReportPairs
} from '../services/api/src/cross-venue-net-edge.mjs';

const JUPITER_ORIGIN = 'https://api.jup.ag';
const JUPITER_PUBLIC_ORIGIN = 'https://lite-api.jup.ag';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_USDC_ORCA_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const SOL_USDC_RAYDIUM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SOL_USDC_RAYDIUM_CLMM_POOL = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';
const SOL_USDC_METEORA_DLMM_POOL = 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR';
const REAL_MARKET_ROUTE_ANCHORS_ENABLED = String(process.env.AETHER_REAL_MARKET_ROUTE_ANCHORS_ENABLED || 'true').toLowerCase() === 'true';
const DISCOVERY_VIEWS = new Set(['trending', 'new', 'gainers', 'volume']);
const apiKey = String(process.env.JUPITER_API_KEY || '').trim();
const preferJupiterPublic = String(process.env.AETHER_JUPITER_PREFER_PUBLIC || 'false').toLowerCase() === 'true';
const primaryRpcUrl = String(process.env.SOLANA_RPC_URL || '').trim();
const fallbackRpcUrl = String(process.env.AETHER_READONLY_RPC_FALLBACK_URL || 'https://api.mainnet-beta.solana.com').trim();
let activeRpcUrl = primaryRpcUrl;
let rpcProviderPath = 'PRIMARY';
let rpcPrimaryHealth = 'UNKNOWN';
const legacyView = String(process.env.AETHER_MARKET_VIEW || '').trim().toLowerCase();
const discoveryViewsRaw = String(process.env.AETHER_MARKET_VIEWS || legacyView || 'trending,gainers,volume');
const discoveryViews = [...new Set(discoveryViewsRaw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
if (!discoveryViews.length || discoveryViews.some(item => !DISCOVERY_VIEWS.has(item))) throw new Error('invalid_market_discovery_views');
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 20);
const perViewLimit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 20;
const candidateLimitRaw = Number(process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT || 0);
// 0 means no token-count cap: every real-market token discovered in this scan is eligible for NET-edge evaluation.
const candidateLimit = Number.isSafeInteger(candidateLimitRaw) && candidateLimitRaw > 0 ? candidateLimitRaw : null;
const scanSequenceRaw = Number(process.env.AETHER_SCAN_SEQUENCE || 0);
const scanSequence = Number.isSafeInteger(scanSequenceRaw) && scanSequenceRaw >= 0 ? scanSequenceRaw : 0;
// Per-scan work budget only. The window rotates across the whole discovered
// universe, so this never becomes a permanent token or transaction cap.
const hotPathTokenBudgetRaw = Number(process.env.AETHER_HOTPATH_TOKEN_BUDGET || 8);
const hotPathTokenBudget = Number.isSafeInteger(hotPathTokenBudgetRaw)
  ? Math.max(1, Math.min(24, hotPathTokenBudgetRaw))
  : 8;
const tokenPacingRaw = Number(process.env.AETHER_NATIVE_TOKEN_PACING_MS || 120);
const nativeTokenPacingMs = Number.isFinite(tokenPacingRaw)
  ? Math.max(0, Math.min(500, tokenPacingRaw))
  : 120;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 0));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 0));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const holderGateOnHotPath = String(process.env.AETHER_HOTPATH_HOLDER_GATE || 'false').toLowerCase() === 'true';
const hotPathExactOutEnabled = String(process.env.AETHER_HOTPATH_EXACT_OUT || 'false').toLowerCase() === 'true';
const workerCountRaw = Number(process.env.AETHER_HOTPATH_WORKERS || 1);
// Provider/RPC pressure is a reliability gate, not a throughput target. Two
// concurrent token evaluations is the hard ceiling; transaction count remains uncapped.
const hotPathWorkers = Number.isSafeInteger(workerCountRaw) ? Math.min(2, Math.max(1, workerCountRaw)) : 1;
const maxPriceImpactBps = Math.max(0, Number(process.env.SIGNAL_MAX_PRICE_IMPACT_BPS || 100));
const quoteUsdcRaw = String(process.env.AETHER_JUPITER_QUOTE_USDC_RAW || '500000000').trim();
const paperCapitalUsdc = Math.max(1, Number(process.env.AETHER_PAPER_CAPITAL_USDC || 500));
const paperPositionSizePct = Math.max(1, Math.min(25, Number(process.env.AUTOTRADE_PAPER_POSITION_SIZE_PCT || 25)));
const maxProbeNotionalUsdc = Math.max(0.01, Number(quoteUsdcRaw) / 1_000_000);
const simulationWarmUsdcRaw = String(Math.max(
  1,
  Math.round(Math.min(maxProbeNotionalUsdc, paperCapitalUsdc * paperPositionSizePct / 100) * 1_000_000)
));
const interRequestDelayRaw = Number(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || (apiKey ? 1100 : 2200));
const interRequestDelayMs = Number.isFinite(interRequestDelayRaw) ? Math.max(0, interRequestDelayRaw) : (apiKey ? 1100 : 2200);
const minNetEdgeBps = Math.max(0, Number(process.env.AUTOTRADE_PAPER_MIN_NET_EDGE_BPS || 0.5));
const dexPairAttemptsRaw = Number(process.env.AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS || 6);
const maxDexPairAttempts = Number.isSafeInteger(dexPairAttemptsRaw) ? Math.min(12, Math.max(1, dexPairAttemptsRaw)) : 6;
const fastPathPairLimitRaw = Number(process.env.AETHER_FASTPATH_PAIR_LIMIT || 2);
const fastPathPairLimit = Number.isSafeInteger(fastPathPairLimitRaw) ? Math.min(4, Math.max(1, fastPathPairLimitRaw)) : 2;
const nativeDirectPairLimitRaw = Number(process.env.AETHER_NATIVE_DIRECT_PAIR_LIMIT || 8);
const nativeDirectPairLimit = Number.isSafeInteger(nativeDirectPairLimitRaw)
  ? Math.min(12, Math.max(1, nativeDirectPairLimitRaw))
  : 8;
const nativeExactPairLimitRaw = Number(process.env.AETHER_NATIVE_EXACT_PAIR_LIMIT || 2);
const nativeExactPairLimit = Number.isSafeInteger(nativeExactPairLimitRaw)
  ? Math.min(2, Math.max(1, nativeExactPairLimitRaw))
  : 2;
const nativePreflightEnabled = String(process.env.AETHER_NATIVE_PREFLIGHT_ENABLED || 'false').toLowerCase() === 'true';
const maxOpportunityAgeMs = Math.max(400, Math.min(3000, Number(process.env.AETHER_MAX_OPPORTUNITY_AGE_MS || 3000)));
const analysisSlaMs = 300;
const paperExecutionSlaMs = Math.max(500, Math.min(3000, Number(process.env.AETHER_PAPER_EXECUTION_SLA_MS || 3000)));
const SHADOW_DEX_FAMILIES = Object.freeze(['ORCA','RAYDIUM','METEORA','PUMPFUN','PHOENIX']);
const DIRECT_POOL_PROGRAM = Object.freeze({
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': Object.freeze({ family: 'ORCA', jupiter_label: 'Whirlpool', native_supported: true }),
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1': Object.freeze({ family: 'ORCA', jupiter_label: 'Orca V1', native_supported: false }),
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': Object.freeze({ family: 'ORCA', jupiter_label: 'Orca V2', native_supported: false }),
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': Object.freeze({ family: 'RAYDIUM', jupiter_label: 'Raydium', native_supported: true }),
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h': Object.freeze({ family: 'RAYDIUM', jupiter_label: 'Raydium', native_supported: true }),
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': Object.freeze({ family: 'RAYDIUM', jupiter_label: 'Raydium CLMM', native_supported: true }),
  // Native quote + unsigned build + simulation support is implemented in
  // raydium-native-readonly-quote.mjs; keep CPMM inside the executable universe.
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': Object.freeze({ family: 'RAYDIUM', jupiter_label: 'Raydium CP', native_supported: true }),
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': Object.freeze({ family: 'RAYDIUM', jupiter_label: 'Raydium Launchlab', native_supported: false }),
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': Object.freeze({ family: 'METEORA', jupiter_label: 'Meteora DLMM', native_supported: true }),
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': Object.freeze({ family: 'METEORA', jupiter_label: 'Meteora DAMM v2', native_supported: false }),
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': Object.freeze({ family: 'METEORA', jupiter_label: 'Meteora', native_supported: false }),
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': Object.freeze({ family: 'PUMPFUN', jupiter_label: 'Pump.fun Amm', native_supported: false }),
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': Object.freeze({ family: 'PUMPFUN', jupiter_label: 'Pump.fun', native_supported: false }),
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': Object.freeze({ family: 'PHOENIX', jupiter_label: 'Phoenix', native_supported: false })
});

function shadowDexFamily(label) {
  const value = String(label || '').trim().toUpperCase();
  if (value === 'WHIRLPOOL' || value.startsWith('ORCA ' ) || value === 'ORCA') return 'ORCA';
  if (value.startsWith('RAYDIUM ' ) || value === 'RAYDIUM') return 'RAYDIUM';
  if (value.startsWith('METEORA ' ) || value === 'METEORA') return 'METEORA';
  if (value === 'PUMPSWAP' || value === 'PUMPFUN' || value.startsWith('PUMP.FUN')) return 'PUMPFUN';
  if (value === 'PHOENIX') return 'PHOENIX';
  return null;
}

function observedRouteDexes(quoteEvidence) {
  const sides = [quoteEvidence?.buy, quoteEvidence?.sell];
  return sides.flatMap(side => Array.isArray(side?.amm_labels) ? side.amm_labels : [])
    .map(label => ({ label: String(label || '').trim(), family: shadowDexFamily(label) }))
    .filter(item => item.label && item.family);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function rpcHealth(url, timeoutMs = 1800) {
  if (!url) return Object.freeze({ ok: false, reason: 'UNCONFIGURED' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'processed' }]
      }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (response.status === 429) return Object.freeze({ ok: false, reason: 'RATE_LIMITED' });
    if (!response.ok) {
      return Object.freeze({
        ok: false,
        reason: response.status >= 500 ? 'UPSTREAM_5XX' : 'HTTP_ERROR'
      });
    }
    const body = await response.json();
    if (body?.error || !body?.result?.value?.blockhash) {
      return Object.freeze({ ok: false, reason: 'RPC_ERROR' });
    }
    return Object.freeze({ ok: true, reason: 'OK' });
  } catch (error) {
    if (error?.name === 'AbortError') return Object.freeze({ ok: false, reason: 'TIMEOUT' });
    return Object.freeze({ ok: false, reason: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timer);
  }
}

async function selectReadonlyRpcEndpoint() {
  if (!primaryRpcUrl) throw new Error('solana_rpc_url_required');
  const primary = await rpcHealth(primaryRpcUrl);
  rpcPrimaryHealth = primary.reason;
  if (primary.ok) return Object.freeze({ url: primaryRpcUrl, path: 'PRIMARY', failover: false });

  // A 429 is a provider capacity signal and must be respected rather than
  // bypassed. Failover is reserved for upstream/network outages (5xx, timeout,
  // transport failure), which prevents a single broken endpoint from disabling
  // the real-market execution pipeline.
  const failoverAllowed = ['UPSTREAM_5XX', 'TIMEOUT', 'NETWORK_ERROR'].includes(primary.reason);
  if (failoverAllowed && fallbackRpcUrl && fallbackRpcUrl !== primaryRpcUrl) {
    const fallback = await rpcHealth(fallbackRpcUrl);
    if (fallback.ok) return Object.freeze({ url: fallbackRpcUrl, path: 'READONLY_FALLBACK', failover: true });
  }
  return Object.freeze({ url: primaryRpcUrl, path: 'PRIMARY_DEGRADED', failover: false });
}

function createAsyncSlot(limit) {
  let active = 0;
  const waiters = [];
  return async task => {
    if (active >= limit) await new Promise(resolve => waiters.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

const nativeRpcConcurrencyRaw = Number(process.env.AETHER_NATIVE_RPC_CONCURRENCY || 1);
const nativeRpcConcurrency = Number.isSafeInteger(nativeRpcConcurrencyRaw)
  ? Math.max(1, Math.min(4, nativeRpcConcurrencyRaw))
  : 1;
const nativeWarmConcurrencyRaw = Number(process.env.AETHER_NATIVE_WARM_CONCURRENCY || 1);
const nativeWarmConcurrency = Number.isSafeInteger(nativeWarmConcurrencyRaw)
  ? Math.max(1, Math.min(2, nativeWarmConcurrencyRaw))
  : 1;
const nativeRpcSlot = createAsyncSlot(nativeRpcConcurrency);
const withNativeWarmSlot = createAsyncSlot(nativeWarmConcurrency);
let nativeRpcBackoffUntilMs = 0;
let nativeRpcBackoffMs = 500;

function isNativeRateLimitError(error) {
  return /429|too many requests|rate.?limit|8100002/i.test(String(error?.message || error || ''));
}

function isTransientNativeProviderError(error) {
  const message = String(error?.message || error || '');
  return isNativeRateLimitError(error) ||
    /timeout|network|fetch failed|ECONN|RPC_ERROR/i.test(message);
}

function noteNativeRateLimit() {
  nativeRpcBackoffUntilMs = Math.max(nativeRpcBackoffUntilMs, Date.now() + nativeRpcBackoffMs);
  nativeRpcBackoffMs = Math.min(4000, nativeRpcBackoffMs * 2);
}

async function respectNativeRateLimitBackoff() {
  const waitMs = Math.max(0, nativeRpcBackoffUntilMs - Date.now());
  if (waitMs > 0) await sleep(waitMs);
}

async function withNativeRpcSlot(task, { waitForProviderBackoff = false } = {}) {
  return nativeRpcSlot(async () => {
    // Never spend the <=300 ms decision window sleeping on a provider-wide
    // backoff. Warm/metadata work may wait; hot cached quotes and simulation
    // either complete immediately or fail closed so another independent route
    // can still be evaluated.
    if (waitForProviderBackoff) await respectNativeRateLimitBackoff();
    try {
      const value = await task();
      nativeRpcBackoffMs = Math.max(500, Math.floor(nativeRpcBackoffMs * 0.75));
      return value;
    } catch (error) {
      if (isNativeRateLimitError(error)) noteNativeRateLimit();
      throw error;
    }
  });
}

let nextJupiterRequestAt = 0;
async function paceJupiterRequest() {
  const waitMs = Math.max(0, nextJupiterRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextJupiterRequestAt = Date.now() + interRequestDelayMs;
}
function finite(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }

function candidateDiscoveryScore(row) {
  const liquidity = finite(row?.liquidity_usd) ?? 0;
  const volume = finite(row?.volume_24h_usd) ?? 0;
  return liquidity + volume;
}

function candidateReferenceOpportunityBps(row) {
  const pools = Array.isArray(row?._aether_discovery_pools) ? row._aether_discovery_pools : [];
  let best = null;
  for (const quoteMint of [USDC_MINT, WSOL_MINT]) {
    if (quoteMint === String(row?.primary_mint || '')) continue;
    const eligible = pools.filter(pool => {
      const family = pool?.family || shadowDexFamily(pool?.dex_id);
      const price = finite(pool?.token_price_usd);
      const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
      return family && price !== null && price > 0 &&
        pair.has(String(row?.primary_mint || '')) &&
        pair.has(quoteMint);
    });
    for (const buy of eligible) {
      for (const sell of eligible) {
        const buyFamily = buy?.family || shadowDexFamily(buy?.dex_id);
        const sellFamily = sell?.family || shadowDexFamily(sell?.dex_id);
        // Discovery/ranking must obey the same route rule as execution:
        // two distinct pools on two distinct DEX families.
        if (!buyFamily || !sellFamily || buyFamily === sellFamily) continue;
        if (String(buy?.pool_address || '') === String(sell?.pool_address || '')) continue;
        const buyPrice = finite(buy?.token_price_usd);
        const sellPrice = finite(sell?.token_price_usd);
        if (!(buyPrice > 0) || !(sellPrice > 0)) continue;
        const spread = (sellPrice / buyPrice - 1) * 10_000;
        if (best === null || spread > best) best = spread;
      }
    }
  }
  return best;
}

function candidateReferenceOpportunityScoreUsd(row) {
  const pools = Array.isArray(row?._aether_discovery_pools) ? row._aether_discovery_pools : [];
  const rankingNotionalCap = Math.max(0.01, Math.min(maxProbeNotionalUsdc, paperCapitalUsdc * 0.25));
  let best = null;
  for (const quoteMint of [USDC_MINT, WSOL_MINT]) {
    if (quoteMint === String(row?.primary_mint || '')) continue;
    const eligible = pools.filter(pool => {
      const family = pool?.family || shadowDexFamily(pool?.dex_id);
      const price = finite(pool?.token_price_usd);
      const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
      return family && price !== null && price > 0 &&
        pair.has(String(row?.primary_mint || '')) &&
        pair.has(quoteMint);
    });
    for (const buy of eligible) {
      for (const sell of eligible) {
        const buyFamily = buy?.family || shadowDexFamily(buy?.dex_id);
        const sellFamily = sell?.family || shadowDexFamily(sell?.dex_id);
        // Discovery/ranking must obey the same route rule as execution:
        // two distinct pools on two distinct DEX families.
        if (!buyFamily || !sellFamily || buyFamily === sellFamily) continue;
        if (String(buy?.pool_address || '') === String(sell?.pool_address || '')) continue;
        const buyPrice = finite(buy?.token_price_usd);
        const sellPrice = finite(sell?.token_price_usd);
        if (!(buyPrice > 0) || !(sellPrice > 0)) continue;
        const spreadBps = (sellPrice / buyPrice - 1) * 10_000;
        if (!(spreadBps > 0)) continue;
        const liquidities = [finite(buy?.liquidity_usd), finite(sell?.liquidity_usd)]
          .filter(value => value !== null && value > 0);
        const liquidityBound = liquidities.length === 2
          ? Math.min(...liquidities) * 0.005
          : 0.01;
        const feasibleNotionalUsdc = Math.max(0.01, Math.min(rankingNotionalCap, liquidityBound));
        // DexScreener reference prices are a discovery hint, not execution evidence.
        // Cap only the ranking contribution from extreme reference dislocations so
        // deep, realistically executable pools are evaluated before tiny/stale
        // outliers. The executable quote itself remains uncapped and authoritative.
        const rankingSpreadBps = Math.min(spreadBps, 300);
        const expectedGrossUsdc = feasibleNotionalUsdc * rankingSpreadBps / 10_000;
        if (best === null || expectedGrossUsdc > best) best = expectedGrossUsdc;
      }
    }
  }
  return best;
}

function discoveryDexId(row) {
  return String(row?.dex_id || '').trim();
}

function candidateVenueBreadth(row) {
  if (!Array.isArray(row?._aether_discovery_dex_ids)) return 0;
  return new Set(
    row._aether_discovery_dex_ids.map(shadowDexFamily).filter(Boolean)
  ).size;
}

function discoveryPoolEvidence(row) {
  const dexId = discoveryDexId(row);
  const family = shadowDexFamily(dexId);
  const poolAddress = String(row?.pool_address || '').trim();
  if (!family || !poolAddress) return null;
  return {
    dex_id: dexId,
    family,
    pool_address: poolAddress,
    base_mint: String(row?.base_token?.mint || '').trim() || null,
    quote_mint: String(row?.quote_token?.mint || '').trim() || null,
    liquidity_usd: finite(row?.liquidity_usd)
  };
}

function mergeDiscoveryPools(...groups) {
  const byKey = new Map();
  for (const item of groups.flat()) {
    if (!item?.family || !item?.pool_address) continue;
    const key = String(item.family) + ':' + String(item.pool_address);
    const previous = byKey.get(key);
    if (!previous || (finite(item.liquidity_usd) ?? -1) > (finite(previous.liquidity_usd) ?? -1)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function discoveryPoolEvidenceForFamily(row, family, inputMint, outputMint) {
  const wanted = new Set([String(inputMint), String(outputMint)]);
  const matches = (Array.isArray(row?._aether_discovery_pools) ? row._aether_discovery_pools : [])
    .filter(item => {
      if (item?.family !== family || !item?.pool_address) return false;
      const observed = new Set([String(item?.base_mint || ''), String(item?.quote_mint || '')]);
      return observed.size === wanted.size && [...wanted].every(mint => observed.has(mint));
    })
    .sort((a, b) => (finite(b?.liquidity_usd) ?? -1) - (finite(a?.liquidity_usd) ?? -1));
  return matches[0] || null;
}

function discoveryPoolForFamily(row, family, inputMint, outputMint) {
  return discoveryPoolEvidenceForFamily(row, family, inputMint, outputMint)?.pool_address || null;
}

function candidateDirectUsdcReferenceSpreadBps(row) {
  if (String(row?.primary_mint || '') === USDC_MINT) return null;
  const pools = (Array.isArray(row?._aether_discovery_pools) ? row._aether_discovery_pools : [])
    .map(pool => ({ ...pool, family: pool?.family || shadowDexFamily(pool?.dex_id) }))
    .filter(pool => {
      const price = finite(pool?.token_price_usd);
      if (!pool?.family || price === null || price <= 0) return false;
      const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
      return pair.size === 2 && pair.has(String(row?.primary_mint || '')) && pair.has(USDC_MINT);
    });
  let best = null;
  for (const buy of pools) {
    for (const sell of pools) {
      if (!buy.family || !sell.family || buy.family === sell.family) continue;
      if (String(buy.pool_address || '') === String(sell.pool_address || '')) continue;
      const buyPrice = finite(buy.token_price_usd);
      const sellPrice = finite(sell.token_price_usd);
      if (buyPrice === null || sellPrice === null || buyPrice <= 0 || sellPrice <= 0) continue;
      const spread = (sellPrice / buyPrice - 1) * 10_000;
      if (best === null || spread > best) best = spread;
    }
  }
  return best;
}

function compareCandidatePriority(a, b) {
  const aReferenceSpread = candidateDirectUsdcReferenceSpreadBps(a);
  const bReferenceSpread = candidateDirectUsdcReferenceSpreadBps(b);
  const directReferenceDelta = Number(bReferenceSpread !== null) - Number(aReferenceSpread !== null);
  if (directReferenceDelta !== 0) return directReferenceDelta;
  if (aReferenceSpread !== null && bReferenceSpread !== null && aReferenceSpread !== bReferenceSpread) {
    return bReferenceSpread - aReferenceSpread;
  }
  const venueDelta = candidateVenueBreadth(b) - candidateVenueBreadth(a);
  if (venueDelta !== 0) return venueDelta;
  return candidateDiscoveryScore(b) - candidateDiscoveryScore(a);
}

async function getJson(url, timeoutMs = 10000, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (apiKey && url.origin === JUPITER_ORIGIN) headers['x-api-key'] = apiKey;
      let response = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
      if ([401, 403, 429].includes(response.status) && apiKey) {
        const fallbackOrigin = url.origin === JUPITER_ORIGIN ? JUPITER_PUBLIC_ORIGIN : JUPITER_ORIGIN;
        const fallbackUrl = new URL(url.pathname + url.search, fallbackOrigin);
        const fallbackHeaders = { accept: 'application/json' };
        if (fallbackOrigin === JUPITER_ORIGIN) fallbackHeaders['x-api-key'] = apiKey;
        response = await fetch(fallbackUrl, { headers: fallbackHeaders, signal: controller.signal, redirect: 'error' });
      }
      if (response.status === 429) throw new Error('jupiter_rate_limited');
      if (!response.ok) {
        const detail = await response.text();
        if (response.status === 400 && /NO_ROUTES_FOUND|No routes found/i.test(detail)) throw new Error('jupiter_no_route');
        throw new Error(`jupiter_http_${response.status}`);
      }
      const body = await response.json();
      if (!body || typeof body !== 'object') throw new Error('jupiter_invalid_payload');
      if (body.error) throw new Error('jupiter_no_route');
      return body;
    } catch (error) {
      lastError = error;
      const retryable = String(error?.message || error) === 'jupiter_rate_limited' || error?.name === 'AbortError';
      if (!retryable || attempt >= retries) throw error?.name === 'AbortError' ? new Error('jupiter_timeout') : error;
      await sleep(Math.min(15000, interRequestDelayMs * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function rpc(method, params, timeoutMs = 10000) {
  if (!activeRpcUrl) throw new Error('solana_rpc_url_required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(activeRpcUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`solana_rpc_http_${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`solana_rpc_${method}_error`);
    return body?.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function jupiterQuote({
  inputMint,
  outputMint,
  amount,
  dex = null,
  onlyDirectRoutes = false,
  swapMode = 'ExactIn',
  timeoutMs = null,
  retries = null
}) {
  await paceJupiterRequest();
  const mode = String(swapMode || 'ExactIn');
  if (!['ExactIn', 'ExactOut'].includes(mode)) throw new Error('jupiter_swap_mode_invalid');
  const url = new URL('/swap/v1/quote', preferJupiterPublic || !apiKey ? JUPITER_PUBLIC_ORIGIN : JUPITER_ORIGIN);
  url.searchParams.set('inputMint', normalizeSolanaMint(inputMint));
  url.searchParams.set('outputMint', normalizeSolanaMint(outputMint));
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('swapMode', mode);
  url.searchParams.set('slippageBps', String(Math.max(1, Math.trunc(Number(process.env.SIGNAL_MAX_SLIPPAGE_BPS || 100)))));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  url.searchParams.set('instructionVersion', 'V2');
  if (dex) url.searchParams.set('dexes', dex);
  if (onlyDirectRoutes) url.searchParams.set('onlyDirectRoutes', 'true');
  // A direct-leg request must remain direct. Falling back to an indirect
  // Jupiter route here both violates the intended two-pool route identity and
  // burns the <=300 ms decision budget before being rejected later.
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(50, Math.min(5000, Number(timeoutMs)))
    : 1000;
  const requestRetries = Number.isSafeInteger(Number(retries))
    ? Math.max(0, Math.min(4, Number(retries)))
    : 0;
  return getJson(url, requestTimeoutMs, requestRetries);
}

function observedMaxPriceImpactBps(buy, sell) {
  const buyPct = finite(buy?.priceImpactPct);
  const sellPct = finite(sell?.priceImpactPct);
  if (buyPct === null || sellPct === null) return null;
  return Math.max(buyPct, sellPct) * 10000;
}

async function programLabels() {
  await paceJupiterRequest();
  const url = new URL('/swap/v1/program-id-to-label', preferJupiterPublic || !apiKey ? JUPITER_PUBLIC_ORIGIN : JUPITER_ORIGIN);
  const body = await getJson(url);
  return body;
}

async function ownerPrograms(addresses) {
  if (!addresses.length) return new Map();
  const result = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  const values = Array.isArray(result?.value) ? result.value : [];
  const map = new Map();
  addresses.forEach((address, index) => {
    const owner = values[index]?.owner;
    if (owner) map.set(address, String(owner));
  });
  return map;
}

const nativePoolOwnerCache = new Map();
const poolOwnerCacheDir = String(process.env.AETHER_MARKET_DISCOVERY_CACHE_DIR || '/tmp').trim() || '/tmp';
const poolOwnerCacheFile = String(
  process.env.AETHER_POOL_OWNER_CACHE_FILE || path.join(poolOwnerCacheDir, 'aether-native-pool-owner-cache-v1.json')
);
const poolOwnerCacheMaxAgeMs = Math.max(
  60_000,
  Math.min(7 * 24 * 60 * 60_000, Number(process.env.AETHER_POOL_OWNER_CACHE_TTL_MS || 24 * 60 * 60_000))
);
let poolOwnerCacheDirty = false;

function loadPersistentPoolOwnerCache() {
  try {
    const payload = JSON.parse(fs.readFileSync(poolOwnerCacheFile, 'utf8'));
    if (payload?.schema !== 'aether.native-pool-owner-cache.v1' || typeof payload?.entries !== 'object') return;
    const now = Date.now();
    for (const [address, row] of Object.entries(payload.entries)) {
      const owner = String(row?.owner || '').trim();
      const observedAtMs = Number(row?.observed_at_ms || 0);
      if (!address || !owner || !Number.isFinite(observedAtMs)) continue;
      if (now - observedAtMs > poolOwnerCacheMaxAgeMs) continue;
      nativePoolOwnerCache.set(address, owner);
    }
  } catch {}
}

function persistPoolOwnerCache() {
  if (!poolOwnerCacheDirty) return;
  try {
    fs.mkdirSync(path.dirname(poolOwnerCacheFile), { recursive: true });
    const observedAtMs = Date.now();
    const entries = Object.fromEntries(
      [...nativePoolOwnerCache.entries()].map(([address, owner]) => [
        address,
        { owner, observed_at_ms: observedAtMs }
      ])
    );
    const tmp = poolOwnerCacheFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema: 'aether.native-pool-owner-cache.v1',
      observed_at_ms: observedAtMs,
      entries
    }));
    fs.renameSync(tmp, poolOwnerCacheFile);
    poolOwnerCacheDirty = false;
  } catch {}
}

loadPersistentPoolOwnerCache();

async function supportedNativePoolEvidence(pools) {
  const rows = (Array.isArray(pools) ? pools : []).filter(pool => pool?.pool_address);
  // Internally verified evidence (for example fixed real-market route anchors or
  // a pool already verified earlier in this process) can seed the immutable
  // owner cache. External discovery never supplies program_owner, so it cannot
  // bypass the on-chain owner check.
  for (const pool of rows) {
    const address = String(pool.pool_address);
    const owner = String(pool?.program_owner || '');
    if (owner && DIRECT_POOL_PROGRAM[owner] && nativePoolOwnerCache.get(address) !== owner) {
      nativePoolOwnerCache.set(address, owner);
      poolOwnerCacheDirty = true;
    }
  }
  const missing = [...new Set(rows.map(pool => String(pool.pool_address)).filter(address => !nativePoolOwnerCache.has(address)))];

  // Solana getMultipleAccounts supports bounded batching. Keep owner metadata
  // batched aggressively enough to avoid one RPC request per small group of
  // pools; program ownership is immutable metadata and does not consume the
  // fresh-price SLA budget. Transient failures are still fail-closed.
  const ownerBatchSize = 40;
  for (let offset = 0; offset < missing.length; offset += ownerBatchSize) {
    const batch = missing.slice(offset, offset + ownerBatchSize);
    try {
      const owners = await withNativeRpcSlot(
        () => ownerPrograms(batch),
        { waitForProviderBackoff: true }
      );
      for (const address of batch) {
        const owner = owners.get(address) || null;
        if (owner && nativePoolOwnerCache.get(address) !== owner) {
          nativePoolOwnerCache.set(address, owner);
          poolOwnerCacheDirty = true;
        }
      }
    } catch {
      // Fail closed for this scan only. Unsupported/unverified pools can still
      // use broad aggregator fallback and are never passed to a native decoder.
    }
  }

  persistPoolOwnerCache();

  return rows.flatMap(pool => {
    const owner = nativePoolOwnerCache.get(String(pool.pool_address)) || null;
    const program = owner ? DIRECT_POOL_PROGRAM[owner] || null : null;
    if (!program) return [];
    return [{
      ...pool,
      program_owner: owner,
      family: program.family,
      jupiter_label: program.jupiter_label,
      native_supported: program.native_supported === true
    }];
  });
}

async function solUsdReference({ poolUniverseService = null, raydiumService = null } = {}) {
  // SOL/USD is required to size WSOL-quoted opportunities and convert exact
  // lamport costs into USD. It must not depend on Jupiter availability because
  // a Jupiter 429 previously disabled the entire WSOL opportunity universe.
  if (poolUniverseService?.getTokenPools) {
    try {
      const universe = await poolUniverseService.getTokenPools(WSOL_MINT);
      const references = (universe?.pools || [])
        .filter(pool => {
          const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
          const price = finite(pool?.token_price_usd);
          return pair.size === 2 && pair.has(WSOL_MINT) && pair.has(USDC_MINT) &&
            price !== null && price > 0 && (finite(pool?.liquidity_usd) ?? 0) >= 100_000;
        })
        .sort((a, b) => (finite(b?.liquidity_usd) ?? 0) - (finite(a?.liquidity_usd) ?? 0))
        .slice(0, 7)
        .map(pool => finite(pool?.token_price_usd))
        .filter(value => value !== null && value > 0)
        .sort((a, b) => a - b);
      if (references.length) {
        const median = references[Math.floor(references.length / 2)];
        if (Number.isFinite(median) && median > 0) return median;
      }
    } catch {}
  }

  if (raydiumService?.quote) {
    try {
      const quote = await raydiumService.quote({
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amount: '100000000',
        slippageBps: 10,
        poolAddress: SOL_USDC_RAYDIUM_POOL
      });
      const raw = Number(quote?.outputAmount ?? quote?.outAmount);
      if (Number.isFinite(raw) && raw > 0) return (raw / 1_000_000) * 10;
    } catch {}
  }

  try {
    const quote = await jupiterQuote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: '1000000000' });
    const raw = Number(quote?.outAmount);
    if (Number.isFinite(raw) && raw > 0) return raw / 1_000_000;
  } catch {}

  throw new Error('sol_usdc_reference_unavailable');
}

const rpcSelection = await selectReadonlyRpcEndpoint();
activeRpcUrl = rpcSelection.url;
rpcProviderPath = rpcSelection.path;

// Respect an explicit provider-capacity signal. A short-lived probe previously
// continued into owner lookups, pool warming and simulation after the health
// check had already returned 429, which multiplied the overload and looked like
// thousands of "market rejects". Return a neutral SHADOW capacity result; the
// long-running runtime applies an adaptive cooldown before the next scan.
if (rpcPrimaryHealth === 'RATE_LIMITED') {
  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
    observed_at: new Date().toISOString(),
    provider_capacity_blocked: true,
    provider_capacity_reason: 'RPC_RATE_LIMITED',
    candidates_discovered: 0,
    candidates_scanned: 0,
    rpc_provider_path: rpcProviderPath,
    rpc_primary_health: rpcPrimaryHealth,
    rpc_failover_active: false,
    results: [],
    mode: 'SHADOW',
    execution_ready: false,
    execution_dispatched: false,
    transaction_signed: false,
    signer_requested: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  }, null, 2));
  process.exit(0);
}

const market = createMarketIntelligenceService({ timeoutMs: 8000 });
const holders = createSolanaHolderConcentrationService({ timeoutMs: 8000 });
const hotPathTimeoutMs = Math.max(150, Math.min(750, Number(process.env.AETHER_HOTPATH_REQUEST_TIMEOUT_MS || 250)));
const quotes = createJupiterQuoteEvidenceService({ timeoutMs: hotPathTimeoutMs, interQuoteDelayMs: 0, maxRetries: 0 });
const shadowSimulationPublicKey = String(process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '').trim();
const unsigned = shadowSimulationPublicKey
  ? createJupiterUnsignedSimulationService({ timeoutMs: hotPathTimeoutMs, interSwapDelayMs: 0, maxSwapRetries: 0 })
  : null;
const raydium = createRaydiumReadonlyQuoteService({ timeoutMs: hotPathTimeoutMs, cacheTtlMs: 250 });
const raydiumNative = createRaydiumNativeReadonlyQuoteService({ rpcUrl: activeRpcUrl, timeoutMs: hotPathTimeoutMs, poolSnapshotTtlMs: 2850 });
const orca = createOrcaReadonlyQuoteService({ rpcUrl: activeRpcUrl, timeoutMs: hotPathTimeoutMs, poolCacheTtlMs: 10 * 60_000, snapshotCacheTtlMs: 2850 });
const meteoraNative = createMeteoraNativeReadonlyQuoteService({ rpcUrl: activeRpcUrl, timeoutMs: hotPathTimeoutMs, stateTtlMs: 2850 });
const nativeRoundTrip = createNativeRoundTripSimulationService({ rpcUrl: activeRpcUrl });
const jupiterDirect = createJupiterDirectReadonlyLegService({
  rpcUrl: activeRpcUrl,
  apiKey,
  timeoutMs: Math.max(1500, hotPathTimeoutMs * 3),
  preferPublic: preferJupiterPublic
});
const poolUniverse = createDexScreenerPoolUniverseService({ timeoutMs: 5000, cacheTtlMs: 20_000 });

try {
  // Warm provider code/connection objects before the per-opportunity SLA clock.
  // This does not cache market prices; every executable quote still reads fresh pool state.
  try { await raydiumNative.warm(); } catch {}
  const nativeSimulationOwnerWarm = {};
  try {
    nativeSimulationOwnerWarm.usdc = await nativeRoundTrip.warmSimulationOwner({
      inputMint: USDC_MINT,
      minimumInputAmount: simulationWarmUsdcRaw
    });
  } catch {}
  let solUsd = null;
  try {
    solUsd = await solUsdReference({
      poolUniverseService: poolUniverse,
      raydiumService: raydiumNative
    });
  } catch {}
  if (Number.isFinite(Number(solUsd)) && Number(solUsd) > 0) {
    const maxPaperNotionalUsdc = Math.max(
      0.01,
      Math.min(maxProbeNotionalUsdc, paperCapitalUsdc * 0.25)
    );
    const simulationWarmWsolRaw = String(Math.max(
      1,
      Math.ceil(maxPaperNotionalUsdc / Number(solUsd) * 1_000_000_000)
    ));
    try {
      nativeSimulationOwnerWarm.wsol = await nativeRoundTrip.warmSimulationOwner({
        inputMint: WSOL_MINT,
        minimumInputAmount: simulationWarmWsolRaw
      });
    } catch {}
  }
  let labelsByProgram = {};
  try { labelsByProgram = await programLabels(); } catch {}

  const candidateMap = new Map();
  const discoveryErrors = [];
  let dexScreenerDiscoveryTokensSeen = 0;
  let dexScreenerDiscoveryTokensAdded = 0;
  let dexScreenerDiscoveryVerifiedPools = 0;
  for (const discoveryView of discoveryViews) {
    try {
      const discovery = await market.getDiscovery(discoveryView);
      for (const row of discovery.items.slice(0, perViewLimit)) {
        const key = String(row?.primary_mint || '').trim();
        if (!key) continue;
        const dexId = discoveryDexId(row);
        const existing = candidateMap.get(key);
        if (!existing) {
          const poolEvidence = discoveryPoolEvidence(row);
          candidateMap.set(key, {
            ...row,
            _aether_discovery_dex_ids: dexId ? [dexId] : [],
            _aether_discovery_views: [discoveryView],
            _aether_discovery_pools: poolEvidence ? [poolEvidence] : []
          });
          continue;
        }
        const mergedDexIds = [...new Set([...(existing._aether_discovery_dex_ids || []), ...(dexId ? [dexId] : [])])];
        const mergedViews = [...new Set([...(existing._aether_discovery_views || []), discoveryView])];
        const poolEvidence = discoveryPoolEvidence(row);
        const mergedPools = mergeDiscoveryPools(existing._aether_discovery_pools || [], poolEvidence ? [poolEvidence] : []);
        const preferred = candidateDiscoveryScore(row) > candidateDiscoveryScore(existing) ? row : existing;
        candidateMap.set(key, {
          ...preferred,
          _aether_discovery_dex_ids: mergedDexIds,
          _aether_discovery_views: mergedViews,
          _aether_discovery_pools: mergedPools
        });
      }
    } catch (error) {
      discoveryErrors.push({ view: discoveryView, error: String(error?.message || error) });
    }
  }
  if (String(process.env.AETHER_JUPITER_UNIVERSE_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      await paceJupiterRequest();
      const limit = Math.max(1, Math.min(60, Number(process.env.AETHER_JUPITER_UNIVERSE_LIMIT || 12)));
      const url = new URL('/tokens/v2/toporganicscore/1h', JUPITER_ORIGIN);
      url.searchParams.set('limit', String(limit));
      const tokens = await getJson(url);
      for (const token of Array.isArray(tokens) ? tokens : []) {
        let mint = null;
        try { mint = normalizeSolanaMint(token?.id); } catch { continue; }
        if (!mint || mint === USDC_MINT) continue;
        const liquidity = finite(token?.liquidity) ?? 0;
        const volume = (finite(token?.stats24h?.buyVolume) ?? 0) + (finite(token?.stats24h?.sellVolume) ?? 0);
        const existing = candidateMap.get(mint);
        const row = {
          base_token: { mint, symbol: token?.symbol || null, name: token?.name || null },
          quote_token: { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
          primary_mint: mint,
          dex_id: 'jupiter-universe',
          liquidity_usd: liquidity,
          volume_24h_usd: volume,
          _aether_discovery_dex_ids: ['jupiter-universe'],
          _aether_discovery_views: ['jupiter-toporganicscore']
        };
        if (!existing || candidateDiscoveryScore(row) > candidateDiscoveryScore(existing)) {
          candidateMap.set(mint, existing ? {
            ...row,
            _aether_discovery_dex_ids: [...new Set([...(existing._aether_discovery_dex_ids || []), 'jupiter-universe'])],
            _aether_discovery_views: [...new Set([...(existing._aether_discovery_views || []), 'jupiter-toporganicscore'])]
          } : row);
        }
      }
    } catch (error) {
      discoveryErrors.push({ view: 'jupiter-toporganicscore', error: String(error?.message || error) });
    }
  }

  if (String(process.env.AETHER_DEXSCREENER_DISCOVERY_ENABLED || 'true').toLowerCase() === 'true') {
    try {
      const discoveryLimit = Math.max(0, Math.min(40, Number(process.env.AETHER_DEXSCREENER_DISCOVERY_LIMIT ?? 8)));
      if (discoveryLimit === 0) throw new Error('dexscreener_discovery_disabled_by_budget');
      const discovered = await poolUniverse.getDiscoveryTokens({ limit: discoveryLimit });
      dexScreenerDiscoveryTokensSeen = Array.isArray(discovered?.tokens) ? discovered.tokens.length : 0;
      for (const token of discovered?.tokens || []) {
        const mint = String(token?.mint || '').trim();
        if (!mint || mint === USDC_MINT || mint === WSOL_MINT || candidateMap.has(mint)) continue;
        try {
          const universe = await poolUniverse.getTokenPools(mint);
          const directRaw = (universe.pools || [])
            .filter(pool => {
              if (!shadowDexFamily(pool?.dex_id)) return false;
              const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
              return pair.size === 2 && pair.has(mint) && (pair.has(USDC_MINT) || pair.has(WSOL_MINT));
            })
            .sort((a, b) =>
              (finite(b?.liquidity_usd) ?? -1) - (finite(a?.liquidity_usd) ?? -1) ||
              (finite(b?.volume_24h_usd) ?? -1) - (finite(a?.volume_24h_usd) ?? -1)
            )
            .slice(0, 12);
          const discoveredPools = directRaw.map(pool => ({
            ...pool,
            family: shadowDexFamily(pool.dex_id)
          }));
          if (!discoveredPools.length) continue;
          // Discovery labels are only a cheap ranking hint. Do NOT perform one
          // owner-program RPC call per newly discovered token here: that turns a
          // broad universe into minute-long cold-start work. Pool ownership is
          // verified later in the bounded enrichment/hot path before any native
          // decoder, quote, build or PAPER decision can use the pool.
          const top = discoveredPools[0];
          const tokenIsBase = String(top.base_mint) === mint;
          const tokenSymbol = tokenIsBase ? top.base_symbol : top.quote_symbol;
          const tokenName = tokenIsBase ? top.base_name : top.quote_name;
          const quoteMint = tokenIsBase ? top.quote_mint : top.base_mint;
          candidateMap.set(mint, {
            base_token: { mint, symbol: tokenSymbol || null, name: tokenName || null },
            quote_token: {
              mint: quoteMint,
              symbol: quoteMint === USDC_MINT ? 'USDC' : quoteMint === WSOL_MINT ? 'SOL' : null,
              name: null
            },
            primary_mint: mint,
            dex_id: top.dex_id || 'dexscreener-discovery',
            liquidity_usd: finite(top.liquidity_usd) ?? 0,
            volume_24h_usd: finite(top.volume_24h_usd) ?? 0,
            price_usd: finite(top.token_price_usd),
            _aether_discovery_dex_ids: [...new Set(discoveredPools.map(pool => pool.dex_id).filter(Boolean))],
            _aether_discovery_views: [token.discovery_source || 'dexscreener-discovery'],
            _aether_discovery_pools: discoveredPools,
            _aether_pool_universe_enriched: false
          });
          dexScreenerDiscoveryTokensAdded += 1;
        } catch (error) {
          discoveryErrors.push({
            view: 'dexscreener-discovery-token',
            token_mint: mint,
            error: String(error?.message || error)
          });
        }
        await sleep(90);
      }
    } catch (error) {
      discoveryErrors.push({ view: 'dexscreener-discovery', error: String(error?.message || error) });
    }
  }

  // Always-on route anchors are verified real pools, not synthetic prices or
  // fabricated opportunities. They only seed venue/pool identity; every quote,
  // transaction build, fee and simulation result is fetched fresh from mainnet.
  if (REAL_MARKET_ROUTE_ANCHORS_ENABLED) {
    const existing = candidateMap.get(WSOL_MINT);
    const anchorPools = [
      {
        dex_id: 'Orca Whirlpool',
        family: 'ORCA',
        pool_address: SOL_USDC_ORCA_POOL,
        program_owner: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        jupiter_label: 'Whirlpool',
        native_supported: true,
        base_mint: WSOL_MINT,
        quote_mint: USDC_MINT,
        liquidity_usd: null
      },
      {
        dex_id: 'Raydium AMM',
        family: 'RAYDIUM',
        pool_address: SOL_USDC_RAYDIUM_POOL,
        program_owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        jupiter_label: 'Raydium',
        native_supported: true,
        base_mint: WSOL_MINT,
        quote_mint: USDC_MINT,
        liquidity_usd: null
      },
      {
        dex_id: 'Raydium CLMM',
        family: 'RAYDIUM',
        pool_address: SOL_USDC_RAYDIUM_CLMM_POOL,
        program_owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
        jupiter_label: 'Raydium CLMM',
        native_supported: true,
        base_mint: WSOL_MINT,
        quote_mint: USDC_MINT,
        liquidity_usd: null
      },
      {
        dex_id: 'Meteora DLMM',
        family: 'METEORA',
        pool_address: SOL_USDC_METEORA_DLMM_POOL,
        program_owner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
        jupiter_label: 'Meteora DLMM',
        native_supported: true,
        base_mint: WSOL_MINT,
        quote_mint: USDC_MINT,
        liquidity_usd: null
      }
    ];
    candidateMap.set(WSOL_MINT, {
      ...(existing || {
        base_token: { mint: WSOL_MINT, symbol: 'SOL', name: 'Wrapped SOL' },
        quote_token: { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
        primary_mint: WSOL_MINT,
        dex_id: 'real-market-route-anchor',
        liquidity_usd: 0,
        volume_24h_usd: 0
      }),
      _aether_discovery_dex_ids: [...new Set([...(existing?._aether_discovery_dex_ids || []), 'Orca Whirlpool', 'Raydium AMM', 'Raydium CLMM', 'Meteora DLMM'])],
      _aether_discovery_views: [...new Set([...(existing?._aether_discovery_views || []), 'real-market-route-anchor'])],
      _aether_discovery_pools: mergeDiscoveryPools(existing?._aether_discovery_pools || [], anchorPools),
      _aether_route_anchor: true
    });
  }

  if (!candidateMap.size) throw new Error('market_discovery_unavailable');

  // DexScreener enrichment is a per-scan provider budget, NOT a permanent
  // token-universe cap. Rotate the enrichment window across scan cycles so the
  // same top-ranked 30 tokens cannot starve the rest of the discovered universe.
  // Enrichment is a provider budget, never an execution gate. Keep each scan
  // bounded so a 800ms scheduler cannot accumulate minute-long discovery work.
  const poolUniverseEnrichLimit = Math.max(0, Math.min(40, Number(process.env.AETHER_POOL_UNIVERSE_ENRICH_LIMIT ?? 24)));
  const poolUniverseWorkersRaw = Number(process.env.AETHER_POOL_UNIVERSE_WORKERS || 1);
  const poolUniverseWorkers = Number.isSafeInteger(poolUniverseWorkersRaw)
    ? Math.max(1, Math.min(2, poolUniverseWorkersRaw))
    : 1;
  const orderedUniverseTargets = [...candidateMap.values()].sort((a, b) => {
    // Keep the high-liquidity real SOL route as an always-on health/price anchor,
    // but do not let it consume the rotating coverage of the rest of the market.
    const anchorDelta = Number(b?._aether_route_anchor === true) - Number(a?._aether_route_anchor === true);
    if (anchorDelta !== 0) return anchorDelta;
    return compareCandidatePriority(a, b);
  });
  const eligibleUniverseTargets = candidateLimit === null
    ? orderedUniverseTargets
    : orderedUniverseTargets.slice(0, candidateLimit);
  const anchorTargets = eligibleUniverseTargets.filter(row => row?._aether_route_anchor === true).slice(0, 1);
  const rotatingUniverseTargets = eligibleUniverseTargets.filter(row => row?._aether_route_anchor !== true);
  // Cheap pool discovery must be wider than the expensive executable hot path.
  // First inspect pool metadata for a rotating market window, then spend RPC /
  // native-quote budget only on the best cross-DEX opportunities from that window.
  const coverageBudget = Math.max(hotPathTokenBudget, poolUniverseEnrichLimit);
  const rotatingBudget = Math.max(0, coverageBudget - anchorTargets.length);
  const hotPathRotationOffset = rotatingUniverseTargets.length > rotatingBudget && rotatingBudget > 0
    ? (scanSequence * rotatingBudget) % rotatingUniverseTargets.length
    : 0;
  const hotPathUniversePass = rotatingUniverseTargets.length && rotatingBudget > 0
    ? Math.floor((scanSequence * rotatingBudget) / rotatingUniverseTargets.length)
    : scanSequence;
  const rotatedUniverseTargets = hotPathRotationOffset > 0
    ? [...rotatingUniverseTargets.slice(hotPathRotationOffset), ...rotatingUniverseTargets.slice(0, hotPathRotationOffset)]
    : rotatingUniverseTargets;
  const coverageTargets = [
    ...anchorTargets,
    ...rotatedUniverseTargets.slice(0, rotatingBudget)
  ].slice(0, coverageBudget);
  const coverageMints = new Set(coverageTargets.map(row => String(row.primary_mint || '')));
  const enrichmentTargets = poolUniverseEnrichLimit > 0
    ? coverageTargets.slice(0, poolUniverseEnrichLimit)
    : [];
  let poolUniverseEnrichedTokens = 0;
  let poolUniverseDirectUsdcPools = 0;
  const poolUniverseEnrichedMints = [];
  let nextEnrichmentIndex = 0;

  const enrichWorker = async () => {
    while (true) {
      const index = nextEnrichmentIndex++;
      if (index >= enrichmentTargets.length) return;
      const target = enrichmentTargets[index];
      try {
        const universe = await poolUniverse.getTokenPools(target.primary_mint);
        const discoveredDirectPools = (universe.pools || []).filter(pool => {
          const pair = new Set([String(pool.base_mint || ''), String(pool.quote_mint || '')]);
          const hasSupportedQuote = pair.has(USDC_MINT) || pair.has(WSOL_MINT);
          return pair.size === 2 && pair.has(String(target.primary_mint)) && hasSupportedQuote && shadowDexFamily(pool.dex_id);
        });
        // Pool-universe enrichment is discovery/ranking only. Do not burn an
        // on-chain owner lookup for every market token here. The bounded hot path
        // verifies exact owner programs before any native decoder or PAPER gate.
        const directPools = discoveredDirectPools
          .map(pool => ({ ...pool, family: shadowDexFamily(pool.dex_id) }))
          .filter(pool => pool.family && pool.pool_address);
        if (!directPools.length) continue;
        const existing = candidateMap.get(target.primary_mint) || target;
        candidateMap.set(target.primary_mint, {
          ...existing,
          _aether_discovery_dex_ids: [...new Set([
            ...(existing._aether_discovery_dex_ids || []),
            ...directPools.map(pool => pool.dex_id)
          ])],
          _aether_discovery_views: [...new Set([
            ...(existing._aether_discovery_views || []),
            'dexscreener-token-pairs'
          ])],
          _aether_discovery_pools: mergeDiscoveryPools(existing._aether_discovery_pools || [], directPools),
          _aether_pool_universe_enriched: true
        });
        poolUniverseEnrichedTokens += 1;
        poolUniverseDirectUsdcPools += directPools.length;
        poolUniverseEnrichedMints.push(String(target.primary_mint));
      } catch (error) {
        discoveryErrors.push({
          view: 'dexscreener-token-pairs',
          token_mint: target.primary_mint,
          error: String(error?.message || error)
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(poolUniverseWorkers, enrichmentTargets.length || 1) }, () => enrichWorker())
  );

  const candidateNativeRouteReadiness = candidate => {
    const pools = (Array.isArray(candidate?._aether_discovery_pools) ? candidate._aether_discovery_pools : [])
      .filter(pool => pool?.native_supported === true && pool?.pool_address && pool?.family);
    let best = 0;
    for (const quoteMint of [USDC_MINT, WSOL_MINT]) {
      if (String(candidate?.primary_mint || '') === quoteMint) continue;
      const executableFamilies = new Set(
        pools
          .filter(pool => {
            const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
            return pair.has(String(candidate?.primary_mint || '')) && pair.has(quoteMint);
          })
          .map(pool => String(pool.family))
          .filter(Boolean)
      );
      // A valid arbitrage route must cross two different executable DEX families.
      // Multiple pools on one DEX are routing alternatives, not a cross-DEX trade.
      best = Math.max(best, executableFamilies.size);
    }
    return best;
  };

  const discoveredRows = [...candidateMap.values()].sort((a, b) => {
    // Always inspect the verified SOL/USDC anchor in every scan. It is a real
    // high-liquidity market route, not a synthetic candidate.
    const anchorDelta = Number(b?._aether_route_anchor === true) - Number(a?._aether_route_anchor === true);
    if (anchorDelta !== 0) return anchorDelta;
    // Executability outranks a stale/indicative reference spread. This prevents
    // unsupported venue combinations from consuming the scanner budget while a
    // token with a real 2+ native-DEX route is available.
    const readinessDelta = candidateNativeRouteReadiness(b) - candidateNativeRouteReadiness(a);
    if (readinessDelta !== 0) return readinessDelta;
    const aScoreUsd = candidateReferenceOpportunityScoreUsd(a);
    const bScoreUsd = candidateReferenceOpportunityScoreUsd(b);
    if (aScoreUsd !== null || bScoreUsd !== null) {
      const scoreDelta = (bScoreUsd ?? -Infinity) - (aScoreUsd ?? -Infinity);
      if (scoreDelta !== 0) return scoreDelta;
    }
    const aReference = candidateReferenceOpportunityBps(a);
    const bReference = candidateReferenceOpportunityBps(b);
    if (aReference !== null || bReference !== null) {
      const delta = (bReference ?? -Infinity) - (aReference ?? -Infinity);
      if (delta !== 0) return delta;
    }
    return compareCandidatePriority(a, b);
  });
  if (solUsd === null) {
    const solRow = discoveredRows.find(item => String(item?.primary_mint || '') === WSOL_MINT);
    const discoveredSolUsd = finite(solRow?.price_usd);
    if (discoveredSolUsd !== null && discoveredSolUsd > 0) solUsd = discoveredSolUsd;
  }
  // Opportunity-first hot-path scheduling. Discovery metadata is cheap; exact
  // pool-owner verification, fresh quotes and simulation are expensive. Spend
  // that expensive budget first on tokens that already show a positive CROSS-DEX
  // reference dislocation, then on other multi-venue rows, then on coverage
  // fallbacks. Reference prices never approve a trade; fresh executable quotes do.
  const enrichedMintSet = new Set([
    ...poolUniverseEnrichedMints,
    ...anchorTargets.map(row => String(row.primary_mint || ''))
  ]);
  const positiveReferenceRows = discoveredRows.filter(row =>
    enrichedMintSet.has(String(row.primary_mint || '')) &&
    (candidateReferenceOpportunityScoreUsd(row) ?? 0) > 0
  );
  const crossDexReferenceRows = discoveredRows.filter(row =>
    enrichedMintSet.has(String(row.primary_mint || '')) &&
    candidateReferenceOpportunityBps(row) !== null &&
    !positiveReferenceRows.includes(row)
  );
  const coverageFallbackRows = discoveredRows.filter(row =>
    coverageMints.has(String(row.primary_mint || '')) &&
    !positiveReferenceRows.includes(row) &&
    !crossDexReferenceRows.includes(row)
  );
  const rows = [...positiveReferenceRows, ...crossDexReferenceRows, ...coverageFallbackRows]
    .slice(0, hotPathTokenBudget);
  const results = [];
  const pushResult = result => {
    results.push(result);
    process.stderr.write(`AETHER_EVENT ${JSON.stringify(result)}\n`);
  };

  const processRow = async row => {
    // The anchor is inspected every scan; rotating tokens are revisited only once
    // per universe window. Use the matching epoch so neither class repeatedly
    // selects the same quote asset / pool pair forever.
    const routeRotationEpoch = row?._aether_route_anchor === true ? scanSequence : hotPathUniversePass;
    const liquidity = finite(row.liquidity_usd);
    const volume = finite(row.volume_24h_usd);
    // Liquidity/volume are sizing signals, not token-universe rejection gates.
    // Route validity + post-cost NET EDGE remain the execution decision.
    const riskTierPct = (liquidity ?? 0) >= Math.max(minLiquidityUsd, 100000) && (volume ?? 0) >= Math.max(minVolume24hUsd, 100000) ? 25
      : (liquidity ?? 0) >= Math.max(minLiquidityUsd, 20000) && (volume ?? 0) >= Math.max(minVolume24hUsd, 20000) ? 15
      : 5;
    // Liquidity/volume delegate maximum size only; they do not reject the token.
    // The final trade decision remains executable post-cost NET edge.
    const riskPositionPct = Math.min(paperPositionSizePct, riskTierPct);
    const positionNotionalUsdc = Math.max(
      0.01,
      Math.min(maxProbeNotionalUsdc, paperCapitalUsdc * riskPositionPct / 100)
    );
    const positionQuoteUsdcRaw = String(Math.max(1, Math.round(positionNotionalUsdc * 1_000_000)));
    // Discovery must not assume the maximum risk allocation. A large probe can
    // erase a real small-size cross-DEX dislocation through price impact before
    // the executable sizing stage gets a chance to evaluate it.
    const discoveryNotionalUsdc = Math.max(
      1,
      Math.min(positionNotionalUsdc, Math.max(5, paperCapitalUsdc * 0.01))
    );
    const discoveryQuoteUsdcRaw = String(Math.max(1, Math.round(discoveryNotionalUsdc * 1_000_000)));

    if (holderGateOnHotPath) {
      let holder = null;
      try { holder = await holders.getTop10HolderPct(row.primary_mint); } catch (error) { pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'HOLDER_EVIDENCE_UNAVAILABLE', error: String(error?.message || error), expected_net_edge_bps: null }); return; }
      const top10 = finite(holder?.top10_holder_pct);
      if (top10 === null || top10 > maxTop10HolderPct) { pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'HOLDER_GATE_REJECTED', top10_holder_pct: top10, max_top10_holder_pct: maxTop10HolderPct, expected_net_edge_bps: null }); return; }
    }

    const discoveredDirectPoolEvidence = (Array.isArray(row?._aether_discovery_pools) ? row._aether_discovery_pools : [])
      .map(pool => ({ ...pool, family: pool?.family || shadowDexFamily(pool?.dex_id) }))
      .filter(pool => {
        if (!pool?.pool_address) return false;
        const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
        return pair.size === 2 &&
          pair.has(String(row.primary_mint)) &&
          (pair.has(USDC_MINT) || pair.has(WSOL_MINT));
      });
    const allDirectPoolEvidence = await supportedNativePoolEvidence(discoveredDirectPoolEvidence);

    const directQuoteOptions = [USDC_MINT, WSOL_MINT]
      .filter(quoteMint => quoteMint !== String(row.primary_mint))
      .map(quoteMint => {
      const pools = allDirectPoolEvidence.filter(pool => {
        const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
        return pair.has(String(row.primary_mint)) && pair.has(quoteMint);
      });
      const families = [...new Set(pools.map(pool => pool.family).filter(Boolean))];
      const nativeFamilies = [...new Set(
        pools.filter(pool => pool.native_supported === true).map(pool => pool.family).filter(Boolean)
      )];
      const liquidityScore = pools.reduce((sum, pool) => sum + (finite(pool?.liquidity_usd) ?? 0), 0);
      let fullyNativePairCount = 0;
      for (const buyPool of pools) {
        for (const sellPool of pools) {
          if (
            buyPool.pool_address !== sellPool.pool_address &&
            buyPool.family !== sellPool.family &&
            buyPool.native_supported === true &&
            sellPool.native_supported === true
          ) fullyNativePairCount += 1;
        }
      }
      let bestReferenceSpreadBps = null;
      let bestReferenceExpectedGrossUsdc = null;
      for (const buyPool of pools) {
        for (const sellPool of pools) {
          if (buyPool.pool_address === sellPool.pool_address || buyPool.family === sellPool.family) continue;
          const buyPrice = finite(buyPool?.token_price_usd);
          const sellPrice = finite(sellPool?.token_price_usd);
          if (!(buyPrice > 0) || !(sellPrice > 0)) continue;
          const spreadBps = (sellPrice / buyPrice - 1) * 10_000;
          const buyLiquidity = finite(buyPool?.liquidity_usd);
          const sellLiquidity = finite(sellPool?.liquidity_usd);
          const liquidities = [buyLiquidity, sellLiquidity].filter(value => value !== null && value > 0);
          const referenceNotionalUsdc = liquidities.length === 2
            ? Math.max(0.01, Math.min(positionNotionalUsdc, Math.min(...liquidities) * 0.005))
            : 0.01;
          const expectedGrossUsdc = spreadBps * referenceNotionalUsdc / 10_000;
          if (bestReferenceExpectedGrossUsdc === null || expectedGrossUsdc > bestReferenceExpectedGrossUsdc) {
            bestReferenceExpectedGrossUsdc = expectedGrossUsdc;
            bestReferenceSpreadBps = spreadBps;
          }
        }
      }
      return {
        quote_mint: quoteMint,
        pools,
        families,
        native_families: nativeFamilies,
        native_pair_available: fullyNativePairCount > 0,
        liquidity_score: liquidityScore,
        fully_native_pair_count: fullyNativePairCount,
        best_reference_spread_bps: bestReferenceSpreadBps,
        best_reference_expected_gross_usdc: bestReferenceExpectedGrossUsdc
      };
    }).filter(option =>
      option.families.length >= 2 &&
      new Set(option.pools.map(pool => pool.pool_address)).size >= 2
    );

    directQuoteOptions.sort((a, b) => {
      // A fully native pair can satisfy the <=300 ms decision SLA without
      // waiting on an aggregator. Do not let a stale reference spread on an
      // unsupported pool family steal the hot-path budget from it.
      const nativeDelta = Number((b.fully_native_pair_count || 0) > 0) -
        Number((a.fully_native_pair_count || 0) > 0);
      if (nativeDelta !== 0) return nativeDelta;
      const nativeBreadthDelta = (b.fully_native_pair_count || 0) - (a.fully_native_pair_count || 0);
      if (nativeBreadthDelta !== 0) return nativeBreadthDelta;
      const grossDelta = (b.best_reference_expected_gross_usdc ?? -Infinity) -
        (a.best_reference_expected_gross_usdc ?? -Infinity);
      if (grossDelta !== 0) return grossDelta;
      const spreadDelta = (b.best_reference_spread_bps ?? -Infinity) -
        (a.best_reference_spread_bps ?? -Infinity);
      if (spreadDelta !== 0) return spreadDelta;
      const familyDelta = b.families.length - a.families.length;
      if (familyDelta !== 0) return familyDelta;
      if (a.quote_mint === USDC_MINT && b.quote_mint !== USDC_MINT) return -1;
      if (b.quote_mint === USDC_MINT && a.quote_mint !== USDC_MINT) return 1;
      return b.liquidity_score - a.liquidity_score;
    });

    // Native routes are the primary fast path, but a token can have its only
    // profitable dislocation on WSOL/USDC pools that require a Jupiter-direct
    // atomic leg. Never starve those markets forever: reserve every third route
    // epoch for a non-native quote-asset option when one exists.
    const nativeQuoteOptions = directQuoteOptions.filter(option => (option.fully_native_pair_count || 0) > 0);
    const exploratoryQuoteOptions = directQuoteOptions.filter(option => (option.fully_native_pair_count || 0) === 0);
    let routeOptionCycle = directQuoteOptions;
    if (nativeQuoteOptions.length && exploratoryQuoteOptions.length) {
      routeOptionCycle = routeRotationEpoch % 3 === 2 ? exploratoryQuoteOptions : nativeQuoteOptions;
    } else if (nativeQuoteOptions.length) {
      routeOptionCycle = nativeQuoteOptions;
    }
    const directRouteOption = routeOptionCycle.length
      ? routeOptionCycle[routeRotationEpoch % routeOptionCycle.length]
      : null;
    const routeQuoteMint = directRouteOption?.quote_mint || USDC_MINT;
    const directDiscoveryFamilies = directRouteOption?.families || [];
    const nativeDirectDiscoverySufficient = Boolean(
      directRouteOption &&
      directRouteOption.families.length >= 2 &&
      new Set(directRouteOption.pools.map(pool => pool.pool_address)).size >= 2
    );

    // Broad Jupiter evidence remains a USDC fallback only. Native direct routes may
    // settle in WSOL when that is where the token's real Solana liquidity lives.
    let broad = null;
    let broadError = nativeDirectDiscoverySufficient ? 'native_direct_pool_discovery_sufficient' : null;
    if (!nativeDirectDiscoverySufficient) {
      try { broad = await quotes.getUsdcRoundTripEvidence(row.primary_mint, { usdcAmountRaw: discoveryQuoteUsdcRaw }); }
      catch (error) { broadError = String(error?.message || error); }
    }

    // Jupiter broad evidence is enrichment, not a single point of failure.
    // If it is unavailable/rate-limited, use real discovery venue IDs to form
    // cross-DEX candidates; final approval still requires executable quotes,
    // exact fee evidence and post-cost NET edge.
    const provisional = broad ? rankCrossVenueReportPairs(broad).slice(0, 12) : [];
    const rawDexPairs = [];
    const seenDexPairs = new Set();

    const discoveredFamilies = nativeDirectDiscoverySufficient
      ? directDiscoveryFamilies
      : [...new Set((row._aether_discovery_dex_ids || []).map(shadowDexFamily).filter(Boolean))];

    const directPoolEvidence = nativeDirectDiscoverySufficient
      ? directRouteOption.pools
      : allDirectPoolEvidence.filter(pool => {
          const pair = new Set([String(pool?.base_mint || ''), String(pool?.quote_mint || '')]);
          return pair.has(String(row.primary_mint)) && pair.has(USDC_MINT) && discoveredFamilies.includes(pool.family);
        });
    const directNativePairs = [];
    for (const buyPool of directPoolEvidence) {
      for (const sellPool of directPoolEvidence) {
        // PAPER eligibility requires two distinct executable pools on
        // two different DEX families. Post-cost NET edge is still the economic gate.
        if (buyPool.pool_address === sellPool.pool_address || buyPool.family === sellPool.family) continue;
        const buyReferencePrice = finite(buyPool?.token_price_usd);
        const sellReferencePrice = finite(sellPool?.token_price_usd);
        const referenceSpreadBps = buyReferencePrice !== null && buyReferencePrice > 0 &&
          sellReferencePrice !== null && sellReferencePrice > 0
          ? (sellReferencePrice / buyReferencePrice - 1) * 10_000
          : null;
        const buyLiquidity = finite(buyPool?.liquidity_usd);
        const sellLiquidity = finite(sellPool?.liquidity_usd);
        const pairLiquidities = [buyLiquidity, sellLiquidity].filter(value => value !== null && value > 0);
        const referenceNotionalUsdc = pairLiquidities.length === 2
          ? Math.max(0.01, Math.min(positionNotionalUsdc, Math.min(...pairLiquidities) * 0.005))
          : 0.01;
        const referenceRankingSpreadBps = referenceSpreadBps !== null && referenceSpreadBps > 0
          ? Math.min(referenceSpreadBps, 300)
          : null;
        const referenceExpectedGrossUsdc = referenceRankingSpreadBps !== null
          ? referenceNotionalUsdc * referenceRankingSpreadBps / 10_000
          : null;
        const anchorPair = new Set([buyPool.pool_address, sellPool.pool_address]);
        const routeAnchorPriority = String(row.primary_mint) === WSOL_MINT && routeQuoteMint === USDC_MINT
          ? anchorPair.has(SOL_USDC_ORCA_POOL) && anchorPair.has(SOL_USDC_RAYDIUM_POOL)
            ? 4
            : anchorPair.has(SOL_USDC_ORCA_POOL) && anchorPair.has(SOL_USDC_METEORA_DLMM_POOL)
              ? 3
              : anchorPair.has(SOL_USDC_ORCA_POOL) && anchorPair.has(SOL_USDC_RAYDIUM_CLMM_POOL)
                ? 2
                : anchorPair.has(SOL_USDC_METEORA_DLMM_POOL) && anchorPair.has(SOL_USDC_RAYDIUM_CLMM_POOL)
                  ? 1
                  : 0
          : 0;
        directNativePairs.push({
          buy_amm_address: null,
          sell_amm_address: null,
          execution_readiness: Number(buyPool.native_supported === true) + Number(sellPool.native_supported === true),
          buy_pool_address: buyPool.pool_address,
          sell_pool_address: sellPool.pool_address,
          buy_pool_reference_price_usd: buyReferencePrice,
          sell_pool_reference_price_usd: sellReferencePrice,
          buy_pool_liquidity_usd: buyLiquidity,
          sell_pool_liquidity_usd: sellLiquidity,
          reference_notional_usdc: referenceNotionalUsdc,
          reference_ranking_spread_bps: referenceRankingSpreadBps,
          reference_expected_gross_usdc: referenceExpectedGrossUsdc,
          route_anchor_priority: routeAnchorPriority,
          native_pair_priority: Number(buyPool.native_supported === true && sellPool.native_supported === true),
          atomic_coupling_priority: Number(
            hotPathExactOutEnabled &&
            buyPool.family === 'ORCA' &&
            buyPool.native_supported === true
          ),
          buy_dex: buyPool.jupiter_label || buyPool.dex_id || buyPool.family,
          sell_dex: sellPool.jupiter_label || sellPool.dex_id || sellPool.family,
          buy_dex_family: buyPool.family,
          sell_dex_family: sellPool.family,
          buy_pool_program_owner: buyPool.program_owner || null,
          sell_pool_program_owner: sellPool.program_owner || null,
          buy_jupiter_label: buyPool.jupiter_label || null,
          sell_jupiter_label: sellPool.jupiter_label || null,
          buy_native_supported: buyPool.native_supported === true,
          sell_native_supported: sellPool.native_supported === true,
          discovery_venue_evidence: true,
          route_reference_only: true,
          provisional_cross_venue_spread_bps: referenceSpreadBps,
          discovery_liquidity_score: (buyLiquidity ?? 0) + (sellLiquidity ?? 0)
        });
      }
    }
    directNativePairs.sort((a, b) => {
      // Prefer routes AETHER can quote/build natively inside the <=300 ms hot
      // path. A stale-looking spread on an unsupported pool must not consume the
      // only exact-quote slot while a fully executable native pair is available.
      const readinessDelta = Number(b.execution_readiness || 0) - Number(a.execution_readiness || 0);
      if (readinessDelta !== 0) return readinessDelta;
      const couplingDelta = Number(b.atomic_coupling_priority || 0) - Number(a.atomic_coupling_priority || 0);
      if (couplingDelta !== 0) return couplingDelta;
      const anchorDelta = Number(b.route_anchor_priority || 0) - Number(a.route_anchor_priority || 0);
      if (anchorDelta !== 0) return anchorDelta;
      const aNativeScore = Number(a.buy_native_supported === true) + Number(a.sell_native_supported === true);
      const bNativeScore = Number(b.buy_native_supported === true) + Number(b.sell_native_supported === true);
      if (aNativeScore !== bNativeScore) return bNativeScore - aNativeScore;
      const aGrossUsd = finite(a.reference_expected_gross_usdc);
      const bGrossUsd = finite(b.reference_expected_gross_usdc);
      if (aGrossUsd !== null || bGrossUsd !== null) {
        const grossDelta = (bGrossUsd ?? -Infinity) - (aGrossUsd ?? -Infinity);
        if (grossDelta !== 0) return grossDelta;
      }
      const aSpread = finite(a.provisional_cross_venue_spread_bps);
      const bSpread = finite(b.provisional_cross_venue_spread_bps);
      if (aSpread !== null || bSpread !== null) return (bSpread ?? -Infinity) - (aSpread ?? -Infinity);
      return (finite(b.discovery_liquidity_score) ?? 0) - (finite(a.discovery_liquidity_score) ?? 0);
    });
    // DexScreener reference prices are discovery/ranking hints and can lag the
    // executable pool state. For each strongest reference pool pair, keep the
    // reverse direction adjacent so the hot path tests both directions instead
    // of trusting a possibly stale directional hint.
    const directPairSelectionLimit = nativeDirectDiscoverySufficient
      ? nativeDirectPairLimit
      : maxDexPairAttempts;
    const selectedDirectPairs = [];
    const selectedDirectKeys = new Set();
    // A short-lived probe used to restart from the same top-ranked pool pair on
    // every scan, so secondary pools could be starved forever. Group forward /
    // reverse directions by the same two pools, then rotate the pair group using
    // the monotonic scan sequence supplied by the runtime.
    const pairGroupsByKey = new Map();
    const pairGroupOrder = [];
    for (const candidate of directNativePairs) {
      const groupKey = [candidate.buy_pool_address, candidate.sell_pool_address].sort().join('<=>');
      if (!pairGroupsByKey.has(groupKey)) {
        pairGroupsByKey.set(groupKey, []);
        pairGroupOrder.push(groupKey);
      }
      pairGroupsByKey.get(groupKey).push(candidate);
    }
    const pairGroups = pairGroupOrder.map(key => {
      const candidates = [...(pairGroupsByKey.get(key) || [])].sort((a, b) =>
        Number(b.atomic_coupling_priority || 0) - Number(a.atomic_coupling_priority || 0)
      );
      const nativeScore = candidates.reduce((best, candidate) => Math.max(
        best,
        Number(candidate.buy_native_supported === true) + Number(candidate.sell_native_supported === true)
      ), 0);
      const couplingScore = candidates.reduce(
        (best, candidate) => Math.max(best, Number(candidate.atomic_coupling_priority || 0)),
        0
      );
      const referenceGrossUsd = candidates.reduce((best, candidate) => {
        const value = finite(candidate.reference_expected_gross_usdc);
        return value === null ? best : Math.max(best, value);
      }, -Infinity);
      const referenceSpreadBps = candidates.reduce((best, candidate) => {
        const value = finite(candidate.provisional_cross_venue_spread_bps);
        return value === null ? best : Math.max(best, value);
      }, -Infinity);
      return {
        key,
        candidates,
        native_score: nativeScore,
        coupling_score: couplingScore,
        reference_gross_usd: referenceGrossUsd,
        reference_spread_bps: referenceSpreadBps
      };
    });
    // The <=300 ms hot path must first spend its budget on a route that can
    // actually be measured inside the SLA. Reference-price dislocations remain
    // useful ranking hints, but an unsupported/slow route must not consume the
    // whole decision window before a fully-native candidate is attempted.
    const economicallyHintedGroups = pairGroups
      .filter(group => Number.isFinite(group.reference_gross_usd) && group.reference_gross_usd > 0)
      .sort((a, b) =>
        b.reference_gross_usd - a.reference_gross_usd ||
        b.native_score - a.native_score ||
        b.coupling_score - a.coupling_score ||
        b.reference_spread_bps - a.reference_spread_bps
      );
    const executionReadyGroups = [...pairGroups].sort((a, b) =>
      b.native_score - a.native_score ||
      b.coupling_score - a.coupling_score ||
      b.reference_gross_usd - a.reference_gross_usd ||
      b.reference_spread_bps - a.reference_spread_bps
    );
    const primaryGroups = [];
    // Transaction-first ranking: when a reference dislocation is also fully
    // native/executable, test that pool pair before a merely convenient route.
    // Reference prices never approve the trade; they only decide which exact
    // executable quote gets the scarce <=300 ms slot.
    const bestEconomicReady = economicallyHintedGroups.find(group => group.native_score >= 2) || null;
    if (bestEconomicReady) primaryGroups.push(bestEconomicReady);
    const bestReady = executionReadyGroups.find(group =>
      group.native_score >= 2 &&
      !primaryGroups.some(item => item.key === group.key)
    ) || executionReadyGroups.find(group => !primaryGroups.some(item => item.key === group.key)) || null;
    if (bestReady) primaryGroups.push(bestReady);
    const bestEconomic = economicallyHintedGroups.find(group => !primaryGroups.some(item => item.key === group.key));
    if (bestEconomic) primaryGroups.push(bestEconomic);
    const primaryKeys = new Set(primaryGroups.map(group => group.key));
    const exploratoryGroups = pairGroups.filter(group => !primaryKeys.has(group.key));
    const mintRotationSalt = [...String(row.primary_mint || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const rotateGroups = (groups, extra = 0) => {
      if (!groups.length) return [];
      const offset = (routeRotationEpoch + mintRotationSalt + extra) % groups.length;
      return [...groups.slice(offset), ...groups.slice(0, offset)];
    };
    const rotatedExploratoryGroups = rotateGroups(exploratoryGroups, 1);
    // Keep the fully executable primary route first on every scan. Rotate only
    // the reserve set so market coverage expands without sacrificing the one
    // route most likely to complete within the scanner SLA.
    const prioritizedGroups = [
      ...primaryGroups,
      ...rotatedExploratoryGroups
    ];
    const rotatedCandidatesByGroup = prioritizedGroups.map(group => {
      // Alternate BUY/SELL direction across scan epochs, but do not spend every
      // hot-path slot on the forward+reverse directions of one pool group.
      const directionOffset = group.candidates.length
        ? (routeRotationEpoch + mintRotationSalt) % group.candidates.length
        : 0;
      return group.candidates.length
        ? [...group.candidates.slice(directionOffset), ...group.candidates.slice(0, directionOffset)]
        : [];
    });
    const appendSelected = candidate => {
      if (!candidate || selectedDirectPairs.length >= directPairSelectionLimit) return;
      const key = candidate.buy_pool_address + '=>' + candidate.sell_pool_address;
      if (selectedDirectKeys.has(key)) return;
      selectedDirectPairs.push(candidate);
      selectedDirectKeys.add(key);
    };
    // Pass 1: one direction from as many distinct pool groups as possible.
    // This fixes the previous starvation bug where the <=300 ms budget kept
    // testing both directions of the same losing pool pair on every scan.
    for (const candidates of rotatedCandidatesByGroup) {
      appendSelected(candidates[0]);
      if (selectedDirectPairs.length >= directPairSelectionLimit) break;
    }
    // Pass 2: only after group diversity is covered, add reverse directions.
    if (selectedDirectPairs.length < directPairSelectionLimit) {
      for (const candidates of rotatedCandidatesByGroup) {
        for (const candidate of candidates.slice(1)) {
          appendSelected(candidate);
          if (selectedDirectPairs.length >= directPairSelectionLimit) break;
        }
        if (selectedDirectPairs.length >= directPairSelectionLimit) break;
      }
    }
    for (const pair of selectedDirectPairs) {
      const key = `${pair.buy_dex_family}:${pair.buy_pool_address}=>${pair.sell_dex_family}:${pair.sell_pool_address}`;
      if (seenDexPairs.has(key)) continue;
      seenDexPairs.add(key);
      rawDexPairs.push(pair);
    }

    // Prefer labels tied to the exact AMM pair reported by Jupiter. This keeps
    // route direction intact and avoids unnecessary owner-program RPC lookups.
    for (const pair of provisional) {
      const buyDex = pair.buy_dex_label;
      const sellDex = pair.sell_dex_label;
      const buyDexFamily = shadowDexFamily(buyDex);
      const sellDexFamily = shadowDexFamily(sellDex);
      if (!buyDex || !sellDex || !buyDexFamily || !sellDexFamily || buyDexFamily === sellDexFamily) continue;
      const key = `${buyDex}=>${sellDex}`;
      if (seenDexPairs.has(key)) continue;
      seenDexPairs.add(key);
      rawDexPairs.push({ ...pair, buy_dex: buyDex, sell_dex: sellDex, buy_dex_family: buyDexFamily, sell_dex_family: sellDexFamily });
      if (rawDexPairs.length >= maxDexPairAttempts) break;
    }

    // Ultra-fast fallback: Jupiter's fresh quote also carries route-level AMM labels.
    // Build cross-family BUY/SELL combinations directly and avoid an RPC round-trip
    // when enough real DEX labels are already present.
    const observedDexes = broad && rawDexPairs.length < fastPathPairLimit ? observedRouteDexes(broad) : [];
    for (const buyDex of observedDexes) {
      for (const sellDex of observedDexes) {
        if (buyDex.family === sellDex.family) continue;
        const key = `${buyDex.label}=>${sellDex.label}`;
        if (seenDexPairs.has(key)) continue;
        seenDexPairs.add(key);
        rawDexPairs.push({ buy_amm_address: null, sell_amm_address: null, buy_route_observed: true, sell_route_observed: true, routability_score: 2, provisional_cross_venue_spread_bps: null, buy_dex: buyDex.label, sell_dex: sellDex.label, buy_dex_family: buyDex.family, sell_dex_family: sellDex.family });
        if (rawDexPairs.length >= maxDexPairAttempts) break;
      }
      if (rawDexPairs.length >= maxDexPairAttempts) break;
    }

    // Enrich from pool-owner RPC only when direct quote labels did not provide
    // enough cross-DEX attempts. This keeps RPC off the normal hot path.
    let owners = new Map();
    if (rawDexPairs.length < fastPathPairLimit) {
      const addresses = [...new Set(provisional.flatMap(item => [item.buy_amm_address, item.sell_amm_address]))];
      try { owners = await ownerPrograms(addresses); } catch { owners = new Map(); }
    }

    for (const pair of provisional) {
      const buyProgram = owners.get(pair.buy_amm_address);
      const sellProgram = owners.get(pair.sell_amm_address);
      const buyDex = pair.buy_dex_label || (buyProgram ? labelsByProgram?.[buyProgram] : null);
      const sellDex = pair.sell_dex_label || (sellProgram ? labelsByProgram?.[sellProgram] : null);
      const buyDexFamily = shadowDexFamily(buyDex);
      const sellDexFamily = shadowDexFamily(sellDex);
      if (!buyDex || !sellDex || !buyDexFamily || !sellDexFamily || buyDexFamily === sellDexFamily) continue;
      const key = `${buyDex}=>${sellDex}`;
      if (seenDexPairs.has(key)) continue;
      seenDexPairs.add(key);
      rawDexPairs.push({ ...pair, buy_dex: String(buyDex), sell_dex: String(sellDex), buy_dex_family: buyDexFamily, sell_dex_family: sellDexFamily });
      if (rawDexPairs.length >= maxDexPairAttempts) break;
    }


    if (!rawDexPairs.length) {
      pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: broadError?.includes('rate_limited') ? 'NO_DISTINCT_DEX_PAIR_AFTER_BROAD_RATE_LIMIT' : 'NO_DISTINCT_DEX_PAIR', broad_quote_error: broadError, expected_net_edge_bps: null });
      return;
    }

    const quoteAttempts = [];
    const effectiveFastPathPairLimit = nativeDirectDiscoverySufficient
      ? Math.min(nativeExactPairLimit, nativeDirectPairLimit, rawDexPairs.length)
      : Math.min(fastPathPairLimit, rawDexPairs.length);
    // Warm a small reserve of ranked native directions outside the <=300 ms
    // decision clock. If the first pool group is unhealthy, the next warmed
    // group can take its place instead of consuming the only quote deadline.
    const warmCandidateLimit = nativeDirectDiscoverySufficient
      ? Math.min(effectiveFastPathPairLimit, nativeDirectPairLimit, rawDexPairs.length)
      : effectiveFastPathPairLimit;
    let fastCandidates = rawDexPairs.slice(0, warmCandidateLimit);
    const warmHealth = new Map();
    const nativeWarmErrors = [];
    const nativeWarmKey = ({ family, poolAddress, inputMint = null, outputMint = null }) =>
      family === 'RAYDIUM'
        ? [family, String(poolAddress || '')].join(':')
        : [family, String(poolAddress || ''), String(inputMint || ''), String(outputMint || '')].join(':');
    const nativeServiceForFamily = family => family === 'RAYDIUM'
      ? raydiumNative
      : family === 'ORCA'
        ? orca
        : family === 'METEORA' ? meteoraNative : null;
    // Maintain a fresh provider snapshot immediately before the candidate decision clock.
    // In the long-running engine this is the continuously refreshed market-state plane;
    // the one-shot probe mirrors it explicitly and exposes the prep latency separately.
    const snapshotPrepareStartedAt = Date.now();
    const raydiumPools = [...new Set(fastCandidates.flatMap(candidate => [
      candidate.buy_dex_family === 'RAYDIUM' && candidate.buy_native_supported === true ? candidate.buy_pool_address : null,
      candidate.sell_dex_family === 'RAYDIUM' && candidate.sell_native_supported === true ? candidate.sell_pool_address : null
    ]).filter(Boolean))];
    const meteoraSnapshotRequests = fastCandidates.flatMap(candidate => {
      const requests = [];
      if (candidate.buy_dex_family === 'METEORA' && candidate.buy_native_supported === true) requests.push({
        inputMint: routeQuoteMint,
        outputMint: row.primary_mint,
        poolAddress: candidate.buy_pool_address || null
      });
      if (candidate.sell_dex_family === 'METEORA' && candidate.sell_native_supported === true) requests.push({
        inputMint: row.primary_mint,
        outputMint: routeQuoteMint,
        poolAddress: candidate.sell_pool_address || null
      });
      return requests;
    });
    const uniqueMeteoraSnapshots = [...new Map(
      meteoraSnapshotRequests.map(request => [
        [request.inputMint, request.outputMint, request.poolAddress || ''].join(':'),
        request
      ])
    ).values()];
    const orcaSnapshotRequests = fastCandidates.flatMap(candidate => {
      const requests = [];
      if (candidate.buy_dex_family === 'ORCA' && candidate.buy_native_supported === true) requests.push({
        inputMint: routeQuoteMint,
        outputMint: row.primary_mint,
        poolAddress: candidate.buy_pool_address || null
      });
      if (candidate.sell_dex_family === 'ORCA' && candidate.sell_native_supported === true) requests.push({
        inputMint: row.primary_mint,
        outputMint: routeQuoteMint,
        poolAddress: candidate.sell_pool_address || null
      });
      return requests;
    });
    const uniqueOrcaSnapshots = [...new Map(
      orcaSnapshotRequests.map(request => [
        [request.inputMint, request.outputMint, request.poolAddress || ''].join(':'),
        request
      ])
    ).values()];
    const warmWithRetry = async task => {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await respectNativeRateLimitBackoff();
        try { return await task(); }
        catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          // A provider 429 is a capacity signal, not a reason to immediately
          // hammer the same RPC again. Back off globally so the next warm/quote
          // does not immediately repeat the same capacity failure.
          if (isNativeRateLimitError(error)) {
            noteNativeRateLimit();
            break;
          }
          if (attempt < 1) await sleep(150);
        }
      }
      if (lastError) throw lastError;
      return null;
    };
    await Promise.all([
      ...raydiumPools.map(poolAddress => withNativeWarmSlot(async () => {
        const key = nativeWarmKey({ family: 'RAYDIUM', poolAddress });
        try {
          await warmWithRetry(() => raydiumNative.warmPool({ poolAddress }));
          warmHealth.set(key, true);
        } catch (error) {
          warmHealth.set(key, isTransientNativeProviderError(error) ? null : false);
          nativeWarmErrors.push({
            dex_family: 'RAYDIUM',
            pool_address: poolAddress,
            error: String(error?.message || error)
          });
        }
      })),
      ...uniqueMeteoraSnapshots.map(request => withNativeWarmSlot(async () => {
        const key = nativeWarmKey({ family: 'METEORA', ...request });
        try {
          await warmWithRetry(() => meteoraNative.warmSnapshot({
            ...request,
            timeoutMs: Math.max(1500, hotPathTimeoutMs * 3)
          }));
          warmHealth.set(key, true);
        } catch (error) {
          warmHealth.set(key, isTransientNativeProviderError(error) ? null : false);
          nativeWarmErrors.push({
            dex_family: 'METEORA',
            pool_address: request.poolAddress || null,
            input_mint: request.inputMint,
            output_mint: request.outputMint,
            error: String(error?.message || error)
          });
        }
      })),
      ...uniqueOrcaSnapshots.map(request => withNativeWarmSlot(async () => {
        const key = nativeWarmKey({ family: 'ORCA', ...request });
        try {
          await warmWithRetry(() => orca.warmSnapshot({
            ...request,
            timeoutMs: Math.max(1500, hotPathTimeoutMs * 3)
          }));
          warmHealth.set(key, true);
        } catch (error) {
          warmHealth.set(key, isTransientNativeProviderError(error) ? null : false);
          nativeWarmErrors.push({
            dex_family: 'ORCA',
            pool_address: request.poolAddress || null,
            input_mint: request.inputMint,
            output_mint: request.outputMint,
            error: String(error?.message || error)
          });
        }
      }))
    ]);
    const nativeLegWarmReady = ({ family, poolAddress, inputMint, outputMint, nativeSupported }) => {
      if (nativeSupported !== true) return true;
      if (!poolAddress) return false;
      // false = deterministic incompatibility; null/undefined = transient provider
      // failure. Transient failures must remain eligible for the final targeted
      // refresh, otherwise a temporary 429 silently becomes an opportunity reject.
      return warmHealth.get(nativeWarmKey({ family, poolAddress, inputMint, outputMint })) !== false;
    };
    fastCandidates = fastCandidates.filter(candidate =>
      nativeLegWarmReady({
        family: candidate.buy_dex_family,
        poolAddress: candidate.buy_pool_address,
        inputMint: routeQuoteMint,
        outputMint: row.primary_mint,
        nativeSupported: candidate.buy_native_supported
      }) &&
      nativeLegWarmReady({
        family: candidate.sell_dex_family,
        poolAddress: candidate.sell_pool_address,
        inputMint: row.primary_mint,
        outputMint: routeQuoteMint,
        nativeSupported: candidate.sell_native_supported
      })
    );

    // Do not refresh the same native legs twice. The reserve warm above already
    // prepares the exact candidate set, and every quote service independently
    // refreshes state when its TTL is stale. The previous second warm doubled RPC
    // reads, amplified 429s, and could spend seconds before a <=300 ms decision
    // even started. Final quote freshness + stale-age gates remain authoritative.
    fastCandidates = fastCandidates.slice(0, effectiveFastPathPairLimit);
    const configuredMinNotionalUsdc = Math.max(
      1,
      Number(process.env.AETHER_MIN_PAPER_NOTIONAL_USDC || Math.max(5, paperCapitalUsdc * 0.01))
    );
    const candidateMaxNotionalUsdc = candidate => {
      const poolLiquidities = [
        finite(candidate?.buy_pool_liquidity_usd),
        finite(candidate?.sell_pool_liquidity_usd)
      ].filter(value => value !== null && value > 0);
      const poolLiquidityCap = poolLiquidities.length
        ? Math.min(...poolLiquidities) * 0.005
        : positionNotionalUsdc;
      return Math.max(0.01, Math.min(positionNotionalUsdc, poolLiquidityCap));
    };
    // Detect the market dislocation with the smallest meaningful notional first.
    // Starting every route at its maximum allocation can erase a real spread with
    // our own price impact before we even know it exists. A positive probe is
    // subsequently scaled upward to maximize executable gross profit.
    const candidateProbeNotionalUsdc = candidate =>
      Math.max(0.01, Math.min(candidateMaxNotionalUsdc(candidate), configuredMinNotionalUsdc));
    const candidateQuoteRaw = (candidate, notionalOverrideUsdc = null) => {
      const override = finite(notionalOverrideUsdc);
      const notionalUsdc = override !== null && override > 0
        ? override
        : candidateProbeNotionalUsdc(candidate);
      if (routeQuoteMint === USDC_MINT) {
        return String(Math.max(1, Math.round(notionalUsdc * 1_000_000)));
      }
      if (routeQuoteMint === WSOL_MINT) {
        if (!(Number.isFinite(Number(solUsd)) && Number(solUsd) > 0)) {
          throw new Error('sol_usd_reference_required_for_wsol_route');
        }
        return String(Math.max(1, Math.round((notionalUsdc / Number(solUsd)) * 1_000_000_000)));
      }
      throw new Error('unsupported_route_quote_mint');
    };
    const quoteRawToUsdc = rawAmount => {
      const raw = Number(String(rawAmount || ''));
      if (!Number.isFinite(raw) || raw <= 0) throw new Error('route_quote_input_invalid');
      if (routeQuoteMint === USDC_MINT) return raw / 1_000_000;
      if (routeQuoteMint === WSOL_MINT) {
        if (!(Number.isFinite(Number(solUsd)) && Number(solUsd) > 0)) {
          throw new Error('sol_usd_reference_required_for_wsol_route');
        }
        return (raw / 1_000_000_000) * Number(solUsd);
      }
      throw new Error('unsupported_route_quote_mint');
    };

    const nativePreflightErrors = [];
    if (nativePreflightEnabled && nativeDirectDiscoverySufficient && fastCandidates.length) {
      const buyHealth = new Map();
      for (const candidate of fastCandidates) {
        const service = candidate.buy_native_supported === true
          ? nativeServiceForFamily(candidate.buy_dex_family)
          : null;
        const poolAddress = candidate.buy_pool_address || null;
        if (!service || !poolAddress) continue;
        const preflightAmount = candidateQuoteRaw(candidate);
        const key = candidate.buy_dex_family + ':' + poolAddress + ':' + preflightAmount;
        if (buyHealth.has(key)) continue;
        try {
          await withNativeWarmSlot(() => service.quote({
            inputMint: routeQuoteMint,
            outputMint: row.primary_mint,
            amount: preflightAmount,
            slippageBps: Math.max(1, Math.trunc(Number(process.env.SIGNAL_MAX_SLIPPAGE_BPS || 100))),
            poolAddress
          }));
          buyHealth.set(key, true);
        } catch (error) {
          const message = String(error?.message || error);
          const transient = /rate.?limit|too many requests|429|timeout|8100002|rpc/i.test(message);
          buyHealth.set(key, transient ? null : false);
          nativePreflightErrors.push({
            dex_family: candidate.buy_dex_family,
            pool_address: poolAddress,
            transient,
            error: message
          });
        }
      }
      fastCandidates = fastCandidates.filter(candidate => {
        const service = candidate.buy_native_supported === true
          ? nativeServiceForFamily(candidate.buy_dex_family)
          : null;
        const poolAddress = candidate.buy_pool_address || null;
        if (!service || !poolAddress) return true;
        return buyHealth.get(
          candidate.buy_dex_family + ':' + poolAddress + ':' + candidateQuoteRaw(candidate)
        ) !== false;
      });
    }
    if (!fastCandidates.length) {
      pushResult({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: nativeWarmErrors.length ? 'NATIVE_PROVIDER_WARM_REJECTED' : 'NATIVE_PROVIDER_PREFLIGHT_REJECTED',
        native_warm_errors: nativeWarmErrors,
        native_preflight_errors: nativePreflightErrors,
        expected_net_edge_bps: null
      });
      return;
    }
    const marketSnapshotPrepareMs = Date.now() - snapshotPrepareStartedAt;
    const opportunityStartedAt = Date.now();
    const executableQuote = async ({
      dexFamily,
      dexLabel = null,
      jupiterLabel = null,
      nativeSupported = false,
      inputMint,
      outputMint,
      amount,
      poolAddress = null,
      swapMode = 'ExactIn'
    }) => {
      const slippageBps = Math.max(1, Math.trunc(Number(process.env.SIGNAL_MAX_SLIPPAGE_BPS || 100)));
      const exactDexLabel = String(jupiterLabel || dexLabel || '').trim();
      const annotateQuote = quote => Object.freeze({
        ...quote,
        quote_observed_at_ms: Date.now(),
        market_state_age_ms_at_quote: finite(
          quote?.pool_snapshot_age_ms ?? quote?.pool_state_age_ms ?? 0
        ) ?? 0
      });
      const jupiterAtomicDirectQuote = async nativeError => {
        if (!exactDexLabel) throw new Error('jupiter_direct_label_required');
        const directBudgetMs = Math.max(
          50,
          Math.min(
            hotPathTimeoutMs,
            candidateQuoteDeadlineMs - (Date.now() - quoteEvaluationStartedAt) - 10
          )
        );
        const providerQuote = await jupiterQuote({
          inputMint,
          outputMint,
          amount,
          dex: exactDexLabel,
          onlyDirectRoutes: true,
          swapMode,
          timeoutMs: directBudgetMs,
          retries: 0
        });
        const plan = Array.isArray(providerQuote?.routePlan) ? providerQuote.routePlan : [];
        if (plan.length !== 1 || !plan[0]?.swapInfo?.ammKey) {
          throw new Error('jupiter_direct_single_pool_required');
        }
        const observedLabel = String(plan[0]?.swapInfo?.label || exactDexLabel);
        const observedFamily = shadowDexFamily(observedLabel);
        if (!observedFamily || observedFamily !== dexFamily) {
          throw new Error('jupiter_direct_family_mismatch');
        }
        const observedPool = String(plan[0].swapInfo.ammKey);
        // For pool programs without a native decoder, Jupiter can guarantee the
        // DEX family and direct single-pool route but cannot be instructed to use
        // a specific discovery pool. The executable routePlan is authoritative:
        // accept its observed pool and carry the requested pool only as discovery
        // telemetry. Final PAPER approval still requires BUY and SELL to resolve
        // to two distinct observed pools.
        const poolRequestRemapped = Boolean(poolAddress && observedPool !== String(poolAddress));
        return annotateQuote({
          ...providerQuote,
          quote_mode: swapMode,
          inputAmount: String(providerQuote.inAmount || ''),
          outputAmount: String(providerQuote.outAmount || ''),
          maximumInputAmount: swapMode === 'ExactOut'
            ? String(providerQuote.otherAmountThreshold || providerQuote.inAmount || '')
            : null,
          minimumOutputAmount: swapMode === 'ExactIn'
            ? String(providerQuote.otherAmountThreshold || providerQuote.outAmount || '')
            : String(providerQuote.outAmount || ''),
          provider_quote_response: providerQuote,
          pool_address: observedPool,
          pool_pair_verified: true,
          requested_pool_address: poolAddress || null,
          pool_request_remapped: poolRequestRemapped,
          dex_label: observedLabel,
          quote_provider: 'JUPITER_DIRECT_ATOMIC',
          native_build_context: Object.freeze({ kind: 'JUPITER_DIRECT_SWAP_INSTRUCTIONS' }),
          direct_quote_error: nativeError ? String(nativeError?.message || nativeError) : null
        });
      };

      if (poolAddress && nativeSupported === true && dexFamily === 'RAYDIUM') {
        try {
          if (swapMode === 'ExactOut') {
            if (exactDexLabel) return jupiterAtomicDirectQuote(null);
            throw new Error('raydium_exact_out_native_unavailable');
          }
          const q = await withNativeRpcSlot(
            () => raydiumNative.quote({ inputMint, outputMint, amount, slippageBps, poolAddress })
          );
          return annotateQuote({
            ...q,
            pool_address: poolAddress,
            dex_label: exactDexLabel || 'Raydium',
            outAmount: String(q.outputAmount),
            priceImpactPct: q.priceImpactPct ?? null,
            quote_provider: 'RAYDIUM_NATIVE'
          });
        } catch (nativeError) {
          // The candidate is tied to this exact on-chain pool. Falling back to a
          // DEX-label-only Jupiter quote can silently remap the pool and consume
          // the entire <=300 ms decision budget. Fail this exact native leg fast
          // so the reverse direction / next verified pool can still be tested.
          throw new Error('raydium_native_quote_failed:' + String(nativeError?.message || nativeError));
        }
      }
      if (poolAddress && nativeSupported === true && dexFamily === 'ORCA') {
        try {
          const q = await withNativeRpcSlot(
            () => swapMode === 'ExactOut'
              ? orca.quoteExactOutput({ inputMint, outputMint, outputAmount: amount, slippageBps, poolAddress })
              : orca.quote({ inputMint, outputMint, amount, slippageBps, poolAddress })
          );
          return annotateQuote({
            ...q,
            pool_address: poolAddress,
            dex_label: exactDexLabel || 'Whirlpool',
            inAmount: String(q.inputAmount),
            outAmount: String(q.outputAmount),
            priceImpactPct: q.priceImpactPct ?? null,
            quote_provider: 'ORCA_DIRECT'
          });
        } catch (nativeError) {
          throw new Error('orca_native_quote_failed:' + String(nativeError?.message || nativeError));
        }
      }
      if (poolAddress && nativeSupported === true && dexFamily === 'METEORA') {
        try {
          if (swapMode === 'ExactOut') {
            if (exactDexLabel) return jupiterAtomicDirectQuote(null);
            throw new Error('meteora_exact_out_native_unavailable');
          }
          const q = await withNativeRpcSlot(
            () => meteoraNative.quote({ inputMint, outputMint, amount, slippageBps, poolAddress })
          );
          return annotateQuote({
            ...q,
            pool_address: poolAddress,
            dex_label: exactDexLabel || 'Meteora DLMM',
            outAmount: String(q.outputAmount),
            priceImpactPct: q.priceImpactPct ?? null,
            quote_provider: 'METEORA_NATIVE'
          });
        } catch (nativeError) {
          throw new Error('meteora_native_quote_failed:' + String(nativeError?.message || nativeError));
        }
      }

      // Generic direct path covers pool programs for which AETHER intentionally
      // has no native decoder yet (Pump.fun AMM, Phoenix, Meteora DAMM v2,
      // Raydium CP, Orca V2, etc.). The quote remains a single direct DEX leg,
      // and the exact Jupiter swap instructions are later composed atomically.
      if (exactDexLabel) return jupiterAtomicDirectQuote(null);

      if (dexFamily === 'RAYDIUM' && !poolAddress) {
        try {
          if (swapMode === 'ExactOut') throw new Error('raydium_exact_out_direct_unavailable');
          const q = await raydium.quote({ inputMint, outputMint, amount, slippageBps });
          return annotateQuote({
            ...q,
            dex_label: 'Raydium',
            outAmount: String(q.outputAmount),
            priceImpactPct: q.priceImpactPct ?? null,
            quote_provider: 'RAYDIUM_DIRECT'
          });
        } catch (raydiumError) {
          throw new Error('raydium_direct_quote_failed:' + String(raydiumError?.message || raydiumError));
        }
      }
      throw new Error('executable_direct_quote_unavailable');
    };
    const quoteEvaluationStartedAt = Date.now();
    const candidateQuoteDeadlineMs = Math.max(100, analysisSlaMs - 25);
    const evaluateCandidate = async (candidate, requestedNotionalUsdc = null) => {
      const initialNotionalUsdc = candidateMaxNotionalUsdc(candidate);
      const minimumRouteNotionalUsdc = candidateProbeNotionalUsdc(candidate);
      const requested = finite(requestedNotionalUsdc);
      // First-pass discovery starts small to reveal the zero/low-impact spread.
      // Once a positive route is found, the second pass may request the maximum
      // risk-allowed size and the existing downsize loop finds the largest
      // executable size that still preserves the edge.
      let routeNotionalUsdc = requested !== null && requested > 0
        ? Math.max(minimumRouteNotionalUsdc, Math.min(initialNotionalUsdc, requested))
        : minimumRouteNotionalUsdc;
      let sizingAttempts = 0;
      let lastError = null;

      while (sizingAttempts < 3) {
        sizingAttempts += 1;
        try {
          if (Date.now() - quoteEvaluationStartedAt >= candidateQuoteDeadlineMs) {
            throw new Error('candidate_quote_deadline_before_buy');
          }
          const routeQuoteBudgetRaw = candidateQuoteRaw(candidate, routeNotionalUsdc);

          // Self-financing atomic coupling:
          // 1) seed with an exact-input BUY only to discover a safe intermediate target;
          // 2) rebuild BUY as exact-output so it guarantees that exact token amount;
          // 3) SELL exactly that guaranteed amount.
          // This removes the "estimated output -> insufficient funds" failure mode
          // and never relies on a pre-existing intermediate-token balance.
          const seedBuy = await executableQuote({
            dexFamily: candidate.buy_dex_family,
            dexLabel: candidate.buy_dex,
            jupiterLabel: candidate.buy_jupiter_label || candidate.buy_dex,
            nativeSupported: candidate.buy_native_supported === true,
            inputMint: routeQuoteMint,
            outputMint: row.primary_mint,
            amount: routeQuoteBudgetRaw,
            poolAddress: candidate.buy_pool_address || null,
            swapMode: 'ExactIn'
          });
          const seedExpectedOutput = String(seedBuy.outputAmount ?? seedBuy.outAmount ?? '');
          const guaranteedIntermediateAmount = String(
            seedBuy.minimumOutputAmount ?? seedBuy.otherAmountThreshold ?? seedExpectedOutput
          );
          if (!/^\d+$/.test(seedExpectedOutput) || BigInt(seedExpectedOutput) <= 0n) {
            throw new Error('expected_buy_output_unavailable');
          }
          if (!/^\d+$/.test(guaranteedIntermediateAmount) || BigInt(guaranteedIntermediateAmount) <= 0n) {
            throw new Error('protected_buy_minimum_unavailable');
          }
          // Prefer an ExactOut BUY because it gives the cleanest self-financing
          // atomic coupling. Some Solana pools do not expose ExactOut, however.
          // For those pools, keep the original ExactIn BUY and make leg 2 consume
          // the expected leg-1 output. Because both instructions are composed into
          // one atomic transaction, any shortfall makes the whole transaction
          // revert; it cannot leave AETHER with a half-completed arbitrage.
          let buy = seedBuy;
          let buyExpectedInput = routeQuoteBudgetRaw;
          let sellInputAmount = seedExpectedOutput;
          let couplingMode = 'EXACT_IN_EXPECTED_OUTPUT_ATOMIC_REVERT_GUARD';
          let exactOutFallbackReason = null;
          // Keep the <=300 ms scanner decision to one fresh exact-input BUY
          // plus one fresh exact-input SELL. ExactOut is an execution-coupling
          // refinement and must not consume the scanner SLA budget. The atomic
          // transaction still fails closed if leg 1 cannot fund leg 2.
          const nativeExactOutSupported = hotPathExactOutEnabled &&
            candidate.buy_dex_family === 'ORCA' &&
            candidate.buy_native_supported === true;
          if (nativeExactOutSupported && Date.now() - quoteEvaluationStartedAt < candidateQuoteDeadlineMs - 25) {
            try {
              const exactOutBuy = await executableQuote({
                dexFamily: candidate.buy_dex_family,
                dexLabel: candidate.buy_dex,
                jupiterLabel: candidate.buy_jupiter_label || candidate.buy_dex,
                nativeSupported: candidate.buy_native_supported === true,
                inputMint: routeQuoteMint,
                outputMint: row.primary_mint,
                amount: guaranteedIntermediateAmount,
                poolAddress: candidate.buy_pool_address || null,
                swapMode: 'ExactOut'
              });
              const exactOutExpectedInput = String(exactOutBuy.inputAmount ?? exactOutBuy.inAmount ?? '');
              const exactOutMaximumInput = String(
                exactOutBuy.maximumInputAmount ?? exactOutBuy.otherAmountThreshold ?? exactOutExpectedInput
              );
              const exactOutOutput = String(exactOutBuy.outputAmount ?? exactOutBuy.outAmount ?? '');
              if (!/^\d+$/.test(exactOutExpectedInput) || BigInt(exactOutExpectedInput) <= 0n) {
                throw new Error('exact_out_buy_input_unavailable');
              }
              if (!/^\d+$/.test(exactOutMaximumInput) || BigInt(exactOutMaximumInput) <= 0n) {
                throw new Error('exact_out_buy_maximum_input_unavailable');
              }
              if (!/^\d+$/.test(exactOutOutput) || BigInt(exactOutOutput) !== BigInt(guaranteedIntermediateAmount)) {
                throw new Error('exact_out_buy_target_mismatch');
              }
              if (BigInt(exactOutMaximumInput) > BigInt(routeQuoteBudgetRaw)) {
                throw new Error('exact_out_buy_budget_exceeded');
              }
              buy = exactOutBuy;
              buyExpectedInput = exactOutExpectedInput;
              sellInputAmount = guaranteedIntermediateAmount;
              couplingMode = 'EXACT_OUT_SELF_FINANCING';
            } catch (error) {
              const message = String(error?.message || error);
              const exactOutUnavailable = /exact.?out|jupiter_no_route|swap.?mode|not supported|unsupported/i.test(message);
              if (!exactOutUnavailable) throw error;
              exactOutFallbackReason = message;
            }
          }
          if (Date.now() - quoteEvaluationStartedAt >= candidateQuoteDeadlineMs) {
            throw new Error('candidate_quote_deadline_before_sell');
          }
          const sell = await executableQuote({
            dexFamily: candidate.sell_dex_family,
            dexLabel: candidate.sell_dex,
            jupiterLabel: candidate.sell_jupiter_label || candidate.sell_dex,
            nativeSupported: candidate.sell_native_supported === true,
            inputMint: row.primary_mint,
            outputMint: routeQuoteMint,
            amount: sellInputAmount,
            poolAddress: candidate.sell_pool_address || null,
            swapMode: 'ExactIn'
          });
          const grossEdge = computeExecutableRoundTripEdgeBps(buyExpectedInput, sell.outAmount);
          const actualRouteNotionalUsdc = quoteRawToUsdc(buyExpectedInput);
          // Position percentages are MAX risk allocations, not mandatory sizes.
          // If market impact turns an otherwise promising route negative, search a
          // smaller real notional before rejecting it. Exact fees still decide NET.
          const deadlineRemainingMs = candidateQuoteDeadlineMs - (Date.now() - quoteEvaluationStartedAt);
          const smallerNotionalUsdc = Math.max(minimumRouteNotionalUsdc, routeNotionalUsdc / 2);
          if (
            grossEdge < minNetEdgeBps &&
            sizingAttempts < 3 &&
            smallerNotionalUsdc < routeNotionalUsdc &&
            deadlineRemainingMs > 45
          ) {
            routeNotionalUsdc = smallerNotionalUsdc;
            continue;
          }
          routeNotionalUsdc = actualRouteNotionalUsdc;
          const routeQuoteUsdcRaw = buyExpectedInput;
          const executableCandidate = {
            ...candidate,
            buy_pool_address: buy?.pool_address || candidate.buy_pool_address || null,
            sell_pool_address: sell?.pool_address || candidate.sell_pool_address || null,
            buy_dex: buy?.dex_label || candidate.buy_dex,
            sell_dex: sell?.dex_label || candidate.sell_dex
          };
          const grossProfitUsdc = actualRouteNotionalUsdc * grossEdge / 10_000;
          return {
            evaluation: { candidate: executableCandidate, buy, sell, grossEdge, grossProfitUsdc, routeNotionalUsdc, routeQuoteUsdcRaw, couplingMode, exactOutFallbackReason },
            attempt: {
              buy_dex: executableCandidate.buy_dex,
              sell_dex: executableCandidate.sell_dex,
              buy_pool_address: executableCandidate.buy_pool_address,
              sell_pool_address: executableCandidate.sell_pool_address,
              buy_provider: buy.quote_provider,
              sell_provider: sell.quote_provider,
              buy_quote_latency_ms: finite(buy?.latency_ms),
              sell_quote_latency_ms: finite(sell?.latency_ms),
              buy_snapshot_cache_hit: buy?.snapshot_cache_hit ?? buy?.pool_snapshot_cache_hit ?? buy?.pool_state_cache_hit ?? null,
              sell_snapshot_cache_hit: sell?.snapshot_cache_hit ?? sell?.pool_snapshot_cache_hit ?? sell?.pool_state_cache_hit ?? null,
              initial_notional_usdc: initialNotionalUsdc,
              notional_usdc: routeNotionalUsdc,
              sizing_attempts: sizingAttempts,
              dynamic_sizing_applied: routeNotionalUsdc < initialNotionalUsdc,
              atomic_coupling_mode: couplingMode,
              exact_out_fallback_reason: exactOutFallbackReason,
              ok: true,
              gross_executable_spread_bps: grossEdge,
              gross_profit_before_costs_usdc: grossProfitUsdc
            }
          };
        } catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          const liquidityBoundFailure = /insufficient liquidity|no enough initialized tickarray|not found next tick info/i.test(message);
          const nextNotionalUsdc = Math.max(0.01, routeNotionalUsdc / 2);
          const deadlineRemainingMs = candidateQuoteDeadlineMs - (Date.now() - quoteEvaluationStartedAt);
          if (
            !liquidityBoundFailure ||
            sizingAttempts >= 3 ||
            nextNotionalUsdc >= routeNotionalUsdc ||
            deadlineRemainingMs <= 25
          ) break;
          routeNotionalUsdc = nextNotionalUsdc;
        }
      }

      return {
        evaluation: null,
        attempt: {
          buy_dex: candidate.buy_dex,
          sell_dex: candidate.sell_dex,
          buy_pool_address: candidate.buy_pool_address || null,
          sell_pool_address: candidate.sell_pool_address || null,
          initial_notional_usdc: initialNotionalUsdc,
          final_notional_usdc: routeNotionalUsdc,
          sizing_attempts: sizingAttempts,
          dynamic_sizing_applied: routeNotionalUsdc < initialNotionalUsdc,
          ok: false,
          error: String(lastError?.message || lastError || 'candidate_quote_failed')
        }
      };
    };
    const timedEvaluation = (candidate, timeoutMs, requestedNotionalUsdc = null) => Promise.race([
      evaluateCandidate(candidate, requestedNotionalUsdc),
      new Promise(resolve => setTimeout(() => resolve({
        evaluation: null,
        attempt: {
          buy_dex: candidate.buy_dex,
          sell_dex: candidate.sell_dex,
          buy_pool_address: candidate.buy_pool_address || null,
          sell_pool_address: candidate.sell_pool_address || null,
          ok: false,
          error: 'candidate_quote_deadline_exceeded'
        }
      }), Math.max(1, timeoutMs)))
    ]);
    // Evaluate ranked pairs sequentially inside one scanner budget. Running several
    // native pairs concurrently only queues them behind the RPC semaphore and can
    // create an avoidable 429 burst. The reference ranking already places the most
    // promising pair first, so consume the remaining <=300 ms budget only while it
    // is useful. A provider capacity signal quarantines that provider family for
    // this token but must not suppress an independent route on the other DEXes.
    const evaluatedRows = [];
    const rateLimitedFamilies = new Set();
    for (const candidate of fastCandidates) {
      if (
        rateLimitedFamilies.has(candidate.buy_dex_family) ||
        rateLimitedFamilies.has(candidate.sell_dex_family)
      ) {
        quoteAttempts.push({
          buy_dex: candidate.buy_dex,
          sell_dex: candidate.sell_dex,
          buy_pool_address: candidate.buy_pool_address || null,
          sell_pool_address: candidate.sell_pool_address || null,
          ok: false,
          error: 'provider_family_backoff_deferred'
        });
        continue;
      }
      const elapsedMs = Date.now() - quoteEvaluationStartedAt;
      const remainingMs = candidateQuoteDeadlineMs - elapsedMs;
      if (remainingMs <= 10) break;
      const rowResult = await timedEvaluation(candidate, remainingMs);
      evaluatedRows.push(rowResult);
      const error = String(rowResult?.attempt?.error || '');
      if (/429|too many requests|rate.?limit|8100002/i.test(error)) {
        if (/raydium/i.test(error)) rateLimitedFamilies.add('RAYDIUM');
        if (/orca/i.test(error)) rateLimitedFamilies.add('ORCA');
        if (/meteora/i.test(error)) rateLimitedFamilies.add('METEORA');
        if (!rateLimitedFamilies.size) {
          rateLimitedFamilies.add(candidate.buy_dex_family);
          rateLimitedFamilies.add(candidate.sell_dex_family);
        }
        // A capacity failure on one provider must not reject the whole token.
        // Continue only with a route that does not depend on that provider.
        continue;
      }
    }

    // Two-pass sizing: first compare directions/pools at a low-impact probe
    // notional. Only after a genuine positive executable spread is observed do
    // we spend the remaining scanner budget scaling that winning route toward
    // its risk/liquidity cap. This avoids a large losing first quote starving
    // the reverse direction, while still maximizing gross dollars available to
    // cover fixed network/account costs.
    const probeBest = evaluatedRows
      .map(row => row.evaluation)
      .filter(Boolean)
      .sort((a, b) => b.grossEdge - a.grossEdge)[0] || null;
    if (probeBest && probeBest.grossEdge >= minNetEdgeBps) {
      const maxNotionalUsdc = candidateMaxNotionalUsdc(probeBest.candidate);
      const currentNotionalUsdc = Number(probeBest.routeNotionalUsdc || 0);
      const remainingMs = candidateQuoteDeadlineMs - (Date.now() - quoteEvaluationStartedAt);
      if (maxNotionalUsdc > currentNotionalUsdc * 1.05 && remainingMs > 45) {
        const scaledResult = await timedEvaluation(
          probeBest.candidate,
          remainingMs,
          maxNotionalUsdc
        );
        evaluatedRows.push(scaledResult);
      }
    }

    quoteAttempts.push(...evaluatedRows.map(row => row.attempt));
    const evaluated = evaluatedRows.map(row => row.evaluation);
    const best = evaluated.filter(Boolean).sort((a, b) => {
      // Network/account fees are mostly fixed in USD for a given atomic route.
      // Rank by executable gross profit dollars first, then by bps. This avoids
      // selecting a tiny high-bps route that cannot cover fixed execution costs.
      const profitDelta = Number(b.grossProfitUsdc || 0) - Number(a.grossProfitUsdc || 0);
      if (profitDelta !== 0) return profitDelta;
      return b.grossEdge - a.grossEdge;
    })[0] || null;
    const selected = best?.candidate || null;
    const buyQuote = best?.buy || null;
    const sellQuote = best?.sell || null;
    const selectedNotionalUsdc = best?.routeNotionalUsdc ?? positionNotionalUsdc;
    const selectedQuoteUsdcRaw = best?.routeQuoteUsdcRaw ?? positionQuoteUsdcRaw;
    const selectedCouplingMode = best?.couplingMode || null;
    const selectedExactOutFallbackReason = best?.exactOutFallbackReason || null;
    const routableCandidateCount = evaluated.filter(Boolean).length;

    if (!selected || !buyQuote || !sellQuote) {
      const quoteErrors = quoteAttempts.map(item => String(item?.error || '')).join(' | ');
      const providerCapacityDeferred = /429|too many requests|rate.?limit|8100002/i.test(quoteErrors);
      const scannerCapacityDeferred = /candidate_quote_deadline|jupiter_timeout|solana_rpc_timeout|_timeout/i.test(quoteErrors);
      const status = providerCapacityDeferred
        ? 'PROVIDER_CAPACITY_DEFERRED'
        : scannerCapacityDeferred
          ? 'SCANNER_CAPACITY_DEFERRED'
          : routableCandidateCount > 0 ? 'DEX_RESTRICTED_QUOTE_UNAVAILABLE' : 'NO_ROUTABLE_DISTINCT_DEX_PAIR';
      pushResult({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status,
        dex_pairs_considered: rawDexPairs.length,
        dex_pair_attempts: quoteAttempts.length,
        buy_dexes_preflight_ok: routableCandidateCount,
        sell_dexes_preflight_ok: routableCandidateCount,
        quote_attempts: quoteAttempts,
        expected_net_edge_bps: null
      });
      return;
    }

    const impact = observedMaxPriceImpactBps(buyQuote, sellQuote);
    // Price impact is already reflected in the executable quote outputs used
    // below to compute gross spread and final NET edge. It is therefore a
    // sizing/observability signal, not a second hard rejection gate.
    const priceImpactWarning = impact === null || impact > maxPriceImpactBps;

    const gross = best.grossEdge;
    const marketStateAgeMsAt = nowMs => Math.max(
      0,
      Number(buyQuote?.market_state_age_ms_at_quote || 0) + Math.max(0, nowMs - Number(buyQuote?.quote_observed_at_ms || nowMs)),
      Number(sellQuote?.market_state_age_ms_at_quote || 0) + Math.max(0, nowMs - Number(sellQuote?.quote_observed_at_ms || nowMs))
    );
    const analysisCompletedAtMs = Date.now();
    // The scanner SLA measures the fresh executable quote decision window.
    // Pool discovery, program-owner verification, warming and preflight happen
    // before opportunityStartedAt and must not be charged to the market decision.
    // Parallel candidate quote setup before the first quote is also excluded.
    const analysisLatencyMs = analysisCompletedAtMs - quoteEvaluationStartedAt;
    const analysisMarketStateAgeMs = marketStateAgeMsAt(analysisCompletedAtMs);
    if (analysisLatencyMs > analysisSlaMs) {
      pushResult({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: 'SCANNER_SLA_REJECTED',
        buy_dex: selected.buy_dex,
        sell_dex: selected.sell_dex,
        buy_pool_address: selected.buy_pool_address || null,
        sell_pool_address: selected.sell_pool_address || null,
        gross_executable_spread_bps: gross,
        market_snapshot_prepare_ms: marketSnapshotPrepareMs,
        market_state_age_ms: analysisMarketStateAgeMs,
        analysis_latency_ms: analysisLatencyMs,
        analysis_sla_ms: analysisSlaMs,
        max_opportunity_age_ms: maxOpportunityAgeMs,
        quote_attempts: quoteAttempts,
        expected_net_edge_bps: null
      });
      return;
    }
    if (analysisMarketStateAgeMs > maxOpportunityAgeMs) {
      pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'MARKET_STATE_STALE_REJECTED', buy_dex: selected.buy_dex, sell_dex: selected.sell_dex, gross_executable_spread_bps: gross, market_snapshot_prepare_ms: marketSnapshotPrepareMs, market_state_age_ms: analysisMarketStateAgeMs, max_opportunity_age_ms: maxOpportunityAgeMs, analysis_latency_ms: analysisLatencyMs, expected_net_edge_bps: null });
      return;
    }
    // Exact transaction/account costs are non-negative. Therefore a route whose
    // fresh executable GROSS edge is already below the PAPER minimum can never
    // pass the final NET-edge gate. Reject it before build/simulation to avoid
    // wasting scarce RPC budget and creating 429 retry storms.
    if (gross < minNetEdgeBps) {
      pushResult({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        quote_mint: routeQuoteMint,
        status: 'GROSS_EDGE_BELOW_MINIMUM',
        quote_asset: routeQuoteMint === USDC_MINT ? 'USDC' : routeQuoteMint === WSOL_MINT ? 'WSOL' : 'UNKNOWN',
        buy_dex: selected.buy_dex,
        sell_dex: selected.sell_dex,
        buy_pool_address: selected.buy_pool_address || null,
        sell_pool_address: selected.sell_pool_address || null,
        buy_pool_pair_verified: buyQuote?.pool_pair_verified === true,
        sell_pool_pair_verified: sellQuote?.pool_pair_verified === true,
        notional_usdc: selectedNotionalUsdc,
        risk_position_pct: riskPositionPct,
        gross_profit_before_costs_usdc: selectedNotionalUsdc * gross / 10_000,
        gross_executable_spread_bps: gross,
        minimum_net_edge_bps: minNetEdgeBps,
        analysis_latency_ms: analysisLatencyMs,
        analysis_sla_passed: analysisLatencyMs <= analysisSlaMs,
        opportunity_age_ms: Date.now() - opportunityStartedAt,
        market_state_age_ms: analysisMarketStateAgeMs,
        dex_pair_attempts: quoteAttempts.length,
        quote_attempts: quoteAttempts,
        mode: 'SHADOW',
        execution_dispatched: false,
        transaction_signed: false,
        network_submission_authorized: false,
        live_execution_authorized: false,
        expected_net_edge_bps: null
      });
      return;
    }
    let simulation = null;
    let simulationError = null;
    try {
      const buildServiceForQuote = quote => quote?.quote_provider === 'ORCA_DIRECT'
        ? orca
        : quote?.quote_provider === 'RAYDIUM_NATIVE'
          ? raydiumNative
          : quote?.quote_provider === 'METEORA_NATIVE'
            ? meteoraNative
            : quote?.quote_provider === 'JUPITER_DIRECT_ATOMIC' ? jupiterDirect : null;
      const buyBuildService = buildServiceForQuote(buyQuote);
      const sellBuildService = buildServiceForQuote(sellQuote);
      if (
        buyBuildService?.prepareUnsignedLeg &&
        sellBuildService?.prepareUnsignedLeg &&
        buyQuote?.native_build_context &&
        sellQuote?.native_build_context
      ) {
        simulation = await withNativeRpcSlot(() => nativeRoundTrip.observe({
          buyService: buyBuildService,
          buyQuote,
          sellService: sellBuildService,
          sellQuote
        }));
      } else {
        const observeLeg = async quote => {
          if (quote?.quote_provider === 'ORCA_DIRECT' && quote?.native_build_context) return orca.observeUnsigned(quote);
          if (quote?.quote_provider === 'RAYDIUM_NATIVE' && quote?.native_build_context) return raydiumNative.observeUnsigned(quote);
          if (quote?.quote_provider === 'METEORA_NATIVE' && quote?.native_build_context) return meteoraNative.observeUnsigned(quote);
          if (!unsigned) throw new Error('shadow_simulation_public_key_required_for_non_atomic_fallback');
          return unsigned.observeLeg({ provider_quote_response: quote?.provider_quote_response || quote });
        };
        const [buyObserved, sellObserved] = await Promise.all([observeLeg(buyQuote), observeLeg(sellQuote)]);
        const buyFee = buyObserved?.exact_fee_lamports ?? null;
        const sellFee = sellObserved?.exact_fee_lamports ?? null;
        const accountStateAvailable = Boolean(buyObserved?.simulation_account_state_available && sellObserved?.simulation_account_state_available);
        simulation = Object.freeze({
          buy: buyObserved,
          sell: sellObserved,
          transaction_built: Boolean(buyObserved?.transaction_built && sellObserved?.transaction_built),
          exact_roundtrip_fee_lamports: buyFee !== null && sellFee !== null ? Number(buyFee) + Number(sellFee) : null,
          exact_transaction_fee_ready: Boolean(buyObserved?.exact_transaction_fee_ready && sellObserved?.exact_transaction_fee_ready),
          rent_lamports_required: null,
          buy_simulation_ok: Boolean(buyObserved?.simulation_ok),
          sell_simulation_ok: Boolean(sellObserved?.simulation_ok),
          roundtrip_simulation_ok: Boolean(buyObserved?.simulation_ok && sellObserved?.simulation_ok),
          simulation_ok: Boolean(buyObserved?.simulation_ok && sellObserved?.simulation_ok),
          simulation_account_state_available: accountStateAvailable,
          simulation_state_limited: !accountStateAvailable,
          atomic_two_leg: false,
          source: 'MIXED_NATIVE_OR_JUPITER_BUILD+SOLANA_RPC'
        });
      }
    } catch (error) {
      simulationError = String(error?.message || error);
    }

    const exactFee = simulation?.exact_fee_lamports ?? simulation?.exact_roundtrip_fee_lamports ?? null;
    const accountSetupLamports = simulation?.rent_lamports_required ?? null;
    const net = finalizeExpectedNetEdge({
      grossExecutableSpreadBps: gross,
      exactRoundtripFeeLamports: exactFee,
      exactAccountSetupLamports: accountSetupLamports,
      solUsd,
      notionalUsdc: selectedNotionalUsdc,
      minimumNetEdgeBps: minNetEdgeBps
    });

    const finalEvidenceAtMs = Date.now();
    const endToEndAgeMs = finalEvidenceAtMs - opportunityStartedAt;
    const finalMarketStateAgeMs = marketStateAgeMsAt(finalEvidenceAtMs);
    if (endToEndAgeMs > paperExecutionSlaMs) {
      pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'PAPER_EXECUTION_SLA_REJECTED', buy_dex: selected.buy_dex, sell_dex: selected.sell_dex, gross_executable_spread_bps: gross, analysis_latency_ms: analysisLatencyMs, opportunity_age_ms: endToEndAgeMs, market_state_age_ms: finalMarketStateAgeMs, paper_execution_sla_ms: paperExecutionSlaMs, expected_net_edge_bps: net.expected_net_edge_bps });
      return;
    }
    if (finalMarketStateAgeMs > maxOpportunityAgeMs) {
      pushResult({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'MARKET_STATE_STALE_REJECTED', buy_dex: selected.buy_dex, sell_dex: selected.sell_dex, gross_executable_spread_bps: gross, analysis_latency_ms: analysisLatencyMs, opportunity_age_ms: endToEndAgeMs, market_state_age_ms: finalMarketStateAgeMs, max_opportunity_age_ms: maxOpportunityAgeMs, expected_net_edge_bps: net.expected_net_edge_bps });
      return;
    }

    const notionalUsdc = selectedNotionalUsdc;
    const networkFeeUsdc = Number.isFinite(Number(net.exact_network_fee_bps)) ? notionalUsdc * Number(net.exact_network_fee_bps) / 10_000 : null;
    const accountSetupUsdc = Number.isFinite(Number(net.exact_account_setup_bps)) ? notionalUsdc * Number(net.exact_account_setup_bps) / 10_000 : null;
    const transactionBuilt = Boolean(simulation?.transaction_built || (simulation?.buy?.transaction_built && simulation?.sell?.transaction_built));
    const atomicTwoLeg = simulation?.atomic_two_leg === true || simulation?.atomic_two_leg_transaction === true;
    const roundtripSimulationOk = Boolean(simulation?.simulation_ok ?? simulation?.roundtrip_simulation_ok);
    const exactFeeReady = simulation?.exact_transaction_fee_ready === true;
    // Rent-exempt ATA deposits are setup capital, not recurring trading cost.
    // Exact recurring-cost verification therefore requires the transaction fee,
    // build and simulation evidence; setup reserve remains separately observable.
    const costsVerified = net.net_edge_costs_included === true && exactFee !== null && exactFeeReady && transactionBuilt;
    const finalAgeMs = Date.now() - opportunityStartedAt;
    const buyPoolPairVerified = buyQuote?.pool_pair_verified === true;
    const sellPoolPairVerified = sellQuote?.pool_pair_verified === true;
    const paperApprovalPassed = Boolean(
      selected.buy_dex && selected.sell_dex &&
      selected.buy_dex_family && selected.sell_dex_family &&
      selected.buy_dex_family !== selected.sell_dex_family &&
      selected.buy_pool_address && selected.sell_pool_address &&
      selected.buy_pool_address !== selected.sell_pool_address &&
      buyPoolPairVerified && sellPoolPairVerified &&
      transactionBuilt && atomicTwoLeg && exactFeeReady && costsVerified && roundtripSimulationOk &&
      net.net_edge_gate_passed === true &&
      analysisLatencyMs <= analysisSlaMs &&
      finalAgeMs <= paperExecutionSlaMs &&
      finalMarketStateAgeMs <= maxOpportunityAgeMs
    );
    const finalStatus = paperApprovalPassed
      ? 'PAPER_QUALIFIED'
      : !transactionBuilt ? 'TRANSACTION_BUILD_REJECTED'
        : !roundtripSimulationOk ? 'SIMULATION_REJECTED'
          : !costsVerified ? 'EXACT_COST_REJECTED'
            : net.net_edge_gate_passed === true ? 'PAPER_APPROVAL_REJECTED' : 'NET_EDGE_REJECTED';
    const grossProfitBeforeCostsUsdc = Number.isFinite(Number(net.gross_executable_spread_bps)) ? notionalUsdc * Number(net.gross_executable_spread_bps) / 10_000 : null;
    const marketNetPnlUsdc = Number.isFinite(Number(net.expected_net_edge_bps)) ? notionalUsdc * Number(net.expected_net_edge_bps) / 10_000 : null;

    pushResult({
      symbol: row.base_token?.symbol || null,
      token_mint: row.primary_mint,
      quote_mint: routeQuoteMint,
      quote_asset: routeQuoteMint === USDC_MINT ? 'USDC' : routeQuoteMint === WSOL_MINT ? 'WSOL' : 'UNKNOWN',
      buy_pool_address: selected.buy_pool_address || selected.buy_amm_address || buyQuote?.pool_address || null,
      sell_pool_address: selected.sell_pool_address || selected.sell_amm_address || sellQuote?.pool_address || null,
      notional_usdc: notionalUsdc,
      risk_position_pct: riskPositionPct,
      gross_profit_before_costs_usdc: grossProfitBeforeCostsUsdc,
      network_fee_usdc: networkFeeUsdc,
      account_setup_usdc: accountSetupUsdc,
      market_net_pnl_usdc: marketNetPnlUsdc,
      market_execution_cost_usdc: grossProfitBeforeCostsUsdc !== null && marketNetPnlUsdc !== null ? Math.max(0, grossProfitBeforeCostsUsdc - marketNetPnlUsdc) : null,
      costs_verified: costsVerified,
      observed_at: new Date().toISOString(),
      analysis_latency_ms: analysisLatencyMs,
      analysis_sla_ms: analysisSlaMs,
      analysis_sla_passed: analysisLatencyMs <= analysisSlaMs,
      paper_execution_sla_ms: paperExecutionSlaMs,
      opportunity_age_ms: finalAgeMs,
      market_state_age_ms: finalMarketStateAgeMs,
      max_opportunity_age_ms: maxOpportunityAgeMs,
      status: net.net_edge_costs_included ? finalStatus : 'NET_EDGE_INCOMPLETE',
      buy_dex: selected.buy_dex,
      sell_dex: selected.sell_dex,
      buy_pool_pair_verified: buyPoolPairVerified,
      sell_pool_pair_verified: sellPoolPairVerified,
      buy_dex_family: selected.buy_dex_family,
      sell_dex_family: selected.sell_dex_family,
      route_type: 'CROSS_DEX_TWO_POOL',
      atomic_coupling_mode: selectedCouplingMode,
      exact_out_fallback_reason: selectedExactOutFallbackReason,
      dex_pair_attempts: quoteAttempts.length,
      buy_dexes_preflight_ok: routableCandidateCount,
      sell_dexes_preflight_ok: routableCandidateCount,
      provisional_cross_venue_spread_bps: selected.provisional_cross_venue_spread_bps,
      gross_executable_spread_bps: net.gross_executable_spread_bps,
      exact_roundtrip_fee_lamports: exactFee,
      exact_network_fee_bps: net.exact_network_fee_bps,
      exact_account_setup_bps: net.exact_account_setup_bps,
      exact_recurring_execution_cost_bps: net.exact_recurring_execution_cost_bps,
      exact_total_execution_cost_bps: net.exact_total_execution_cost_bps,
      setup_capital_verified: net.setup_capital_verified === true,
      rent_lamports_required: accountSetupLamports,
      sol_usd_reference: solUsd,
      expected_net_edge_bps: net.expected_net_edge_bps,
      net_edge_costs_included: net.net_edge_costs_included,
      min_expected_net_edge_bps: net.min_expected_net_edge_bps,
      net_edge_gate_passed: net.net_edge_gate_passed,
      estimated_price_impact_bps: impact,
      price_impact_warning: priceImpactWarning,
      transaction_built: transactionBuilt,
      atomic_two_leg: atomicTwoLeg,
      exact_transaction_fee_ready: exactFeeReady,
      simulation_attempted: simulation?.simulation_attempted === true || Boolean(simulation?.buy || simulation?.sell),
      roundtrip_simulation_ok: roundtripSimulationOk,
      paper_approval_passed: paperApprovalPassed,
      simulation_state_limited: Boolean(simulation?.simulation_state_limited),
      simulation_error: simulation?.simulation_error ?? simulationError,
      mode: 'SHADOW',
      execution_ready: false,
      execution_dispatched: false,
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  };

  let nextRowIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextRowIndex++;
      if (index >= rows.length) return;
      try { await processRow(rows[index]); } catch (error) {
        pushResult({ symbol: rows[index]?.base_token?.symbol || null, token_mint: rows[index]?.primary_mint || null, status: 'HOTPATH_ERROR', expected_net_edge_bps: null, error: String(error?.message || error) });
      }
      if (nativeTokenPacingMs > 0 && index + 1 < rows.length) await sleep(nativeTokenPacingMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(hotPathWorkers, rows.length) }, () => worker()));

  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
    observed_at: new Date().toISOString(),
    discovery_views: discoveryViews,
    discovery_errors: discoveryErrors,
    candidates_discovered: candidateMap.size,
    multi_venue_candidates_discovered: [...candidateMap.values()].filter(row => candidateVenueBreadth(row) >= 2).length,
    dexscreener_discovery_tokens_seen: dexScreenerDiscoveryTokensSeen,
    dexscreener_discovery_tokens_added: dexScreenerDiscoveryTokensAdded,
    dexscreener_discovery_verified_pools: dexScreenerDiscoveryVerifiedPools,
    pool_universe_enrich_limit: poolUniverseEnrichLimit,
    pool_universe_enriched_tokens: poolUniverseEnrichedTokens,
    pool_universe_direct_usdc_pools: poolUniverseDirectUsdcPools,
    pool_universe_enriched_mints: poolUniverseEnrichedMints,
    real_market_route_anchors_enabled: REAL_MARKET_ROUTE_ANCHORS_ENABLED,
    route_anchor_candidates: [...candidateMap.values()].filter(row => row?._aether_route_anchor === true).length,
    candidate_priority_mode: 'DISCOVERY_DEX_BREADTH_THEN_LIQUIDITY_VOLUME',
    candidates_scanned: rows.length,
    candidate_limit: candidateLimit,
    hotpath_token_budget: hotPathTokenBudget,
    hotpath_rotation_offset: hotPathRotationOffset,
    hotpath_universe_pass: hotPathUniversePass,
    eligible_candidates_this_universe: eligibleUniverseTargets.length,
    token_universe_policy: candidateLimit === null ? 'ALL_REAL_MARKET_DISCOVERED_TOKENS_ROTATING_WORK_BUDGET' : 'CONFIGURED_SCAN_CAP_ROTATING_WORK_BUDGET',
    approval_key: 'POST_COST_NET_EDGE',
    sol_usd_reference: solUsd,
    min_expected_net_edge_bps: minNetEdgeBps,
    max_dex_pair_attempts: maxDexPairAttempts,
    native_direct_pair_limit: nativeDirectPairLimit,
    native_exact_pair_limit: nativeExactPairLimit,
    native_preflight_enabled: nativePreflightEnabled,
    native_rpc_concurrency: nativeRpcConcurrency,
    native_warm_concurrency: nativeWarmConcurrency,
    native_token_pacing_ms: nativeTokenPacingMs,
    rpc_provider_path: rpcProviderPath,
    rpc_primary_health: rpcPrimaryHealth,
    rpc_failover_active: rpcSelection.failover === true,
    shadow_dex_families: SHADOW_DEX_FAMILIES,
    results,
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
    probe: 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
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