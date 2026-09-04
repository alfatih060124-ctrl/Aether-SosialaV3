import { createMarketIntelligenceService, normalizeSolanaMint } from '../services/api/src/market-intelligence.mjs';
import { createSolanaHolderConcentrationService } from '../services/api/src/solana-holder-concentration.mjs';
import { createJupiterQuoteEvidenceService } from '../services/api/src/jupiter-quote-evidence.mjs';
import { createJupiterUnsignedSimulationService } from '../services/api/src/jupiter-unsigned-simulation.mjs';
import {
  computeExecutableRoundTripEdgeBps,
  finalizeExpectedNetEdge,
  rankCrossVenueReportPairs
} from '../services/api/src/cross-venue-net-edge.mjs';

const JUPITER_ORIGIN = 'https://api.jup.ag';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DISCOVERY_VIEWS = new Set(['trending', 'new', 'gainers', 'volume']);
const apiKey = String(process.env.JUPITER_API_KEY || '').trim();
const rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim();
const legacyView = String(process.env.AETHER_MARKET_VIEW || '').trim().toLowerCase();
const discoveryViewsRaw = String(process.env.AETHER_MARKET_VIEWS || legacyView || 'trending,gainers,volume');
const discoveryViews = [...new Set(discoveryViewsRaw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
if (!discoveryViews.length || discoveryViews.some(item => !DISCOVERY_VIEWS.has(item))) throw new Error('invalid_market_discovery_views');
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 20);
const perViewLimit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 20;
const candidateLimitRaw = Number(process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT || 40);
const candidateLimit = Number.isSafeInteger(candidateLimitRaw) ? Math.min(60, Math.max(1, candidateLimitRaw)) : 40;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const maxPriceImpactBps = Math.max(0, Number(process.env.SIGNAL_MAX_PRICE_IMPACT_BPS || 100));
const quoteUsdcRaw = String(process.env.AETHER_JUPITER_QUOTE_USDC_RAW || '100000000').trim();
const interRequestDelayMs = Number(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || (apiKey ? 1100 : 2200));
const minNetEdgeBps = Math.max(20, Number(process.env.SIGNAL_MIN_EXPECTED_NET_EDGE_BPS || 20));
const dexPairAttemptsRaw = Number(process.env.AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS || 6);
const maxDexPairAttempts = Number.isSafeInteger(dexPairAttemptsRaw) ? Math.min(12, Math.max(1, dexPairAttemptsRaw)) : 6;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function candidateDiscoveryScore(row) {
  const liquidity = finite(row?.liquidity_usd) ?? 0;
  const volume = finite(row?.volume_24h_usd) ?? 0;
  return liquidity + volume;
}

async function getJson(url, timeoutMs = 10000, retries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
      if (response.status === 429) throw new Error('jupiter_rate_limited');
      if (!response.ok) throw new Error(`jupiter_http_${response.status}`);
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
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
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

async function jupiterQuote({ inputMint, outputMint, amount, dex = null, onlyDirectRoutes = false }) {
  const url = new URL('/swap/v1/quote', JUPITER_ORIGIN);
  url.searchParams.set('inputMint', normalizeSolanaMint(inputMint));
  url.searchParams.set('outputMint', normalizeSolanaMint(outputMint));
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(Math.max(1, Math.trunc(Number(process.env.SIGNAL_MAX_SLIPPAGE_BPS || 100)))));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  url.searchParams.set('instructionVersion', 'V2');
  if (dex) url.searchParams.set('dexes', dex);
  if (onlyDirectRoutes) url.searchParams.set('onlyDirectRoutes', 'true');
  return getJson(url);
}

function observedMaxPriceImpactBps(buy, sell) {
  const buyPct = finite(buy?.priceImpactPct);
  const sellPct = finite(sell?.priceImpactPct);
  if (buyPct === null || sellPct === null) return null;
  return Math.max(buyPct, sellPct) * 10000;
}

async function programLabels() {
  const url = new URL('/swap/v1/program-id-to-label', JUPITER_ORIGIN);
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

async function solUsdReference() {
  const quote = await jupiterQuote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: '1000000000' });
  const raw = Number(quote?.outAmount);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error('sol_usdc_reference_unavailable');
  return raw / 1_000_000;
}

const market = createMarketIntelligenceService({ timeoutMs: 8000 });
const holders = createSolanaHolderConcentrationService({ timeoutMs: 8000 });
const quotes = createJupiterQuoteEvidenceService({ timeoutMs: 10000 });
const unsigned = createJupiterUnsignedSimulationService({ timeoutMs: 12000 });

