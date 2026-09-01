import assert from 'node:assert/strict';
import { createMarketIntelligenceService, normalizeSolanaMint } from '../services/api/src/market-intelligence.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let out = '';
  while (value > 0n) {
    const rem = Number(value % 58n);
    value /= 58n;
    out = ALPHABET[rem] + out;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return '1'.repeat(zeroes) + (out || '1');
}

const mint = base58(new Uint8Array(32).fill(7));
const quoteMint = base58(new Uint8Array(32).fill(8));
const poolAddress = base58(new Uint8Array(32).fill(9));
const secondMint = base58(new Uint8Array(32).fill(10));
const secondPoolAddress = base58(new Uint8Array(32).fill(11));
let clock = Date.parse('2026-09-01T04:30:00.000Z');
let calls = 0;
let providerDown = false;
let canonicalMismatch = false;

function poolRow({ address, baseMint, name, symbol, volume, liquidity, change }) {
  return {
    id: `solana_${address}`,
    type: 'pool',
    attributes: {
      address,
      name: `${symbol} / SOL`,
      base_token_price_usd: '1.25',
      quote_token_price_usd: '0.99',
      reserve_in_usd: String(liquidity),
      volume_usd: { h24: String(volume) },
      market_cap_usd: '4200000',
      fdv_usd: '5000000',
      price_change_percentage: { m5: '1', h1: '2', h6: '3', h24: String(change) },
      transactions: { h24: { buys: 120, sells: 80 } },
      pool_created_at: '2026-08-01T00:00:00Z'
    },
    relationships: {
      base_token: { data: { id: `solana_${baseMint}`, type: 'token' } },
      quote_token: { data: { id: `solana_${quoteMint}`, type: 'token' } },
      dex: { data: { id: 'jupiter-test', type: 'dex' } }
    }
  };
}

function discoveryPayload(rows) {
  return {
    data: rows,
    included: [
      { id: `solana_${mint}`, type: 'token', attributes: { address: mint, name: 'AETHER Test Token', symbol: 'ATT' } },
      { id: `solana_${secondMint}`, type: 'token', attributes: { address: secondMint, name: 'Second Token', symbol: 'SECOND' } },
      { id: `solana_${quoteMint}`, type: 'token', attributes: { address: quoteMint, name: 'Quote', symbol: 'SOL' } }
    ]
  };
}

const firstDiscoveryPool = poolRow({ address: poolAddress, baseMint: mint, name: 'AETHER Test Token', symbol: 'ATT', volume: 750000, liquidity: 2500000, change: 10 });
const secondDiscoveryPool = poolRow({ address: secondPoolAddress, baseMint: secondMint, name: 'Second Token', symbol: 'SECOND', volume: 200000, liquidity: 800000, change: 50 });

const fetchImpl = async url => {
  calls += 1;
  if (providerDown) throw new Error('provider_network_down');
  const value = String(url);
  if (value.includes('/networks/solana/trending_pools?')) return response(discoveryPayload([firstDiscoveryPool, secondDiscoveryPool]));
  if (value.includes('/networks/solana/new_pools?')) return response(discoveryPayload([secondDiscoveryPool, firstDiscoveryPool]));
  if (value.includes('/networks/solana/pools?include=')) return response(discoveryPayload([firstDiscoveryPool, secondDiscoveryPool]));
  if (value.includes(`/tokens/${mint}/info`)) {
    return response({ data: { id: `solana_${mint}`, type: 'token', attributes: { address: canonicalMismatch ? quoteMint : mint, name: 'AETHER Test Token', symbol: 'ATT' } } });
  }
  if (value.includes(`/tokens/${mint}/pools`)) {
    return response({
      data: [firstDiscoveryPool],
      included: [
        { id: `solana_${mint}`, type: 'token', attributes: { address: mint, name: 'AETHER Test Token', symbol: 'ATT' } },
        { id: `solana_${quoteMint}`, type: 'token', attributes: { address: quoteMint, name: 'Quote', symbol: 'USDQ' } }
      ]
    });
  }
  if (value.includes(`/pools/${poolAddress}/ohlcv/minute`)) {
    return response({ data: { attributes: { ohlcv_list: [
      [1788236100, 1.10, 1.20, 1.05, 1.15, 10000],
      [1788237000, 1.15, 1.30, 1.12, 1.25, 12000]
    ] } } });
  }
  return { ok: false, status: 404, async json() { return {}; } };
};

