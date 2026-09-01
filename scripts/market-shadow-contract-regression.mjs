import assert from 'node:assert/strict';
import { createMarketIntelligenceService } from '../services/api/src/market-intelligence.mjs';

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

const baseMint = base58(new Uint8Array(32).fill(11));
const quoteMint = base58(new Uint8Array(32).fill(12));
const poolAddress = base58(new Uint8Array(32).fill(13));

function discoveryPayload() {
  return {
    data: [{
      type: 'pool',
      id: `solana_${poolAddress}`,
      attributes: {
        address: poolAddress,
        name: 'QA / SOL',
        base_token_price_usd: '1',
        reserve_in_usd: '1000',
        volume_usd: { h24: '100' },
        price_change_percentage: { h24: '1' },
        transactions: { h24: { buys: 1, sells: 1 } }
      },
      relationships: {
        base_token: { data: { id: `solana_${baseMint}`, type: 'token' } },
        quote_token: { data: { id: `solana_${quoteMint}`, type: 'token' } },
        dex: { data: { id: 'qa-dex', type: 'dex' } }
      }
    }],
    included: [
      { type: 'token', id: `solana_${baseMint}`, attributes: { address: baseMint, name: 'QA', symbol: 'QA' } },
      { type: 'token', id: `solana_${quoteMint}`, attributes: { address: quoteMint, name: 'SOL', symbol: 'SOL' } }
    ]
  };
}

function providerResponse() {
  return {
    ok: true,
    status: 200,
    async json() { return discoveryPayload(); }
  };
}

// Cold-path fail-closed assertion: invalid views must be rejected before any provider access.
let coldCalls = 0;
const coldService = createMarketIntelligenceService({
  fetchImpl: async () => { coldCalls += 1; return providerResponse(); },
  now: () => Date.parse('2026-09-01T13:00:00Z')
});
await assert.rejects(() => coldService.getDiscovery('live'), /invalid_market_discovery_view/);
assert.equal(coldCalls, 0, 'invalid discovery view must fail before provider access on a cold service');

let calls = 0;
const fetchImpl = async () => {
  calls += 1;
  return providerResponse();
};
const service = createMarketIntelligenceService({ fetchImpl, now: () => Date.parse('2026-09-01T13:00:00Z') });
const discovery = await service.getDiscovery('trending');

assert.equal(discovery.mode, 'SHADOW');
assert.equal(discovery.read_only, true);
assert.equal(discovery.live_execution_authorized, false);
assert.equal(discovery.freshness.execution_ready, false);
assert.equal(discovery.items.length, 1);
assert.equal(calls, 1);

// Exercise the public HTTP handler too, not only the underlying service. This catches
// route removal or response rewriting that could otherwise bypass the API contract gate.
const originalFetch = globalThis.fetch;
let handlerProviderCalls = 0;
globalThis.fetch = async () => {
  handlerProviderCalls += 1;
  return providerResponse();
};
const { default: handler } = await import('../api/index.mjs');

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

try {
  const res = responseRecorder();
  await handler({ method: 'GET', url: '/api/market/discovery?view=trending', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.mode, 'SHADOW');
  assert.equal(res.body.read_only, true);
  assert.equal(res.body.live_execution_authorized, false);
  assert.equal(res.body.freshness.execution_ready, false);
  assert.equal(handlerProviderCalls, 1);

  const callsBeforeInvalid = handlerProviderCalls;
  const invalidRes = responseRecorder();
  await handler({ method: 'GET', url: '/api/market/discovery?view=live', headers: {} }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(invalidRes.body.error, 'invalid_market_discovery_view');
  assert.equal(invalidRes.body.read_only, true);
  assert.equal(invalidRes.body.live_execution_authorized, false);
  assert.equal(handlerProviderCalls, callsBeforeInvalid, 'invalid API view must fail before provider access');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('market SHADOW contract regression: PASS');
