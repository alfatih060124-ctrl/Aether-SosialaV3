import assert from 'node:assert/strict';
import { createOrcaRaydiumReadOnlyPoolLoader } from '../services/api/src/orca-raydium-readonly-provider-adapter.mjs';

const token = 'TOKEN_MINT_TEST';
const quote = 'USDC_MINT_TEST';
const observedAt = '2026-09-05T08:30:00.000Z';
const observedSlot = 777;
const instructionContext = overrides => ({
  verified: true,
  source_slot: observedSlot,
  observed_at: observedAt,
  read_only: true,
  private_key_present: false,
  signature_present: false,
  live_execution_authorized: false,
  ...overrides
});
const row = overrides => ({
  pool_address: 'pool-a', token_mint: token, quote_mint: quote,
  buy_price_usd: 1.001, sell_price_usd: 0.999,
  buy_fee_bps: 5, sell_fee_bps: 5,
  buy_price_impact_bps: 4, sell_price_impact_bps: 4,
  liquidity_usd: 1_000_000,
  quote_source: 'READ_ONLY_PROVIDER_TEST', quote_verified: true, costs_verified: true,
  observed_at: observedAt, observed_slot: observedSlot,
  instruction_context: instructionContext(), ...overrides
});

let orcaRequests = 0;
let raydiumRequests = 0;
const loadPools = createOrcaRaydiumReadOnlyPoolLoader({
  loadOrcaQuotes: async request => {
    orcaRequests += 1;
    assert.equal(request.read_only, true);
    assert.equal(request.strategy, 'TWO_LEG_ARBITRAGE');
    return [row({ dex_id: 'orca', pool_address: 'orca-pool' })];
  },
  loadRaydiumQuotes: async request => {
    raydiumRequests += 1;
    assert.equal(request.token_mint, token);
    assert.equal(request.quote_mint, quote);
    return [row({ dex_id: 'raydium', pool_address: 'raydium-pool', buy_price_usd: 1.011, sell_price_usd: 1.009 })];
  }
});

const rows = await loadPools({ token_mint: token, quote_mint: quote, dexes: ['orca', 'raydium'] });
assert.equal(rows.length, 2);
assert.equal(rows[0].dex_id, 'orca');
assert.equal(rows[1].dex_id, 'raydium');
assert.equal(rows[0].buy_price_usd, 1.001);
assert.equal(rows[1].sell_price_usd, 1.009);
assert.equal(rows[0].observed_slot, observedSlot);
assert.equal(rows[1].instruction_context.verified, true);
assert.equal(rows[1].instruction_context.source_slot, observedSlot);
assert.equal(orcaRequests, 1);
assert.equal(raydiumRequests, 1);
assert.ok(rows.every(item => item.quote_verified && item.costs_verified));

async function expectFailure({ orca = [row({ dex_id: 'orca' })], raydium = [row({ dex_id: 'raydium', pool_address: 'ray-pool' })], pattern }) {
  const candidate = createOrcaRaydiumReadOnlyPoolLoader({
    loadOrcaQuotes: async () => orca,
    loadRaydiumQuotes: async () => raydium
  });
  await assert.rejects(candidate({ token_mint: token, quote_mint: quote, dexes: ['orca', 'raydium'] }), pattern);
}

await expectFailure({ orca: [row({ dex_id: 'orca', buy_fee_bps: undefined })], pattern: /orca_buy_fee_bps_required/ });
await expectFailure({ raydium: [row({ dex_id: 'raydium', pool_address: 'ray-pool', sell_price_impact_bps: undefined })], pattern: /raydium_sell_price_impact_bps_required/ });
await expectFailure({ orca: [row({ dex_id: 'orca', buy_price_usd: undefined })], pattern: /orca_buy_price_required/ });
await expectFailure({ orca: [row({ dex_id: 'orca', quote_verified: false })], pattern: /orca_quote_unverified/ });
await expectFailure({ raydium: [row({ dex_id: 'raydium', pool_address: 'ray-pool', costs_verified: false })], pattern: /raydium_costs_unverified/ });
await expectFailure({ orca: [row({ dex_id: 'orca', observed_slot: undefined })], pattern: /orca_observed_slot_required/ });
await expectFailure({ orca: [row({ dex_id: 'orca', instruction_context: null })], pattern: /orca_instruction_context_required/ });
await expectFailure({ raydium: [row({ dex_id: 'raydium', pool_address: 'ray-pool', instruction_context: instructionContext({ source_slot: 999 }) })], pattern: /raydium_instruction_context_slot_mismatch/ });
await expectFailure({ orca: [row({ dex_id: 'orca', instruction_context: instructionContext({ live_execution_authorized: true }) })], pattern: /orca_instruction_context_boundary_invalid/ });
await expectFailure({ orca: [], pattern: /orca_provider_no_verified_quotes/ });
await expectFailure({ raydium: [], pattern: /raydium_provider_no_verified_quotes/ });
await expectFailure({ orca: [row({ dex_id: 'raydium' })], pattern: /orca_provider_dex_mismatch/ });
await expectFailure({ raydium: [row({ dex_id: 'raydium', pool_address: 'ray-pool', token_mint: 'OTHER' })], pattern: /raydium_provider_pair_mismatch/ });

await assert.rejects(loadPools({ token_mint: token, quote_mint: quote, dexes: ['orca', 'meteora'] }), /provider_orca_raydium_scope_required/);

console.log('orca-raydium readonly provider adapter regression: ok');
