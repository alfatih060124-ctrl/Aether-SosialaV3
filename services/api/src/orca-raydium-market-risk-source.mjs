const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';

const finite = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function route(opportunity, key, dex) {
  const value = opportunity?.[key];
  if (!value || typeof value !== 'object') throw new Error(`market_risk_${key}_required`);
  if (value.quote_verified !== true || value.costs_verified !== true) throw new Error(`market_risk_${key}_unverified`);
  const routeDex = text(value.dex_id, `market_risk_${key}_dex_required`).toLowerCase();
  if (routeDex !== dex) throw new Error(`market_risk_${key}_dex_mismatch`);
  return { dex: routeDex, pool: text(value.pool_address, `market_risk_${key}_pool_required`) };
}

function mintFromRelation(value) {
  const id = String(value || '');
  return id.startsWith('solana_') ? id.slice('solana_'.length) : '';
}

function dexMatches(rawDex, expected) {
  const value = String(rawDex || '').toLowerCase();
  return expected === 'orca' ? value.startsWith('orca') : value.startsWith('raydium');
}

async function fetchJson(fetchImpl, path, timeoutMs) {
  const url = new URL(path, PROVIDER_ORIGIN);
  if (url.origin !== PROVIDER_ORIGIN) throw new Error('market_risk_provider_target_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json;version=20230203' },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response || response.ok !== true) throw new Error(`market_risk_provider_http_${response?.status || 'error'}`);
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('market_risk_provider_payload_invalid');
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('market_risk_provider_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePool(payload, expected) {
  const row = payload?.data;
  const attrs = row?.attributes || {};
  const dexId = row?.relationships?.dex?.data?.id;
  const baseMint = mintFromRelation(row?.relationships?.base_token?.data?.id);
  const quoteMint = mintFromRelation(row?.relationships?.quote_token?.data?.id);
  if (!dexMatches(dexId, expected.dex)) throw new Error('market_risk_provider_dex_mismatch');
  if (!((baseMint === expected.tokenMint && quoteMint === expected.quoteMint) || (baseMint === expected.quoteMint && quoteMint === expected.tokenMint))) {
    throw new Error('market_risk_provider_pair_mismatch');
  }
  const side = baseMint === expected.tokenMint ? 'base' : 'quote';
  const volume24h = finite(attrs?.volume_usd?.h24);
  const h1 = attrs?.transactions?.h1 || {};
  const buys = finite(h1.buys);
  const sells = finite(h1.sells);
  if (volume24h === null || volume24h < 0) throw new Error('market_risk_provider_volume_required');
  if (buys === null || buys < 0 || sells === null || sells < 0 || buys + sells <= 0) throw new Error('market_risk_provider_transactions_required');
  return { side, volume24h, buys, sells, dexId: String(dexId), poolId: text(row?.attributes?.address || expected.pool, 'market_risk_provider_pool_id_required') };
}

function normalizeCandles(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error('market_risk_provider_ohlcv_required');
  const candles = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const timestamp = Number(row[0]);
    const open = finite(row[1]);
    const high = finite(row[2]);
    const low = finite(row[3]);
    const close = finite(row[4]);
    if (!Number.isSafeInteger(timestamp) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || high < low) continue;
    candles.push({ timestamp, open, high, low, close });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 13) throw new Error('market_risk_provider_ohlcv_insufficient');
  return candles.slice(-13);
}

function metrics(candles) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const hourAgo = candles.at(0);
  const oneHour = candles.slice(-12);
  const high = Math.max(...oneHour.map(row => row.high));
  const low = Math.min(...oneHour.map(row => row.low));
  const volatility1hBps = ((high / low) - 1) * 10_000;
  const momentum5mBps = ((latest.close / previous.close) - 1) * 10_000;
  const momentum1hBps = ((latest.close / hourAgo.close) - 1) * 10_000;
  if (![volatility1hBps, momentum5mBps, momentum1hBps].every(Number.isFinite)) throw new Error('market_risk_provider_metrics_invalid');
  return { volatility1hBps, momentum5mBps, momentum1hBps };
}

export function createOrcaRaydiumMarketRiskSource({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 5_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('market_risk_fetch_required');
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > 15_000) throw new Error('market_risk_timeout_invalid');

  return async function loadMarketRiskSource(context = {}) {
    if (context.read_only !== true || context.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('market_risk_context_invalid');
    const opportunity = context.opportunity;
    if (!opportunity || typeof opportunity !== 'object') throw new Error('market_risk_opportunity_required');
    const tokenMint = text(context.token_mint, 'market_risk_token_mint_required');
    const quoteMint = text(context.quote_mint, 'market_risk_quote_mint_required');
    if (tokenMint === quoteMint) throw new Error('market_risk_distinct_mints_required');

    const buyDex = text(opportunity?.buy_route?.dex_id, 'market_risk_buy_dex_required').toLowerCase();
    const sellDex = text(opportunity?.sell_route?.dex_id, 'market_risk_sell_dex_required').toLowerCase();
    if (!['orca', 'raydium'].includes(buyDex) || !['orca', 'raydium'].includes(sellDex) || buyDex === sellDex) {
      throw new Error('market_risk_orca_raydium_required');
    }
    const buy = route(opportunity, 'buy_route', buyDex);
    const sell = route(opportunity, 'sell_route', sellDex);

    async function loadOne(item) {
      const poolPayload = await fetchJson(fetchImpl, `/api/v2/networks/solana/pools/${encodeURIComponent(item.pool)}?include=base_token%2Cquote_token%2Cdex`, timeout);
      const pool = normalizePool(poolPayload, { ...item, tokenMint, quoteMint });
      const ohlcv = await fetchJson(fetchImpl, `/api/v2/networks/solana/pools/${encodeURIComponent(item.pool)}/ohlcv/minute?aggregate=5&limit=13&currency=usd&token=${pool.side}`, timeout);
      return { ...pool, ...metrics(normalizeCandles(ohlcv)) };
    }

    const [buyMarket, sellMarket] = await Promise.all([loadOne(buy), loadOne(sell)]);
    const totalBuys = buyMarket.buys + sellMarket.buys;
    const totalSells = buyMarket.sells + sellMarket.sells;
    const buySellImbalance = (totalBuys - totalSells) / (totalBuys + totalSells);
    if (!Number.isFinite(buySellImbalance) || buySellImbalance < -1 || buySellImbalance > 1) throw new Error('market_risk_imbalance_invalid');

    const observed = Number(now());
    if (!Number.isFinite(observed)) throw new Error('market_risk_now_invalid');
    return Object.freeze({
      verified: true,
      volume_24h_usd: Math.min(buyMarket.volume24h, sellMarket.volume24h),
      volatility_1h_bps: Math.max(buyMarket.volatility1hBps, sellMarket.volatility1hBps),
      momentum_5m_bps: (buyMarket.momentum5mBps + sellMarket.momentum5mBps) / 2,
      momentum_1h_bps: (buyMarket.momentum1hBps + sellMarket.momentum1hBps) / 2,
      buy_sell_imbalance: buySellImbalance,
      source: 'GECKOTERMINAL_EXACT_ORCA_RAYDIUM_POOLS',
      source_reference: `${buy.dex}:${buy.pool}|${sell.dex}:${sell.pool}`,
      observed_at: new Date(observed).toISOString(),
      route_pools_verified: true,
      read_only: true,
      transaction_building_authorized: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  };
}

export const ORCA_RAYDIUM_MARKET_RISK_SOURCE = Object.freeze({
  provider: 'GECKOTERMINAL',
  exact_route_pools_required: true,
  dex_scope: Object.freeze(['orca', 'raydium']),
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
