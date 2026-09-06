import assert from 'node:assert/strict';
import { createOrcaRaydiumSellSimulationBoundary, ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY } from '../services/api/src/orca-raydium-sell-simulation-boundary.mjs';

const opportunity = Object.freeze({
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  sell_route: Object.freeze({
    dex_id: 'raydium',
    pool_address: 'POOL',
    quote_source: 'RAYDIUM_ONCHAIN_RPC_CLMM_SLOT_1',
    quote_verified: true,
    costs_verified: true
  })
});

const context = Object.freeze({
  token_mint: 'TOKEN', quote_mint: 'USDC', opportunity, notional_usdc: 25,
  read_only: true, strategy: 'TWO_LEG_ARBITRAGE', live_execution_authorized: false
});

const build = async ({ expected_sell_identity }) => Object.freeze({
  verified: true,
  read_only: true,
  unsigned: true,
  simulation_only: true,
  token_mint: expected_sell_identity.token_mint,
  quote_mint: expected_sell_identity.quote_mint,
  sell_dex: expected_sell_identity.sell_dex,
  sell_pool: expected_sell_identity.sell_pool,
  notional_usdc: expected_sell_identity.notional_usdc,
  sell_quote_source: expected_sell_identity.sell_quote_source,
  transaction_base64: 'AA==',
  source_slot: 1,
  source_reference: 'UNSIGNED_SELL:1',
  transaction_signed: false,
  signer_requested: false,
  private_key_present: false,
  signature_present: false,
  execution_transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

let submitted = false;
const simulate = async request => {
  assert.equal(request.sig_verify, false);
  assert.equal(request.simulation_only, true);
  assert.equal(request.network_submission_authorized, false);
  submitted = true;
  return Object.freeze({
    verified: true,
    simulation_ok: true,
    transaction_signed: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    source_reference: 'SOLANA_RPC:simulateTransaction:1'
  });
};

const loader = createOrcaRaydiumSellSimulationBoundary({ buildUnsignedSellSimulation: build, simulateUnsignedTransaction: simulate, now: () => 1_700_000_000_000 });
const result = await loader(context);
assert.equal(submitted, true);
assert.equal(result.verified, true);
assert.equal(result.sell_simulation_ok, true);
assert.equal(result.sell_dex, 'raydium');
assert.equal(result.sell_pool, 'POOL');
assert.equal(result.notional_usdc, 25);
assert.equal(result.execution_transaction_building_authorized, false);
assert.equal(result.transaction_signing_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.funds_moved, false);
assert.equal(result.live_execution_authorized, false);

const mismatchLoader = createOrcaRaydiumSellSimulationBoundary({
  buildUnsignedSellSimulation: async input => ({ ...(await build(input)), sell_pool: 'WRONG_POOL' }),
  simulateUnsignedTransaction: simulate
});
await assert.rejects(() => mismatchLoader(context), /sell_simulation_pool_mismatch/);

const signedLoader = createOrcaRaydiumSellSimulationBoundary({
  buildUnsignedSellSimulation: async input => ({ ...(await build(input)), transaction_signed: true }),
  simulateUnsignedTransaction: simulate
});
await assert.rejects(() => signedLoader(context), /sell_simulation_signing_boundary_violation/);

const liveLoader = createOrcaRaydiumSellSimulationBoundary({ buildUnsignedSellSimulation: build, simulateUnsignedTransaction: simulate });
await assert.rejects(() => liveLoader({ ...context, live_execution_authorized: true }), /sell_simulation_live_boundary_violation/);

const failedSimulationLoader = createOrcaRaydiumSellSimulationBoundary({
  buildUnsignedSellSimulation: build,
  simulateUnsignedTransaction: async () => ({ verified: true, simulation_ok: false, transaction_signed: false, network_submission_authorized: false, live_execution_authorized: false, source_reference: 'FAIL' })
});
await assert.rejects(() => failedSimulationLoader(context), /sell_simulation_failed/);

assert.equal(ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY.simulation_only_unsigned_construction_authorized, true);
assert.equal(ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY.execution_transaction_building_authorized, false);
assert.equal(ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY.transaction_signing_authorized, false);
assert.equal(ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY.network_submission_authorized, false);
assert.equal(ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY.live_execution_authorized, false);

console.log('ORCA Raydium sell simulation boundary regression: PASS');
