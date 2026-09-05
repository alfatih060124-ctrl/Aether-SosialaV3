import assert from 'node:assert/strict';
import { createOrcaWhirlpoolReadOnlyQuoteLoader } from '../services/api/src/orca-whirlpool-readonly-provider.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const observedAt = '2026-09-05T09:00:00.000Z';
let discoveryCalls = 0;
let quoteCalls = 0;

const fetchImpl = async url => {
  discoveryCalls += 1;
  assert.match(String(url), /tokensBothOf=TOKEN_MINT_TEST%2CUSDC_MINT_TEST/);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        data: [
          { address: 'orca-pool-good', tokenMintA: token, tokenMintB: quote, tvlUsdc: '1000000' },
          { address: 'orca-pool-other', tokenMintA: token, tokenMintB: 'OTHER' }
        ]
      };
    }
  };
};

const loader = createOrcaWhirlpoolReadOnlyQuoteLoader({
  fetchImpl,
  quoteNotionalUsdc: 50,
  quotePool: async request => {
    quoteCalls += 1;
    assert.equal(request.pool_address, 'orca-pool-good');
    assert.equal(request.notional_usdc, 50);
    assert.equal(request.read_only, true);
    assert.equal(request.strategy, 'TWO_LEG_ARBITRAGE');
    return {
      price_usd: 1.01,
      fee_bps: 20,
      price_impact_bps: 4,
      liquidity_usd: 1_000_000,
      quote_source: 'ORCA_WHIRLPOOLS_ONCHAIN_RPC',
      quote_verified: true,
      costs_verified: true,
      observed_at: observedAt
    };
  }
});

const rows = await loader({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' });
assert.equal(discoveryCalls, 1);
assert.equal(quoteCalls, 1);
assert.equal(rows.length, 1);
assert.equal(rows[0].dex_id, 'orca');
assert.equal(rows[0].pool_address, 'orca-pool-good');
assert.equal(rows[0].fee_bps, 20);
assert.equal(rows[0].quote_verified, true);
assert.equal(rows[0].costs_verified, true);

await assert.rejects(async () => createOrcaWhirlpoolReadOnlyQuoteLoader({ fetchImpl, quotePool: async () => ({}), quoteNotionalUsdc: 0 }), /orca_quote_notional_usdc_required/);
await assert.rejects(loader({ token_mint: token, quote_mint: quote, read_only: false, strategy: 'TWO_LEG_ARBITRAGE' }), /orca_read_only_required/);
await assert.rejects(loader({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'DIRECTIONAL' }), /orca_strategy_invalid/);

const noPair = createOrcaWhirlpoolReadOnlyQuoteLoader({
  quoteNotionalUsdc: 50,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ address: 'x', tokenMintA: token, tokenMintB: 'OTHER' }] }) }),
  quotePool: async () => ({})
});
await assert.rejects(noPair({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), /orca_no_exact_pair_pools/);

const unverified = createOrcaWhirlpoolReadOnlyQuoteLoader({
  quoteNotionalUsdc: 50,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ address: 'p', tokenMintA: token, tokenMintB: quote }] }) }),
  quotePool: async () => ({ price_usd: 1, fee_bps: 20, price_impact_bps: 2, quote_source: 'ORCA_RPC', quote_verified: false, costs_verified: true, observed_at: observedAt })
});
await assert.rejects(unverified({ token_mint: token, quote_mint: quote, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }), /orca_onchain_quote_unverified/);

console.log('orca whirlpool readonly provider regression: ok');
