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
let calls = 0;

const fetchImpl = async () => {
  calls += 1;
  return {
    ok: true,
    status: 200,
    async json() {
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
  };
};

const service = createMarketIntelligenceService({ fetchImpl, now: () => Date.parse('2026-09-01T13:00:00Z') });
const discovery = await service.getDiscovery('trending');

assert.equal(discovery.mode, 'SHADOW');
assert.equal(discovery.read_only, true);
assert.equal(discovery.live_execution_authorized, false);
assert.equal(discovery.freshness.execution_ready, false);
assert.equal(discovery.items.length, 1);
assert.equal(calls, 1);

await assert.rejects(() => service.getDiscovery('live'), /invalid_market_discovery_view/);
assert.equal(calls, 1, 'invalid discovery view must fail before provider access');

console.log('market SHADOW contract regression: PASS');
