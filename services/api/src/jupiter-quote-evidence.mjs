import { normalizeSolanaMint } from './market-intelligence.mjs';

const JUPITER_ORIGIN = 'https://api.jup.ag';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveIntegerString(value, label) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(label);
  try {
    if (BigInt(raw) <= 0n) throw new Error(label);
  } catch {
    throw new Error(label);
  }
  return raw;
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function quotePriceImpactBps(payload) {
  const pct = finiteNonNegative(payload?.priceImpactPct);
  return pct === null ? null : pct * 10_000;
}

function routeEvidence(payload) {
  const plan = Array.isArray(payload?.routePlan) ? payload.routePlan : [];
  const labels = plan.map(item => String(item?.swapInfo?.label || '').trim()).filter(Boolean);
  return {
    route_hop_count: plan.length,
    distinct_amm_count: new Set(labels).size,
    amm_labels: [...new Set(labels)]
  };
}

async function getJson(fetchImpl, url, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
    if (response.status === 429) throw new Error('jupiter_quote_rate_limited');
    if (!response.ok) throw new Error(`jupiter_quote_http_${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('jupiter_quote_invalid_payload');
    if (body.error) throw new Error('jupiter_quote_no_route');
    positiveIntegerString(body.inAmount, 'jupiter_quote_invalid_in_amount');
    positiveIntegerString(body.outAmount, 'jupiter_quote_invalid_out_amount');
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('jupiter_quote_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createJupiterQuoteEvidenceService({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.JUPITER_API_KEY || '',
  timeoutMs = 10_000,
  slippageBps = Number(process.env.SIGNAL_MAX_SLIPPAGE_BPS || 100),
  interQuoteDelayMs = Number(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || (process.env.JUPITER_API_KEY ? 1100 : 2200))
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const safeSlippageBps = Number.isFinite(Number(slippageBps)) ? Math.min(500, Math.max(1, Math.trunc(Number(slippageBps)))) : 100;
  const safeDelayMs = Number.isFinite(Number(interQuoteDelayMs)) ? Math.min(10_000, Math.max(500, Math.trunc(Number(interQuoteDelayMs)))) : 2200;

  async function quote(inputMint, outputMint, amount) {
    const input = normalizeSolanaMint(inputMint);
    const output = normalizeSolanaMint(outputMint);
    const rawAmount = positiveIntegerString(amount, 'jupiter_quote_amount_required');
    const url = new URL('/swap/v1/quote', JUPITER_ORIGIN);
    url.searchParams.set('inputMint', input);
    url.searchParams.set('outputMint', output);
    url.searchParams.set('amount', rawAmount);
    url.searchParams.set('slippageBps', String(safeSlippageBps));
    url.searchParams.set('restrictIntermediateTokens', 'true');
    url.searchParams.set('instructionVersion', 'V2');
    const payload = await getJson(fetchImpl, url, { apiKey: String(apiKey || '').trim(), timeoutMs });
    return {
      input_mint: input,
      output_mint: output,
      in_amount: payload.inAmount,
      out_amount: payload.outAmount,
      other_amount_threshold: payload.otherAmountThreshold || null,
      price_impact_bps: quotePriceImpactBps(payload),
      ...routeEvidence(payload),
      context_slot: Number.isSafeInteger(Number(payload.contextSlot)) ? Number(payload.contextSlot) : null,
      time_taken_seconds: finiteNonNegative(payload.timeTaken),
      source: 'JUPITER_QUOTE_API',
      api_key_used: Boolean(String(apiKey || '').trim()),
      read_only: true,
      mode: 'SHADOW',
      execution_ready: false,
      transaction_built: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    };
  }

  return Object.freeze({
    inter_quote_delay_ms: safeDelayMs,
    async getUsdcRoundTripEvidence(tokenMint, { usdcAmountRaw = '100000000' } = {}) {
      const mint = normalizeSolanaMint(tokenMint);
      const initialUsdc = positiveIntegerString(usdcAmountRaw, 'jupiter_quote_usdc_amount_required');
      const buy = await quote(USDC_MINT, mint, initialUsdc);
      await sleep(safeDelayMs);
      const sell = await quote(mint, USDC_MINT, buy.out_amount);
      const initial = BigInt(initialUsdc);
      const returned = BigInt(sell.out_amount);
      const delta = returned - initial;
      const roundTripQuoteEdgeBps = Number((delta * 100_000_000n) / initial) / 10_000;
      const maxPriceImpactBps = Math.max(buy.price_impact_bps ?? Infinity, sell.price_impact_bps ?? Infinity);
      return Object.freeze({
        base_asset: 'USDC',
        usdc_notional: Number(initial) / 1_000_000,
        buy,
        sell,
        buy_quote_ok: true,
        sell_quote_ok: true,
        sell_path_verified_by_quote: true,
        max_price_impact_bps: Number.isFinite(maxPriceImpactBps) ? maxPriceImpactBps : null,
        roundtrip_quote_edge_bps: roundTripQuoteEdgeBps,
        network_fees_included: false,
        priority_fees_included: false,
        net_edge_costs_included: false,
        sell_simulation_ok: false,
        note: 'Quote evidence proves a current routed buy/sell path only. It does not simulate a transaction and does not include network/priority fees, so it cannot satisfy the final expected-net-edge gate by itself.',
        source_count_observed: 2,
        source_labels: ['GECKOTERMINAL_PUBLIC', 'JUPITER_QUOTE_API'],
        read_only: true,
        mode: 'SHADOW',
        execution_ready: false,
        transaction_built: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}