function response(body) { return { ok: true, status: 200, async json() { return body; } }; }

assert.equal(normalizeSolanaMint(mint), mint);
assert.throws(() => normalizeSolanaMint('not-a-mint'), /invalid_token_mint/);

const service = createMarketIntelligenceService({ fetchImpl, now: () => clock });
const first = await service.getToken(mint);
assert.equal(first.token.mint, mint);
assert.equal(first.token.name, 'AETHER Test Token');
assert.equal(first.token.symbol, 'ATT');
assert.equal(first.market.price_usd, 1.25);
assert.equal(first.market.liquidity_usd, 2_500_000);
assert.equal(first.market.volume_24h_usd, 750_000);
assert.equal(first.market.pool_address, poolAddress);
assert.equal(first.market.candles.length, 2);
assert.equal(first.risk.label, 'UNASSESSED');
assert.equal(first.signal.state, 'INSUFFICIENT_DATA');
assert.equal(first.freshness.execution_ready, false);
assert.equal(first.read_only, true);
assert.equal(first.live_execution_authorized, false);
assert.equal(first.mode, 'SHADOW');
assert.equal(first.source, 'GECKOTERMINAL_PUBLIC');
const afterFirst = calls;

clock += 10_000;
const cached = await service.getToken(mint);
assert.equal(calls, afterFirst, 'fresh cache should avoid provider calls');
assert.equal(cached.freshness.stale, false);
assert.equal(cached.freshness.execution_ready, false);

const trending = await service.getDiscovery('trending');
assert.equal(trending.network, 'solana');
assert.equal(trending.items.length, 2);
assert.equal(trending.items[0].primary_mint, mint);
assert.equal(trending.items[0].transactions_24h, 200);
assert.equal(trending.items[0].risk.label, 'UNASSESSED');
assert.equal(trending.freshness.execution_ready, false);
assert.equal(trending.read_only, true);
assert.equal(trending.live_execution_authorized, false);

const gainers = await service.getDiscovery('gainers');
assert.equal(gainers.items[0].primary_mint, secondMint, 'gainers should sort descending by 24h change');
const afterGainers = calls;
const volume = await service.getDiscovery('volume');
assert.equal(volume.items[0].primary_mint, mint, 'volume should sort descending by 24h volume');
assert.equal(calls, afterGainers, 'gainers and volume should share the cached top-pools source');
const fresh = await service.getDiscovery('new');
assert.equal(fresh.items[0].primary_mint, secondMint);
await assert.rejects(() => service.getDiscovery('anything'), /invalid_market_discovery_view/);

clock += 31_000;
providerDown = true;
const stale = await service.getToken(mint);
assert.equal(stale.freshness.stale, true, 'recent real data may be shown only as stale fallback');
assert.equal(stale.freshness.execution_ready, false);
assert.equal(stale.live_execution_authorized, false);

clock += 6 * 60_000;
await assert.rejects(() => service.getToken(mint), /provider_network_down/);
providerDown = false;

const mismatchService = createMarketIntelligenceService({ fetchImpl, now: () => clock });
canonicalMismatch = true;
await assert.rejects(() => mismatchService.getToken(mint), /market_provider_canonical_mismatch/);
canonicalMismatch = false;

assert.equal(JSON.stringify(first).includes('private_key'), false);
assert.equal(JSON.stringify(first).includes('seed phrase'), false);
assert.equal(JSON.stringify(trending).includes('private_key'), false);
console.log('market intelligence regression: PASS');