try {
  const solUsd = await solUsdReference();
  await sleep(interRequestDelayMs);
  const labelsByProgram = await programLabels();
  await sleep(interRequestDelayMs);

  const candidateMap = new Map();
  const discoveryErrors = [];
  for (const discoveryView of discoveryViews) {
    try {
      const discovery = await market.getDiscovery(discoveryView);
      for (const row of discovery.items.slice(0, perViewLimit)) {
        const key = String(row?.primary_mint || '').trim();
        if (!key) continue;
        const existing = candidateMap.get(key);
        if (!existing || candidateDiscoveryScore(row) > candidateDiscoveryScore(existing)) candidateMap.set(key, row);
      }
    } catch (error) {
      discoveryErrors.push({ view: discoveryView, error: String(error?.message || error) });
    }
  }
  if (!candidateMap.size) throw new Error('market_discovery_unavailable');

  const rows = [...candidateMap.values()]
    .sort((a, b) => candidateDiscoveryScore(b) - candidateDiscoveryScore(a))
    .slice(0, candidateLimit);
  const results = [];

  for (const row of rows) {
    const liquidity = finite(row.liquidity_usd);
    const volume = finite(row.volume_24h_usd);
    if (liquidity === null || liquidity < minLiquidityUsd || volume === null || volume < minVolume24hUsd) continue;

    let holder = null;
    try { holder = await holders.getTop10HolderPct(row.primary_mint); } catch { continue; }
    const top10 = finite(holder?.top10_holder_pct);
    if (top10 === null || top10 > maxTop10HolderPct) continue;

    let broad = null;
    try { broad = await quotes.getUsdcRoundTripEvidence(row.primary_mint, { usdcAmountRaw: quoteUsdcRaw }); } catch { continue; }
    if (broad.max_price_impact_bps === null || broad.max_price_impact_bps > maxPriceImpactBps) continue;

    const provisional = rankCrossVenueReportPairs(broad).slice(0, 12);
    if (!provisional.length) {
      results.push({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'NO_MULTI_AMM_REPORT', expected_net_edge_bps: null });
      continue;
    }

    const addresses = [...new Set(provisional.flatMap(item => [item.buy_amm_address, item.sell_amm_address]))];
    let owners;
    try { owners = await ownerPrograms(addresses); } catch { continue; }

    const rawDexPairs = [];
    const seenDexPairs = new Set();
    for (const pair of provisional) {
      const buyProgram = owners.get(pair.buy_amm_address);
      const sellProgram = owners.get(pair.sell_amm_address);
      const buyDex = buyProgram ? labelsByProgram?.[buyProgram] : null;
      const sellDex = sellProgram ? labelsByProgram?.[sellProgram] : null;
      if (!buyDex || !sellDex || buyDex === sellDex) continue;
      const key = `${buyDex}=>${sellDex}`;
      if (seenDexPairs.has(key)) continue;
      seenDexPairs.add(key);
      rawDexPairs.push({ ...pair, buy_dex: String(buyDex), sell_dex: String(sellDex) });
      if (rawDexPairs.length >= maxDexPairAttempts) break;
    }

    if (!rawDexPairs.length) {
      results.push({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'NO_DISTINCT_DEX_PAIR', expected_net_edge_bps: null });
      continue;
    }

    const buyDexes = [...new Set(rawDexPairs.map(item => item.buy_dex))];
    const sellDexes = [...new Set(rawDexPairs.map(item => item.sell_dex))];
    const buyPreflight = new Map();
    const sellPreflight = new Map();
    const preflightAttempts = [];

    for (const dex of buyDexes) {
      await sleep(interRequestDelayMs);
      try {
        const quote = await jupiterQuote({
          inputMint: USDC_MINT,
          outputMint: row.primary_mint,
          amount: quoteUsdcRaw,
          dex,
          onlyDirectRoutes: true
        });
        buyPreflight.set(dex, quote);
        preflightAttempts.push({ side: 'BUY', dex, ok: true });
      } catch (error) {
        preflightAttempts.push({ side: 'BUY', dex, ok: false, error: String(error?.message || error) });
      }
    }

    const sellReferenceAmount = String(broad?.sell?.in_amount || broad?.buy?.out_amount || '').trim();
    if (sellReferenceAmount) {
      for (const dex of sellDexes) {
        await sleep(interRequestDelayMs);
        try {
          const quote = await jupiterQuote({
            inputMint: row.primary_mint,
            outputMint: USDC_MINT,
            amount: sellReferenceAmount,
            dex,
            onlyDirectRoutes: true
          });
          sellPreflight.set(dex, quote);
          preflightAttempts.push({ side: 'SELL', dex, ok: true });
        } catch (error) {
          preflightAttempts.push({ side: 'SELL', dex, ok: false, error: String(error?.message || error) });
        }
      }
    }

    const dexPairs = rawDexPairs.filter(candidate => buyPreflight.has(candidate.buy_dex) && sellPreflight.has(candidate.sell_dex));
    if (!dexPairs.length) {
      results.push({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: 'NO_ROUTABLE_DISTINCT_DEX_PAIR',
        dex_pairs_considered: rawDexPairs.length,
        buy_dexes_preflight_ok: buyPreflight.size,
        sell_dexes_preflight_ok: sellPreflight.size,
        preflight_attempts: preflightAttempts,
        expected_net_edge_bps: null
      });
      continue;
    }

    let selected = null;
    let buyQuote = null;
    let sellQuote = null;
    const quoteAttempts = [];

    for (const candidate of dexPairs) {
      try {
        const candidateBuy = buyPreflight.get(candidate.buy_dex) || await jupiterQuote({
          inputMint: USDC_MINT,
          outputMint: row.primary_mint,
          amount: quoteUsdcRaw,
          dex: candidate.buy_dex,
          onlyDirectRoutes: true
        });
        await sleep(interRequestDelayMs);
        const candidateSell = await jupiterQuote({
          inputMint: row.primary_mint,
          outputMint: USDC_MINT,
          amount: candidateBuy.outAmount,
          dex: candidate.sell_dex,
          onlyDirectRoutes: true
        });
        selected = candidate;
        buyQuote = candidateBuy;
        sellQuote = candidateSell;
        quoteAttempts.push({ buy_dex: candidate.buy_dex, sell_dex: candidate.sell_dex, ok: true });
        break;
      } catch (error) {
        quoteAttempts.push({
          buy_dex: candidate.buy_dex,
          sell_dex: candidate.sell_dex,
          ok: false,
          error: String(error?.message || error)
        });
      }
    }

    if (!selected || !buyQuote || !sellQuote) {
      results.push({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: 'DEX_RESTRICTED_QUOTE_UNAVAILABLE',
        dex_pairs_considered: dexPairs.length,
        dex_pair_attempts: quoteAttempts.length,
        buy_dexes_preflight_ok: buyPreflight.size,
        sell_dexes_preflight_ok: sellPreflight.size,
        preflight_attempts: preflightAttempts,
        quote_attempts: quoteAttempts,
        expected_net_edge_bps: null
      });
      continue;
    }

    const impact = observedMaxPriceImpactBps(buyQuote, sellQuote);
    if (impact === null || impact > maxPriceImpactBps) {
      results.push({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: 'PRICE_IMPACT_REJECTED',
        buy_dex: selected.buy_dex,
        sell_dex: selected.sell_dex,
        dex_pair_attempts: quoteAttempts.length,
        estimated_price_impact_bps: impact,
        expected_net_edge_bps: null
      });
      continue;
    }

    const gross = computeExecutableRoundTripEdgeBps(quoteUsdcRaw, sellQuote.outAmount);
    let simulation = null;
    let simulationError = null;
    try {
      simulation = await unsigned.observeRoundTrip({
        buy: { provider_quote_response: buyQuote },
        sell: { provider_quote_response: sellQuote }
      });
    } catch (error) {
      simulationError = String(error?.message || error);
    }

    const exactFee = simulation?.exact_roundtrip_fee_lamports ?? null;
    const net = finalizeExpectedNetEdge({
      grossExecutableSpreadBps: gross,
      exactRoundtripFeeLamports: exactFee,
      solUsd,
      notionalUsdc: Number(quoteUsdcRaw) / 1_000_000,
      minimumNetEdgeBps: minNetEdgeBps
    });

    results.push({
      symbol: row.base_token?.symbol || null,
      token_mint: row.primary_mint,
      status: net.net_edge_costs_included ? 'NET_EDGE_MEASURED' : 'NET_EDGE_INCOMPLETE',
      buy_dex: selected.buy_dex,
      sell_dex: selected.sell_dex,
      dex_pair_attempts: quoteAttempts.length,
      buy_dexes_preflight_ok: buyPreflight.size,
      sell_dexes_preflight_ok: sellPreflight.size,
      provisional_cross_venue_spread_bps: selected.provisional_cross_venue_spread_bps,
      gross_executable_spread_bps: net.gross_executable_spread_bps,
      exact_roundtrip_fee_lamports: exactFee,
      exact_network_fee_bps: net.exact_network_fee_bps,
      sol_usd_reference: solUsd,
      expected_net_edge_bps: net.expected_net_edge_bps,
      net_edge_costs_included: net.net_edge_costs_included,
      min_expected_net_edge_bps: net.min_expected_net_edge_bps,
      net_edge_gate_passed: net.net_edge_gate_passed,
      estimated_price_impact_bps: impact,
      transaction_built: Boolean(simulation?.buy?.transaction_built && simulation?.sell?.transaction_built),
      exact_transaction_fee_ready: Boolean(simulation?.exact_transaction_fee_ready),
      simulation_state_limited: Boolean(simulation?.simulation_state_limited),
      simulation_error: simulationError,
      mode: 'SHADOW',
      execution_ready: false,
      execution_dispatched: false,
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  console.log(JSON.stringify({
    status: 'ok',
    probe: 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
    observed_at: new Date().toISOString(),
    discovery_views: discoveryViews,
    discovery_errors: discoveryErrors,
    candidates_discovered: candidateMap.size,
    candidates_scanned: rows.length,
    candidate_limit: candidateLimit,
    sol_usd_reference: solUsd,
    min_expected_net_edge_bps: minNetEdgeBps,
    max_dex_pair_attempts: maxDexPairAttempts,
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