import assert from 'node:assert/strict';
import { createOrcaRaydiumArbitrageScanner } from '../services/api/src/orca-raydium-arbitrage-scanner.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const observedAt = '2026-09-05T08:00:00.000Z';
const nowMs = Date.parse(observedAt) + 1000;
let calls = 0;

const pool = overrides => ({
  dex_id: 'orca', pool_address: 'orca-pool', token_mint: token, quote_mint: quote,
  price_usd: 1, fee_bps: 5, price_impact_bps: 5, liquidity_usd: 5_000_000,
  quote_source: 'READ_ONLY_REAL_MARKET_TEST', quote_verified: true, costs_verified: true,
  observed_at: observedAt, ...overrides
});

const scanner = createOrcaRaydiumArbitrageScanner({
  now: () => nowMs,
  cacheTtlMs: 5000,
  maxMarketAgeMs: 5000,
  loadPools: async request => {
    calls += 1;
    assert.deepEqual(request.dexes, ['orca', 'raydium']);
    assert.equal(request.token_mint, token);
    assert.equal(request.quote_mint, quote);
    return [
      pool({ dex_id: 'orca', pool_address: 'orca-pool', price_usd: 1 }),
      pool({ dex_id: 'raydium', pool_address: 'raydium-pool', price_usd: 1.01 })
    ];
  }
});

const first = await scanner.scanPair({ token_mint: token, quote_mint: quote });
assert.equal(first.source, 'ORCA_RAYDIUM_REAL_MARKET');
assert.equal(first.read_only, true);
assert.equal(first.live_execution_authorized, false);
assert.equal(first.pools.length, 2);
assert.equal(first.opportunities.length, 2);
assert.equal(first.opportunities[0].direction, 'ORCA_TO_RAYDIUM');
assert.ok(first.opportunities[0].gross_edge_bps > 0);
assert.equal(first.opportunities[1].direction, 'RAYDIUM_TO_ORCA');
assert.ok(first.opportunities[1].gross_edge_bps < 0);
assert.ok(first.opportunities.every(item => item.strategy === 'TWO_LEG_ARBITRAGE'));

await scanner.scanPair({ token_mint: token, quote_mint: quote });
assert.equal(calls, 1, 'fresh scan should use cache');

async function expectFail(rows, pattern, maxMarketAgeMs = 5000) {
  const candidate = createOrcaRaydiumArbitrageScanner({
    now: () => nowMs,
    maxMarketAgeMs,
    loadPools: async () => rows
  });
  await assert.rejects(candidate.scanPair({ token_mint: token, quote_mint: quote }), pattern);
}

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'meteora', pool_address: 'other-pool' })
], /scanner_dex_not_allowed/);

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', fee_bps: undefined })
], /scanner_fee_bps_required/);

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', price_impact_bps: undefined })
], /scanner_price_impact_bps_required/);

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', quote_verified: false })
], /scanner_quote_unverified/);

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', costs_verified: false })
], /scanner_costs_unverified/);

await expectFail([
  pool({ dex_id: 'orca', observed_at: '2026-09-05T07:59:50.000Z' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', observed_at: '2026-09-05T07:59:50.000Z' })
], /scanner_stale_quote_rejected/);

await expectFail([
  pool({ dex_id: 'orca' })
], /scanner_both_dexes_required/);

await expectFail([
  pool({ dex_id: 'orca' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', token_mint: 'OTHER_TOKEN' })
], /scanner_pair_mismatch/);

console.log('orca-raydium arbitrage scanner regression: ok');
