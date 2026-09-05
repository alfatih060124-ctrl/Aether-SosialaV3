const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';
const MIN_NET_EDGE_BPS = 20;
const MIN_POOL_LIQUIDITY_USD = 100000;
const MIN_TOKEN_VOLUME_24H_USD = 250000;
const ESTIMATED_ROUTE_COST_BPS = 20;
const MAX_PRICE_IMPACT_BPS = 100;
const STOP_LOSS_BPS = 500;
const TRAILING_STOP_BPS = 350;

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

async function providerGet(path, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('market_fetch_unavailable');
  const url = new URL(path, PROVIDER_ORIGIN);
  if (url.origin !== PROVIDER_ORIGIN) throw new Error('market_provider_target_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json;version=20230203' },
      signal: controller.signal,
      redirect: 'error'
    });
    if (response.status === 429) throw new Error('market_provider_rate_limited');
    if (!response.ok) throw new Error('market_provider_unavailable');
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('market_provider_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function relationId(pool, side) {
  return pool?.relationships?.[`${side}_token`]?.data?.id || '';
}

function mintFromRelation(value) {
  const id = String(value || '');
  return id.startsWith('solana_') ? id.slice('solana_'.length) : null;
}

function poolForMint(pool, mint) {
  const attrs = pool?.attributes || {};
  const baseMint = mintFromRelation(relationId(pool, 'base'));
  const quoteMint = mintFromRelation(relationId(pool, 'quote'));
  const side = baseMint === mint ? 'base' : quoteMint === mint ? 'quote' : null;
  if (!side) return null;
  const price = finite(attrs[`${side}_token_price_usd`]);
  const liquidity = finite(attrs.reserve_in_usd, 0);
  const volume24h = finite(attrs?.volume_usd?.h24, 0);
  if (!(price > 0) || !(liquidity > 0)) return null;
  return {
    pool_address: attrs.address || null,
    dex_id: pool?.relationships?.dex?.data?.id || null,
    price_usd: price,
    liquidity_usd: liquidity,
    volume_24h_usd: volume24h,
    pool_created_at: attrs.pool_created_at || null
  };
}

function discoveryMint(pool) {
  return mintFromRelation(relationId(pool, 'base'));
}

async function candidateMints(fetchImpl) {
  const payload = await providerGet('/api/v2/networks/solana/trending_pools?include=base_token%2Cquote_token%2Cdex&page=1', fetchImpl);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const items = rows.map(pool => {
    const mint = discoveryMint(pool);
    const attrs = pool?.attributes || {};
    return {
      mint,
      liquidity_usd: finite(attrs.reserve_in_usd, 0),
      volume_24h_usd: finite(attrs?.volume_usd?.h24, 0)
    };
  }).filter(item => item.mint && item.liquidity_usd >= MIN_POOL_LIQUIDITY_USD && item.volume_24h_usd >= MIN_TOKEN_VOLUME_24H_USD);
  items.sort((a,b) => b.volume_24h_usd - a.volume_24h_usd || b.liquidity_usd - a.liquidity_usd);
  return items.slice(0, 8);
}

async function tokenPools(mint, fetchImpl) {
  const payload = await providerGet(`/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?include=base_token%2Cquote_token%2Cdex&page=1&sort=h24_volume_usd_liquidity_desc`, fetchImpl);
  return (Array.isArray(payload?.data) ? payload.data : []).map(row => poolForMint(row, mint)).filter(Boolean);
}

function estimateImpactBps(notional, liquidity) {
  if (!(liquidity > 0)) return Infinity;
  return clamp(Math.ceil((Math.max(0, notional) / liquidity) * 10000), 1, 10000);
}

function opportunityFromPools(mint, pools, notional) {
  const eligible = pools.filter(p => p.liquidity_usd >= MIN_POOL_LIQUIDITY_USD);
  if (eligible.length < 2) return null;
  let best = null;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = 0; j < eligible.length; j++) {
      if (i === j) continue;
      const buy = eligible[i], sell = eligible[j];
      if (buy.dex_id && sell.dex_id && buy.dex_id === sell.dex_id) continue;
      if (!(sell.price_usd > buy.price_usd)) continue;
      const grossEdgeBps = ((sell.price_usd / buy.price_usd) - 1) * 10000;
      const impactBps = estimateImpactBps(notional, buy.liquidity_usd) + estimateImpactBps(notional, sell.liquidity_usd);
      const expectedNetEdgeBps = grossEdgeBps - ESTIMATED_ROUTE_COST_BPS - impactBps;
      const item = { mint, buy_pool: buy, sell_pool: sell, gross_edge_bps: grossEdgeBps, estimated_price_impact_bps: impactBps, estimated_route_cost_bps: ESTIMATED_ROUTE_COST_BPS, expected_net_edge_bps: expectedNetEdgeBps };
      if (!best || item.expected_net_edge_bps > best.expected_net_edge_bps) best = item;
    }
  }
  return best;
}

