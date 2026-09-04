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
const apiKey = String(process.env.JUPITER_API_KEY || '').trim();
const rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim();
const view = String(process.env.AETHER_MARKET_VIEW || 'trending').trim().toLowerCase();
const limitRaw = Number(process.env.AETHER_MARKET_PROBE_LIMIT || 10);
const limit = Number.isSafeInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 10;
const minLiquidityUsd = Math.max(0, Number(process.env.SIGNAL_MIN_LIQUIDITY_USD || 500000));
const minVolume24hUsd = Math.max(0, Number(process.env.SIGNAL_MIN_VOLUME_24H_USD || 250000));
const maxTop10HolderPct = Math.max(0, Number(process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || 35));
const maxPriceImpactBps = Math.max(0, Number(process.env.SIGNAL_MAX_PRICE_IMPACT_BPS || 100));
const quoteUsdcRaw = String(process.env.AETHER_JUPITER_QUOTE_USDC_RAW || '100000000').trim();
const interRequestDelayMs = Number(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || (apiKey ? 1100 : 2200));
const minNetEdgeBps = Math.max(20, Number(process.env.SIGNAL_MIN_EXPECTED_NET_EDGE_BPS || 20));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

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
  const discovery = await market.getDiscovery(view);
  const rows = discovery.items.slice(0, limit);
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

    let selected = null;
    for (const pair of provisional) {
      const buyProgram = owners.get(pair.buy_amm_address);
      const sellProgram = owners.get(pair.sell_amm_address);
      const buyDex = buyProgram ? labelsByProgram?.[buyProgram] : null;
      const sellDex = sellProgram ? labelsByProgram?.[sellProgram] : null;
      if (!buyDex || !sellDex || buyDex === sellDex) continue;
      selected = { ...pair, buy_dex: String(buyDex), sell_dex: String(sellDex) };
      break;
    }

    if (!selected) {
      results.push({ symbol: row.base_token?.symbol || null, token_mint: row.primary_mint, status: 'NO_DISTINCT_DEX_PAIR', expected_net_edge_bps: null });
      continue;
    }

    await sleep(interRequestDelayMs);
    let buyQuote;
    let sellQuote;
    try {
      buyQuote = await jupiterQuote({ inputMint: USDC_MINT, outputMint: row.primary_mint, amount: quoteUsdcRaw, dex: selected.buy_dex, onlyDirectRoutes: true });
      await sleep(interRequestDelayMs);
      sellQuote = await jupiterQuote({ inputMint: row.primary_mint, outputMint: USDC_MINT, amount: buyQuote.outAmount, dex: selected.sell_dex, onlyDirectRoutes: true });
    } catch (error) {
      results.push({
        symbol: row.base_token?.symbol || null,
        token_mint: row.primary_mint,
        status: 'DEX_RESTRICTED_QUOTE_UNAVAILABLE',
        buy_dex: selected.buy_dex,
        sell_dex: selected.sell_dex,
        quote_error: String(error?.message || error),
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
    candidates_scanned: rows.length,
    sol_usd_reference: solUsd,
    min_expected_net_edge_bps: minNetEdgeBps,
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
