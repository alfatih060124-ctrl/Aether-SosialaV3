import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const cacheDir = mkdtempSync(path.join(tmpdir(), 'aether-market-cache-regression-'));
process.env.AETHER_MARKET_DISCOVERY_CACHE_DIR = cacheDir;

const { createMarketIntelligenceService } = await import(`./market-intelligence.mjs?cache-regression=${Date.now()}`);
let nowMs = 1_000_000;
let fetchCalls = 0;
const payload = {
  data: [{
    attributes: {
      address: WSOL,
      name: 'SOL / USDC',
      base_token_price_usd: '150',
      reserve_in_usd: '1000000',
      volume_usd: { h24: '500000' },
      transactions: { h24: { buys: 10, sells: 9 } }
    },
    relationships: {
      base_token: { data: { id: `solana_${WSOL}` } },
      quote_token: { data: { id: `solana_${USDC}` } },
      dex: { data: { id: 'raydium' } }
    }
  }],  included: [
    { type: 'token', id: `solana_${WSOL}`, attributes: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL' } },
    { type: 'token', id: `solana_${USDC}`, attributes: { address: USDC, name: 'USD Coin', symbol: 'USDC' } }
  ]
};

function okResponse() {
  return { status: 200, ok: true, json: async () => payload };
}

const fetchImpl = async () => {
  fetchCalls += 1;
  return okResponse();
};

try {
  const first = createMarketIntelligenceService({ fetchImpl, now: () => nowMs });
  const fresh = await first.getDiscovery('trending');
  assert.equal(fetchCalls, 1);
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.freshness.stale, false);

  const second = createMarketIntelligenceService({ fetchImpl, now: () => nowMs });
  const cached = await second.getDiscovery('trending');
  assert.equal(fetchCalls, 1);
  assert.equal(cached.items.length, 1);
  assert.equal(cached.freshness.stale, false);
  nowMs += 61_000;
  const rateLimitedFetch = async () => {
    fetchCalls += 1;
    return { status: 429, ok: false, json: async () => ({}) };
  };
  const third = createMarketIntelligenceService({ fetchImpl: rateLimitedFetch, now: () => nowMs });
  const stale = await third.getDiscovery('trending');
  assert.equal(fetchCalls, 2);
  assert.equal(stale.items.length, 1);
  assert.equal(stale.freshness.stale, true);
  assert.match(stale.freshness.stale_reason, /market_provider_rate_limited/);

  console.log('market intelligence persistent discovery cache regression: ok');
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
