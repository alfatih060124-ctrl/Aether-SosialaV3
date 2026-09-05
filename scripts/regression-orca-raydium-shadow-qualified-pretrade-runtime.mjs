import assert from 'node:assert/strict';
import { createOrcaRaydiumShadowQualifiedPretradeRuntime } from '../services/api/src/orca-raydium-shadow-qualified-pretrade-runtime.mjs';

const observedAt = '2026-09-05T17:20:00.000Z';
const NOW = Date.parse(observedAt);

const opportunity = Object.freeze({
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  observed_at: observedAt,
  market_source: 'ORCA_RAYDIUM_REAL_MARKET',
  buy_route: Object.freeze({
    dex_id: 'orca', pool_address: 'orca-pool', price_usd: 1,
    fee_bps: 1, price_impact_bps: 1, liquidity_usd: 5_000_000,
    quote_source: 'ORCA_TEST', quote_verified: true, costs_verified: true
  }),
  sell_route: Object.freeze({
    dex_id: 'raydium', pool_address: 'ray-pool', price_usd: 1.01,
    fee_bps: 1, price_impact_bps: 1, liquidity_usd: 5_000_000,
    quote_source: 'RAYDIUM_TEST', quote_verified: true, costs_verified: true
  })
});

const scannerRuntime = Object.freeze({
  async scanPair() {
    return Object.freeze({ source: 'ORCA_RAYDIUM_REAL_MARKET', opportunities: Object.freeze([opportunity]) });
  }
});

let feeContext = null;
const pretradeFeePipeline = Object.freeze({
  async estimate(context) {
    feeContext = context;
    return Object.freeze({
      verified: true,
      network_fee_verified: true,
      network_fee_usdc: 0.01,
      source: 'SOLANA_PRETRADE_RPC_FEE_ESTIMATE',
      source_reference: 'compiled|fee|simulation|priority|solusd',
      observed_at: observedAt,
      read_only: true,
      live_execution_authorized: false
    });
  }
});

const riskData = Object.freeze({
  volume_24h_usd: 3_000_000,
  spread_bps: 8,
  top10_holder_pct: 12,
  token_age_hours: 240,
  route_count: 2,
  source_count: 2,
  volatility_1h_bps: 250,
  momentum_5m_bps: 300,
  momentum_1h_bps: 700,
  buy_sell_imbalance: 0.35,
  sell_simulation_ok: true,
  transferable: true,
  risk_flags: Object.freeze([])
});

const loadRiskSource = async () => Object.freeze({
  verified: true,
  source: 'TEST_RISK',
  source_reference: 'risk:1',
  observed_at: observedAt,
  data: riskData
});

const runtime = createOrcaRaydiumShadowQualifiedPretradeRuntime({
  scannerRuntime,
  pretradeFeePipeline,
  loadRiskSource,
  notionalUsdc: 1000,
  performanceFeeBps: 1000,
  now: () => NOW
});

const demoAccount = { cash_balance_usdc: 2000, open_position: {} };
const result = await runtime.scanAndQualifyPair({ token_mint: 'TOKEN', quote_mint: 'USDC', demo_account: demoAccount });
assert.equal(feeContext.read_only, true);
assert.equal(feeContext.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(feeContext.live_execution_authorized, false);
assert.equal(result.mode, 'SHADOW');
assert.equal(result.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(result.qualified_count, 1);
assert.equal(result.results.length, 1);
assert.equal(result.results[0].opportunity.network_fee_verified, true);
assert.equal(result.results[0].opportunity.network_fee_usdc, 0.01);
assert.equal(result.results[0].assessment.decision.action, 'ARBITRAGE_SETTLE');
assert.equal(result.results[0].settlement.settlement_status, 'ARBITRAGE_CLOSED');
assert.equal(result.results[0].execution_dispatched, false);
assert.equal(result.results[0].transaction_created, false);
assert.equal(result.results[0].signer_requested, false);
assert.equal(result.results[0].funds_moved, false);
assert.equal(result.results[0].network_submission_authorized, false);
assert.equal(result.results[0].live_execution_authorized, false);

await assert.rejects(
  () => runtime.scanAndQualifyPair({ token_mint: 'TOKEN', quote_mint: 'USDC', demo_account: demoAccount, live_execution_authorized: true }),
  /shadow_pretrade_live_boundary_violation/
);

console.log('orca raydium shadow qualified pretrade runtime regression ok');
