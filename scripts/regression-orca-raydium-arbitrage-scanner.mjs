import assert from 'node:assert/strict';
import { createOrcaRaydiumArbitrageScanner } from '../services/api/src/orca-raydium-arbitrage-scanner.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const observedAt = '2026-09-05T08:00:00.000Z';
const nowMs = Date.parse(observedAt) + 1000;
const observedSlot = 12345;
let calls = 0;

const instructionContext = (slot = observedSlot, overrides = {}) => ({
  verified: true,
  source_slot: slot,
  observed_at: observedAt,
  read_only: true,
  private_key_present: false,
  signature_present: false,
  live_execution_authorized: false,
  ...overrides
});

const pool = overrides => {
  const slot = overrides?.observed_slot ?? observedSlot;
  return {
    dex_id: 'orca', pool_address: 'orca-pool', token_mint: token, quote_mint: quote,
    buy_price_usd: 1.001, sell_price_usd: 0.999,
    buy_fee_bps: 5, sell_fee_bps: 5,
    buy_price_impact_bps: 5, sell_price_impact_bps: 5,
    liquidity_usd: 5_000_000,
    quote_source: 'READ_ONLY_REAL_MARKET_TEST', quote_verified: true, costs_verified: true,
    observed_at: observedAt, observed_slot: slot,
    instruction_context: instructionContext(slot),
    ...overrides
  };
};

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
      pool({ dex_id: 'orca', pool_address: 'orca-pool', buy_price_usd: 1.001, sell_price_usd: 0.999 }),
      pool({ dex_id: 'raydium', pool_address: 'raydium-pool', buy_price_usd: 1.011, sell_price_usd: 1.009 })
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
assert.equal(first.opportunities[0].read_only, true);
assert.equal(first.opportunities[0].buy_route.side, 'BUY');
assert.equal(first.opportunities[0].buy_route.price_usd, 1.001);
assert.equal(first.opportunities[0].buy_route.fee_bps, 5);
assert.equal(first.opportunities[0].buy_route.price_impact_bps, 5);
assert.equal(first.opportunities[0].buy_route.observed_slot, observedSlot);
assert.equal(first.opportunities[0].buy_route.instruction_context.verified, true);
assert.equal(first.opportunities[0].sell_route.side, 'SELL');
assert.equal(first.opportunities[0].sell_route.price_usd, 1.009);
assert.equal(first.opportunities[0].sell_route.fee_bps, 5);
assert.equal(first.opportunities[0].sell_route.price_impact_bps, 5);
assert.equal(first.opportunities[0].sell_route.instruction_context.source_slot, observedSlot);
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

await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'meteora', pool_address: 'other-pool' })], /scanner_dex_not_allowed/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', buy_fee_bps: undefined })], /scanner_buy_fee_bps_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', sell_price_impact_bps: undefined })], /scanner_sell_price_impact_bps_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', buy_price_usd: undefined })], /scanner_buy_price_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', quote_verified: false })], /scanner_quote_unverified/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', costs_verified: false })], /scanner_costs_unverified/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', observed_slot: undefined })], /scanner_observed_slot_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', instruction_context: null })], /scanner_instruction_context_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', instruction_context: instructionContext(999) })], /scanner_instruction_context_slot_mismatch/);
await expectFail([
  pool({ dex_id: 'orca', observed_at: '2026-09-05T07:59:50.000Z' }),
  pool({ dex_id: 'raydium', pool_address: 'ray-pool', observed_at: '2026-09-05T07:59:50.000Z' })
], /scanner_stale_quote_rejected/);
await expectFail([pool({ dex_id: 'orca' })], /scanner_both_dexes_required/);
await expectFail([pool({ dex_id: 'orca' }), pool({ dex_id: 'raydium', pool_address: 'ray-pool', token_mint: 'OTHER_TOKEN' })], /scanner_pair_mismatch/);

const olderObservedAt = '2026-09-05T07:59:58.500Z';
const timestampScanner = createOrcaRaydiumArbitrageScanner({
  now: () => nowMs,
  loadPools: async () => [
    pool({ dex_id: 'orca', pool_address: 'orca-older', observed_at: olderObservedAt }),
    pool({ dex_id: 'raydium', pool_address: 'ray-newer', observed_at: observedAt, buy_price_usd: 1.011, sell_price_usd: 1.009 })
  ]
});
const timestampResult = await timestampScanner.scanPair({ token_mint: token, quote_mint: quote });
assert.equal(timestampResult.opportunities[0].observed_at, olderObservedAt, 'opportunity freshness must use the older required leg');
assert.equal(timestampResult.opportunities[1].observed_at, olderObservedAt, 'reverse opportunity freshness must use the older required leg');

let cacheNow = Date.parse(observedAt) + 4900;
let cacheCalls = 0;
const cacheScanner = createOrcaRaydiumArbitrageScanner({
  now: () => cacheNow,
  cacheTtlMs: 5000,
  maxMarketAgeMs: 5000,
  loadPools: async () => {
    cacheCalls += 1;
    const refreshedObservedAt = cacheCalls === 1 ? observedAt : new Date(cacheNow).toISOString();
    return [
      pool({ dex_id: 'orca', pool_address: 'orca-cache', observed_at: refreshedObservedAt }),
      pool({ dex_id: 'raydium', pool_address: 'ray-cache', observed_at: refreshedObservedAt, buy_price_usd: 1.011, sell_price_usd: 1.009 })
    ];
  }
});
await cacheScanner.scanPair({ token_mint: token, quote_mint: quote });
assert.equal(cacheCalls, 1);
cacheNow += 200;
await cacheScanner.scanPair({ token_mint: token, quote_mint: quote });
assert.equal(cacheCalls, 2, 'cache must expire at the oldest quote freshness deadline, not only cache TTL');

console.log('orca-raydium arbitrage scanner regression: ok');
