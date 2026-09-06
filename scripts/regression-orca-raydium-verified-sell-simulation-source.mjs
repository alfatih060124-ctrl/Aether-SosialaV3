import assert from 'node:assert/strict';
import {
  createOrcaRaydiumVerifiedSellSimulationSource,
  ORCA_RAYDIUM_VERIFIED_SELL_SIMULATION_SOURCE
} from '../services/api/src/orca-raydium-verified-sell-simulation-source.mjs';
import {
  createOrcaRaydiumVerifiedRiskQualificationRuntime
} from '../services/api/src/orca-raydium-verified-risk-qualification-runtime.mjs';

const observedAt = '2026-09-06T12:45:00.000Z';
const now = () => Date.parse('2026-09-06T12:45:05.000Z');
const scannerRuntime = {
  async scanPair({ token_mint, quote_mint }) {
    return {
      token_mint,
      quote_mint,
      read_only: true,
      live_execution_authorized: false,
      opportunities: [{
        token_mint,
        quote_mint,
        sell_route: {
          side: 'SELL',
          dex_id: 'raydium',
          pool_address: 'POOL_R',
          token_mint,
          quote_mint,
          price_usd: 1.02,
          fee_bps: 25,
          price_impact_bps: 7,
          quote_source: 'RAYDIUM_ONCHAIN_RPC_SLOT_42',
          quote_verified: true,
          costs_verified: true,
          observed_at: observedAt
        }
      }]
    };
  }
};

const opportunity = {
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  sell_route: {
    side: 'SELL',
    dex_id: 'raydium',
    pool_address: 'POOL_R',
    token_mint: 'TOKEN',
    quote_mint: 'USDC',
    quote_verified: true,
    costs_verified: true
  }
};

const load = createOrcaRaydiumVerifiedSellSimulationSource({ scannerRuntime, now, maxAgeMs: 15_000 });
const evidence = await load({ opportunity });
assert.equal(evidence.verified, true);
assert.equal(evidence.sell_simulation_ok, true);
assert.equal(evidence.dex_id, 'raydium');
assert.equal(evidence.pool_address, 'POOL_R');
assert.equal(evidence.sell_price_usd, 1.02);
assert.equal(evidence.read_only, true);
assert.equal(evidence.transaction_building_authorized, false);
assert.equal(evidence.network_submission_authorized, false);
assert.equal(evidence.live_execution_authorized, false);
assert.match(evidence.source_reference, /RAYDIUM_ONCHAIN_RPC_SLOT_42/);

await assert.rejects(
  createOrcaRaydiumVerifiedSellSimulationSource({ scannerRuntime, now: () => Date.parse('2026-09-06T12:46:00.000Z'), maxAgeMs: 15_000 })({ opportunity }),
  /sell_simulation_observed_at_stale/
);

assert.equal(ORCA_RAYDIUM_VERIFIED_SELL_SIMULATION_SOURCE.exact_route_requote_required, true);
assert.equal(ORCA_RAYDIUM_VERIFIED_SELL_SIMULATION_SOURCE.transaction_signing_authorized, false);

const runtime = createOrcaRaydiumVerifiedRiskQualificationRuntime({
  scannerRuntime,
  loadNetworkFeeEvidence: async () => ({ network_fee_usdc: 0, network_fee_verified: true }),
  rpcUrl: 'https://rpc.invalid',
  notionalUsdc: 100,
  now
});
assert.equal(runtime.verified_sell_simulation_source_defaulted, true);
assert.equal(runtime.live_execution_authorized, false);

console.log('ORCA Raydium verified sell simulation source regression: PASS');
