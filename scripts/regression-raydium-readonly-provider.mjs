import assert from 'node:assert/strict';
import { createRaydiumReadOnlyQuoteLoader, RAYDIUM_READONLY_PROVIDER } from '../services/api/src/raydium-readonly-provider.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const observedAt = '2026-09-05T14:00:00.000Z';
let discoveryCalls = 0;
let quoteCalls = 0;

const fetchImpl = async url => {
  discoveryCalls += 1;
  const value = String(url);
  assert.match(value, /\/pools\/info\/mint\?/);
  assert.match(value, /mint1=TOKEN_MINT_TEST/);
  assert.match(value, /mint2=USDC_MINT_TEST/);
  assert.match(value, /poolType=all/);
  assert.match(value, /poolSortField=liquidity/);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        success: true,
        data: {
          count: 2,
          data: [
            { id: 'raydium-pool-good', type: 'Concentrated', mintA: { address: token }, mintB: { address: quote }, tvl: '900000' },
            { id: 'raydium-pool-other', mintA: { address: token }, mintB: { address: 'OTHER' } }
          ]
        }
      };
    }
  };
};

const verifiedQuote = overrides => ({
  buy_price_usd: 1.004,
  sell_price_usd: 1.002,
  buy_fee_bps: 25,
  sell_fee_bps: 25,
  buy_price_impact_bps: 5,
  sell_price_impact_bps: 5,
  liquidity_usd: 900_000,
  quote_source: 'RAYDIUM_ONCHAIN_RPC',
  quote_verified: true,
  costs_verified: true,
  observed_at: observedAt,
  ...overrides
});

const loader = createRaydiumReadOnlyQuoteLoader({
  fetchImpl,
  quoteNotionalUsdc: 50,
  quotePool: async request => {
    quoteCalls += 1;
    assert.equal(request.pool_address, 'raydium-pool-good');
    assert.equal(request.token_mint, token);
    assert.equal(request.quote_mint, quote);
    assert.equal(request.notional_usdc, 50);
    assert.equal(request.read_only, true);
    assert.equal(request.strategy, 'TWO_LEG_ARBITRAGE');
    assert.equal(request.source_hint, 'RAYDIUM_ONCHAIN_RPC');
    return verifiedQuote();
  }
});

const rows = await loader({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' });
assert.equal(discoveryCalls, 1);
assert.equal(quoteCalls, 1);
assert.equal(rows.length, 1);
assert.equal(rows[0].dex_id, 'raydium');
assert.equal(rows[0].pool_address, 'raydium-pool-good');
assert.equal(rows[0].buy_price_usd, 1.004);
assert.equal(rows[0].sell_price_usd, 1.002);
assert.equal(rows[0].buy_fee_bps, 25);
assert.equal(rows[0].quote_verified, true);
assert.equal(rows[0].costs_verified, true);
assert.equal(RAYDIUM_READONLY_PROVIDER.live_execution_authorized, false);

await assert.rejects(
  async () => createRaydiumReadOnlyQuoteLoader({ fetchImpl, quotePool: async () => ({}), quoteNotionalUsdc: 0 }),
  /raydium_quote_notional_usdc_required/
);
await assert.rejects(loader({ token_mint: token, quote_mint: quote, read_only: false, strategy: 'TWO_LEG_ARBITRAGE' }), /raydium_read_only_required/);
await assert.rejects(loader({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'DIRECTIONAL' }), /raydium_strategy_invalid/);

const noPair = createRaydiumReadOnlyQuoteLoader({
  quoteNotionalUsdc: 50,
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { data: [{ id: 'x', mintA: { address: token }, mintB: { address: 'OTHER' } }] } })
  }),
  quotePool: async () => ({})
});
await assert.rejects(noPair({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), /raydium_no_exact_pair_pools/);

const unsuccessful = createRaydiumReadOnlyQuoteLoader({
  quoteNotionalUsdc: 50,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, msg: 'failed' }) }),
  quotePool: async () => ({})
});
await assert.rejects(unsuccessful({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), /raydium_discovery_unsuccessful/);

function onePoolFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { data: [{ id: 'p', mintA: { address: token }, mintB: { address: quote } }] } })
  });
}

async function expectQuoteFailure(quoteResult, pattern) {
  const candidate = createRaydiumReadOnlyQuoteLoader({
    quoteNotionalUsdc: 50,
    fetchImpl: onePoolFetch(),
    quotePool: async () => quoteResult
  });
  await assert.rejects(candidate({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), pattern);
}

await expectQuoteFailure(verifiedQuote({ quote_verified: false }), /raydium_onchain_quote_unverified/);
await expectQuoteFailure(verifiedQuote({ costs_verified: false }), /raydium_onchain_costs_unverified/);
await expectQuoteFailure(verifiedQuote({ buy_fee_bps: null }), /raydium_onchain_buy_fee_bps_required/);
await expectQuoteFailure(verifiedQuote({ sell_fee_bps: '' }), /raydium_onchain_sell_fee_bps_required/);
await expectQuoteFailure(verifiedQuote({ buy_price_impact_bps: null }), /raydium_onchain_buy_price_impact_bps_required/);
await expectQuoteFailure(verifiedQuote({ sell_price_impact_bps: '   ' }), /raydium_onchain_sell_price_impact_bps_required/);
await expectQuoteFailure(verifiedQuote({ buy_price_usd: null }), /raydium_onchain_buy_price_required/);
await expectQuoteFailure(verifiedQuote({ sell_price_usd: '' }), /raydium_onchain_sell_price_required/);
await expectQuoteFailure(verifiedQuote({ quote_source: 'OTHER_RPC' }), /raydium_onchain_quote_source_invalid/);

console.log('raydium readonly provider regression: ok');