async function scanOpportunity({ notional, fetchImpl }) {
  const candidates = await candidateMints(fetchImpl);
  let best = null;
  for (const candidate of candidates) {
    try {
      const pools = await tokenPools(candidate.mint, fetchImpl);
      const opportunity = opportunityFromPools(candidate.mint, pools, notional);
      if (!opportunity) continue;
      opportunity.volume_24h_usd = candidate.volume_24h_usd;
      opportunity.route_count = pools.length;
      if (!best || opportunity.expected_net_edge_bps > best.expected_net_edge_bps) best = opportunity;
    } catch {}
  }
  return best;
}

async function currentPriceForPosition(position, fetchImpl) {
  const mint = String(position?.token_mint || '');
  if (!mint) throw new Error('real_market_position_mint_required');
  const pools = await tokenPools(mint, fetchImpl);
  const preferred = pools.find(p => p.pool_address === position.sell_pool_address) || pools.sort((a,b) => b.liquidity_usd-a.liquidity_usd)[0];
  if (!preferred?.price_usd) throw new Error('real_market_position_price_unavailable');
  return preferred;
}

export async function runRealMarketShadowStep({ account, input = {}, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const equity = finite(account?.cash_balance_usdc, 0) + finite(account?.open_position?.notional_usdc, 0);
  const maxTrade = clamp(finite(input.max_trade_usd, equity * 0.1), 1, Math.max(1, equity));
  const allocationBps = clamp(Math.round(finite(input.max_allocation_bps, 1000)), 100, 10000);
  const requested = Math.min(maxTrade, equity * allocationBps / 10000, finite(account?.cash_balance_usdc, 0));
  const open = account?.open_position && typeof account.open_position === 'object' ? account.open_position : {};
  const observedAt = new Date(now).toISOString();

  if (finite(open.notional_usdc, 0) > 0 && open.market_source === 'GECKOTERMINAL_REAL_MARKET') {
    const market = await currentPriceForPosition(open, fetchImpl);
    const entry = finite(open.entry_price_usd);
    const current = market.price_usd;
    const peak = Math.max(finite(open.peak_price_usd, entry), current);
    const pnlBps = entry > 0 ? ((current / entry) - 1) * 10000 : 0;
    const drawdownBps = peak > 0 ? ((current / peak) - 1) * 10000 : 0;
    const exitReasons = [];
    if (pnlBps <= -STOP_LOSS_BPS) exitReasons.push('STOP_LOSS');
    if (peak > entry && drawdownBps <= -TRAILING_STOP_BPS) exitReasons.push('TRAILING_STOP');
    const action = exitReasons.length ? 'SELL' : 'HOLD';
    return {
      product: 'AETHER Auto Strategy', mode: 'SHADOW', market_data_mode: 'REAL_MARKET', training_fixture: false,
      market_source: 'GECKOTERMINAL_PUBLIC', observed_at: observedAt,
      scenario: action === 'SELL' ? 'real_market_exit' : 'real_market_hold',
      scenario_label: `${action} · real market ${open.token_mint.slice(0,6)}… · PnL ${(pnlBps/100).toFixed(2)}%`,
      assessment: { verdict: 'POSITION_MONITOR', expected_net_edge_bps: null, quality_score: null },
      decision: { action, requested_amount_usd: action === 'SELL' ? finite(open.notional_usdc, 0) : 0, reason_codes: exitReasons.length ? exitReasons : ['REAL_MARKET_POSITION_HEALTHY'] },
      position: { position_value_usd: finite(open.notional_usdc,0), entry_price_usd: entry, current_price_usd: current, peak_price_usd: peak, unrealized_pnl_bps: pnlBps },
      open_position_metadata: { ...open, peak_price_usd: peak, last_price_usd: current, last_observed_at: observedAt },
      execution_dispatched:false, transaction_created:false, signer_requested:false, funds_moved:false, network_submission_authorized:false, live_execution_authorized:false
    };
  }

  if (finite(open.notional_usdc, 0) > 0) {
    return {
      product:'AETHER Auto Strategy', mode:'SHADOW', market_data_mode:'REAL_MARKET', training_fixture:false,
      market_source:'GECKOTERMINAL_PUBLIC', observed_at:observedAt, scenario:'legacy_fixture_quarantined', scenario_label:'REJECT · legacy fixture position is excluded from real-market benchmark',
      assessment:{verdict:'REJECTED',expected_net_edge_bps:null,quality_score:null},
      decision:{action:'REJECT',requested_amount_usd:0,reason_codes:['LEGACY_FIXTURE_POSITION_EXCLUDED']},
      position:{}, execution_dispatched:false,transaction_created:false,signer_requested:false,funds_moved:false,network_submission_authorized:false,live_execution_authorized:false
    };
  }

  const opportunity = await scanOpportunity({ notional: requested, fetchImpl });
  const qualifies = Boolean(opportunity && opportunity.expected_net_edge_bps >= MIN_NET_EDGE_BPS && opportunity.estimated_price_impact_bps <= MAX_PRICE_IMPACT_BPS && opportunity.volume_24h_usd >= MIN_TOKEN_VOLUME_24H_USD && opportunity.route_count >= 2);
  const action = qualifies && requested > 0 ? 'BUY' : 'REJECT';
  const reasons = [];
  if (!opportunity) reasons.push('NO_MULTI_POOL_REAL_MARKET_OPPORTUNITY');
  else {
    if (opportunity.expected_net_edge_bps < MIN_NET_EDGE_BPS) reasons.push('EXPECTED_NET_EDGE_BELOW_0_20_PERCENT');
    if (opportunity.estimated_price_impact_bps > MAX_PRICE_IMPACT_BPS) reasons.push('PRICE_IMPACT_TOO_HIGH');
    if (opportunity.volume_24h_usd < MIN_TOKEN_VOLUME_24H_USD) reasons.push('INSUFFICIENT_VOLUME');
    if (opportunity.route_count < 2) reasons.push('INSUFFICIENT_MARKET_ROUTES');
  }
  if (qualifies) reasons.push('REAL_MARKET_NET_EDGE_AND_LIQUIDITY_FILTERS_PASSED','SHADOW_HISTORY_COLLECTION_UNLIMITED');

  const tokenLabel = opportunity?.mint ? `${opportunity.mint.slice(0,6)}…` : 'scan';
  return {
    product:'AETHER Auto Strategy', mode:'SHADOW', market_data_mode:'REAL_MARKET', training_fixture:false,
    market_source:'GECKOTERMINAL_PUBLIC', observed_at:observedAt,
    scenario: action === 'BUY' ? 'real_market_entry' : 'real_market_reject',
    scenario_label: opportunity ? `${action} · ${tokenLabel} · expected net edge ${(opportunity.expected_net_edge_bps/100).toFixed(3)}%` : 'REJECT · no qualifying multi-pool opportunity',
    assessment:{ verdict: qualifies?'QUALIFIED':'REJECTED', expected_net_edge_bps: opportunity?.expected_net_edge_bps ?? null, minimum_expected_net_edge_bps:MIN_NET_EDGE_BPS, quality_score:null, snapshot:opportunity || null },
    decision:{ action, requested_amount_usd: action === 'BUY' ? requested : 0, reason_codes: reasons },
    position:{},
    open_position_metadata: action === 'BUY' ? {
      market_source:'GECKOTERMINAL_REAL_MARKET', token_mint:opportunity.mint,
      entry_price_usd:opportunity.buy_pool.price_usd, peak_price_usd:opportunity.buy_pool.price_usd,
      buy_pool_address:opportunity.buy_pool.pool_address, sell_pool_address:opportunity.sell_pool.pool_address,
      buy_dex_id:opportunity.buy_pool.dex_id, sell_dex_id:opportunity.sell_pool.dex_id,
      expected_net_edge_bps:opportunity.expected_net_edge_bps, opened_market_at:observedAt
    } : null,
    execution_dispatched:false,transaction_created:false,signer_requested:false,funds_moved:false,network_submission_authorized:false,live_execution_authorized:false
  };
}

export const REAL_MARKET_SHADOW_MIN_NET_EDGE_BPS = MIN_NET_EDGE_BPS;
