import assert from 'node:assert/strict';
import { createOrcaRaydiumShadowQualifiedPretradeRuntime } from '../services/api/src/orca-raydium-shadow-qualified-pretrade-runtime.mjs';

const NOW = Date.parse('2026-09-05T17:20:00.000Z');

const scannerRuntime = Object.freeze({
  async scanPair() {
    return Object.freeze({
      source: 'TEST_SCANNER',
      opportunities: Object.freeze([Object.freeze({
        strategy: 'TWO_LEG_ARBITRAGE',
        buy_dex: 'ORCA',
        sell_dex: 'RAYDIUM',
        token_mint: 'Token111',
        quote_mint: 'USDC111',
        buy_price_usdc: 1,
        sell_price_usdc: 1.01,
        buy_fee_bps: 0,
        sell_fee_bps: 0,
        buy_price_impact_bps: 0,
        sell_price_impact_bps: 0,
        quote_verified: true,
        costs_verified: true,
        observed_at: '2026-09-05T17:19:58.000Z'
      })])
    });
  }
});

let feeContext = null;
const pretradeFeePipeline = Object.freeze({
  async estimate(context) {
    feeContext = context;
    return Object.freeze({
      verified: true,
      network_fee_verified: true,
      network_fee_usdc: 0.001,
      source: 'SOLANA_PRETRADE_RPC_FEE_ESTIMATE',
      source_reference: 'compiled|fee|simulation|priority|solusd',
      observed_at: '2026-09-05T17:19:59.000Z',
      read_only: true,
      live_execution_authorized: false
    });
  }
});

const loadRiskSource = async () => Object.freeze({
  verified: true,
  source: 'TEST_RISK',
  source_reference: 'risk:1',
  observed_at: '2026-09-05T17:19:59.000Z',
  data: Object.freeze({
    liquidity_usd: 1_000_000,
    spread_bps: 1,
    price_impact_bps: 1,
    top10_holder_pct: 10,
    mint_authority: false,
    freeze_authority: false,
    transferable: true,
    sell_simulation_ok: true
  })
});

const runtime = createOrcaRaydiumShadowQualifiedPretradeRuntime({
  scannerRuntime,
  pretradeFeePipeline,
  loadRiskSource,
  notionalUsdc: 100,
  performanceFeeBps: 1000,
  now: () => NOW
});

const demoAccount = { cash_usdc: 1000 };
const result = await runtime.scanAndQualifyPair({ token_mint: 'Token111', quote_mint: 'USDC111', demo_account: demoAccount });
assert.equal(feeContext.read_only, true);
assert.equal(feeContext.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(feeContext.live_execution_authorized, false);
assert.equal(result.mode, 'SHADOW');
assert.equal(result.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(result.results.length, 1);
assert.equal(result.results[0].opportunity.network_fee_verified, true);
assert.equal(result.results[0].opportunity.network_fee_usdc, 0.001);
assert.equal(result.results[0].execution_dispatched, false);
assert.equal(result.results[0].transaction_created, false);
assert.equal(result.results[0].signer_requested, false);
assert.equal(result.results[0].funds_moved, false);
assert.equal(result.results[0].network_submission_authorized, false);
assert.equal(result.results[0].live_execution_authorized, false);

await assert.rejects(
  () => runtime.scanAndQualifyPair({ token_mint: 'Token111', quote_mint: 'USDC111', demo_account: demoAccount, live_execution_authorized: true }),
  /shadow_pretrade_live_boundary_violation/
);

console.log('orca raydium shadow qualified pretrade runtime regression ok');
