import assert from 'node:assert/strict';

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
let primaryCalls = 0;
let providerCalls = 0;

const pool = {
  type: 'pool',
  id: `solana_${poolAddress}`,
  attributes: {
    address: poolAddress,
    name: 'EDGE / SOL',
    base_token_price_usd: '2',
    quote_token_price_usd: '1',
    reserve_in_usd: '1000000',
    volume_usd: { h24: '500000' },
    price_change_percentage: { m5: '1', h1: '2', h6: '3', h24: '12' },
    transactions: { h24: { buys: 50, sells: 30 } },
    pool_created_at: '2026-08-31T00:00:00Z'
  },
  relationships: {
    base_token: { data: { id: `solana_${mint}`, type: 'token' } },
    quote_token: { data: { id: `solana_${quoteMint}`, type: 'token' } },
    dex: { data: { id: 'edge-dex', type: 'dex' } }
  }
};
const included = [
  { type: 'token', id: `solana_${mint}`, attributes: { address: mint, name: 'Edge Token', symbol: 'EDGE' } },
  { type: 'token', id: `solana_${quoteMint}`, attributes: { address: quoteMint, name: 'Quote', symbol: 'SOL' } }
];

globalThis.fetch = async url => {
  const value = String(url);
  if (value.startsWith('https://api.aether.boats')) {
    primaryCalls += 1;
    throw new Error('market_route_must_not_hit_primary');
  }
  providerCalls += 1;
  if (value.includes('/networks/solana/trending_pools?')) return response({ data: [pool], included });
  if (value.includes('/networks/solana/new_pools?')) return response({ data: [pool], included });
  if (value.includes('/networks/solana/pools?include=')) return response({ data: [pool], included });
  if (value.includes(`/tokens/${mint}/info`)) return response({ data: { type: 'token', id: `solana_${mint}`, attributes: { address: mint, name: 'Edge Token', symbol: 'EDGE' } } });
  if (value.includes(`/tokens/${mint}/pools`)) return response({ data: [pool], included });
  if (value.includes(`/pools/${poolAddress}/ohlcv/minute`)) return response({ data: { attributes: { ohlcv_list: [[1788236100, 1.9, 2.1, 1.8, 2, 1000], [1788237000, 2, 2.2, 1.95, 2.1, 1200]] } } });
  return { ok: false, status: 404, async json() { return {}; } };
};

function response(body) { return { ok: true, status: 200, async json() { return body; } }; }
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

const { default: handler } = await import(`../api/index.mjs?market-edge-regression=${Date.now()}`);

const discoveryRes = makeRes();
await handler({ method: 'GET', url: '/api/market/discovery?view=trending', headers: { accept: 'application/json' } }, discoveryRes);
assert.equal(discoveryRes.statusCode, 200);
assert.equal(discoveryRes.body.network, 'solana');
assert.equal(discoveryRes.body.items.length, 1);
assert.equal(discoveryRes.body.items[0].primary_mint, mint);
assert.equal(discoveryRes.body.items[0].transactions_24h, 80);
assert.equal(discoveryRes.body.read_only, true);
assert.equal(discoveryRes.body.freshness.execution_ready, false);
assert.equal(discoveryRes.body.live_execution_authorized, false);
assert.equal(primaryCalls, 0, 'read-only discovery BFF must not hit PRIMARY control-plane');

const invalidDiscoveryRes = makeRes();
await handler({ method: 'GET', url: '/api/market/discovery?view=invalid', headers: {} }, invalidDiscoveryRes);
assert.equal(invalidDiscoveryRes.statusCode, 400);
assert.equal(invalidDiscoveryRes.body.error, 'invalid_market_discovery_view');
assert.equal(invalidDiscoveryRes.body.live_execution_authorized, false);

const okRes = makeRes();
await handler({ method: 'GET', url: `/api/market/token?mint=${mint}`, headers: { accept: 'application/json' } }, okRes);
assert.equal(okRes.statusCode, 200);
assert.equal(okRes.body.token.mint, mint);
assert.equal(okRes.body.market.price_usd, 2);
assert.equal(okRes.body.market.candles.length, 2);
assert.equal(okRes.body.risk.label, 'UNASSESSED');
assert.equal(okRes.body.signal.state, 'INSUFFICIENT_DATA');
assert.equal(okRes.body.read_only, true);
assert.equal(okRes.body.freshness.execution_ready, false);
assert.equal(okRes.body.live_execution_authorized, false);
assert.equal(primaryCalls, 0, 'read-only market BFF must not hit PRIMARY control-plane');
assert.ok(providerCalls >= 4);

const badRes = makeRes();
await handler({ method: 'GET', url: '/api/market/token?mint=not-a-mint', headers: {} }, badRes);
assert.equal(badRes.statusCode, 400);
assert.equal(badRes.body.error, 'invalid_token_mint');
assert.equal(badRes.body.live_execution_authorized, false);

const missingRes = makeRes();
await handler({ method: 'GET', url: '/api/market/token', headers: {} }, missingRes);
assert.equal(missingRes.statusCode, 400);
assert.equal(missingRes.body.error, 'token_mint_required');

const postRes = makeRes();
await handler({ method: 'POST', url: `/api/market/token?mint=${mint}`, headers: {} }, postRes);
assert.equal(postRes.statusCode, 405);
assert.equal(postRes.body.read_only, true);
assert.equal(postRes.body.live_execution_authorized, false);

const discoveryPostRes = makeRes();
await handler({ method: 'POST', url: '/api/market/discovery?view=trending', headers: {} }, discoveryPostRes);
assert.equal(discoveryPostRes.statusCode, 405);
assert.equal(discoveryPostRes.body.read_only, true);
assert.equal(discoveryPostRes.body.live_execution_authorized, false);
assert.equal(primaryCalls, 0);

console.log('market edge regression: PASS');
