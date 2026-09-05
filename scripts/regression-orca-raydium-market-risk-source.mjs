import assert from 'node:assert/strict';
import { createOrcaRaydiumMarketRiskSource, ORCA_RAYDIUM_MARKET_RISK_SOURCE } from '../services/api/src/orca-raydium-market-risk-source.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const nowMs = Date.parse('2026-09-05T21:00:00.000Z');

function poolPayload({ pool, dex, volume, buys, sells }) {
  return {
    data: {
      attributes: { address: pool, volume_usd: { h24: String(volume) }, transactions: { h1: { buys, sells } } },
      relationships: {
        dex: { data: { id: dex } },
        base_token: { data: { id: `solana_${token}` } },
        quote_token: { data: { id: `solana_${quote}` } }
      }
    }
  };
}

function ohlcv(start = 1, drift = 0.001) {
  const rows = [];
  let price = start;
  for (let i = 0; i < 13; i += 1) {
    const open = price;
    const close = open * (1 + drift);
    rows.push([1_788_600_000 + i * 300, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1000]);
    price = close;
  }
  return { data: { attributes: { ohlcv_list: rows } } };
}

const fetchImpl = async url => {
  const value = String(url);
  if (value.includes('/pools/orca-pool?')) return { ok: true, status: 200, json: async () => poolPayload({ pool: 'orca-pool', dex: 'orca_whirlpools', volume: 800000, buys: 70, sells: 30 }) };
  if (value.includes('/pools/raydium-pool?')) return { ok: true, status: 200, json: async () => poolPayload({ pool: 'raydium-pool', dex: 'raydium_clmm', volume: 600000, buys: 40, sells: 60 }) };
  if (value.includes('/pools/orca-pool/ohlcv/')) return { ok: true, status: 200, json: async () => ohlcv(1, 0.001) };
  if (value.includes('/pools/raydium-pool/ohlcv/')) return { ok: true, status: 200, json: async () => ohlcv(1.002, 0.0005) };
  throw new Error(`unexpected_url:${value}`);
};

const opportunity = {
  token_mint: token,
  quote_mint: quote,
  buy_route: { dex_id: 'orca', pool_address: 'orca-pool', quote_verified: true, costs_verified: true },
  sell_route: { dex_id: 'raydium', pool_address: 'raydium-pool', quote_verified: true, costs_verified: true }
};
const source = createOrcaRaydiumMarketRiskSource({ fetchImpl, now: () => nowMs });
const result = await source({ token_mint: token, quote_mint: quote, opportunity, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' });
assert.equal(result.verified, true);
assert.equal(result.volume_24h_usd, 600000);
assert.ok(result.volatility_1h_bps > 0);
assert.ok(result.momentum_5m_bps > 0);
assert.ok(result.momentum_1h_bps > 0);
assert.equal(result.buy_sell_imbalance, 0.1);
assert.equal(result.source, 'GECKOTERMINAL_EXACT_ORCA_RAYDIUM_POOLS');
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.deepEqual(ORCA_RAYDIUM_MARKET_RISK_SOURCE.dex_scope, ['orca', 'raydium']);

await assert.rejects(source({ token_mint: token, quote_mint: quote, opportunity, read_only: false, strategy: 'TWO_LEG_ARBITRAGE' }), /market_risk_context_invalid/);
await assert.rejects(source({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE', opportunity: { ...opportunity, buy_route: { ...opportunity.buy_route, quote_verified: false } } }), /market_risk_buy_route_unverified/);

const wrongDexSource = createOrcaRaydiumMarketRiskSource({
  now: () => nowMs,
  fetchImpl: async url => {
    const value = String(url);
    if (value.includes('/pools/orca-pool?')) return { ok: true, status: 200, json: async () => poolPayload({ pool: 'orca-pool', dex: 'meteora', volume: 1, buys: 1, sells: 1 }) };
    if (value.includes('/pools/raydium-pool?')) return { ok: true, status: 200, json: async () => poolPayload({ pool: 'raydium-pool', dex: 'raydium', volume: 1, buys: 1, sells: 1 }) };
    return { ok: true, status: 200, json: async () => ohlcv() };
  }
});
await assert.rejects(wrongDexSource({ token_mint: token, quote_mint: quote, opportunity, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), /market_risk_provider_dex_mismatch/);

console.log('orca raydium market risk source regression: ok');
