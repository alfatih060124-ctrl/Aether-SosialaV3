import assert from 'node:assert/strict';
import fs from 'node:fs';
import { derivePaperArbitrageAccounting, PAPER_ARBITRAGE_PERSISTENCE } from '../services/api/src/paper-arbitrage-persistence.mjs';

const result = {
  qualified: true,
  mode: 'SHADOW',
  execution_dispatched: false,
  funds_moved: false,
  live_execution_authorized: false,
  opportunity: { token_mint: 'TOKEN', quote_mint: 'USDC' },
  assessment: {
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    training_fixture: false,
    market_data_mode: 'REAL_MARKET_SHADOW',
    benchmark_eligible: true,
    market_source: 'ORCA_RAYDIUM_REAL_MARKET',
    observed_at: '2026-09-06T00:00:00.000Z',
    assessment: { verdict: 'QUALIFIED', quality_score: 91 },
    decision: { action: 'ARBITRAGE_SETTLE', reason_codes: ['TWO_LEG_ARBITRAGE_QUALIFIED'] },
    arbitrage: {
      notional_usdc: 100,
      final_usdc: 100.25,
      gross_edge_bps: 40,
      net_edge_bps: 25,
      buy_route: { dex_id: 'orca', pool_address: 'orca-pool', price_usd: 1 },
      sell_route: { dex_id: 'raydium', pool_address: 'ray-pool', price_usd: 1.004 },
      cost_breakdown: { network_fee_usdc: 0.01, costs_verified: true }
    }
  }
};

const accounting = derivePaperArbitrageAccounting({
  result,
  account: { cash_balance_usdc: 200 },
  performanceFeeBps: 1000
});
assert.equal(accounting.mode, 'SHADOW');
assert.equal(accounting.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(accounting.notional_usdc, 100);
assert.equal(accounting.gross_profit_before_costs_usdc, 0.4);
assert.equal(accounting.market_execution_cost_usdc, 0.15);
assert.equal(accounting.market_net_pnl_usdc, 0.25);
assert.equal(accounting.performance_fee_usdc, 0.025);
assert.equal(accounting.member_net_profit_usdc, 0.225);
assert.equal(accounting.cash_after_usdc, 200.225);
assert.equal(accounting.profitable_cycles_delta, 1);
assert.equal(accounting.execution_dispatched, false);
assert.equal(accounting.funds_moved, false);
assert.equal(accounting.live_execution_authorized, false);

await assert.rejects(async () => derivePaperArbitrageAccounting({ result: { ...result, live_execution_authorized: true }, account: { cash_balance_usdc: 200 }, performanceFeeBps: 0 }), /paper_arbitrage_shadow_invariant_failed/);
await assert.rejects(async () => derivePaperArbitrageAccounting({ result: { ...result, qualified: false }, account: { cash_balance_usdc: 200 }, performanceFeeBps: 0 }), /paper_arbitrage_qualified_settlement_required/);
await assert.rejects(async () => derivePaperArbitrageAccounting({ result: { ...result, assessment: { ...result.assessment, arbitrage: { ...result.assessment.arbitrage, cost_breakdown: { costs_verified: false, network_fee_usdc: 0.01 } } } }, account: { cash_balance_usdc: 200 }, performanceFeeBps: 0 }), /paper_arbitrage_costs_unverified/);
await assert.rejects(async () => derivePaperArbitrageAccounting({ result: { ...result, assessment: { ...result.assessment, arbitrage: { ...result.assessment.arbitrage, sell_route: { dex_id: 'orca', pool_address: 'other', price_usd: 1.004 } } } }, account: { cash_balance_usdc: 200 }, performanceFeeBps: 0 }), /paper_arbitrage_cross_dex_required/);
await assert.rejects(async () => derivePaperArbitrageAccounting({ result, account: { cash_balance_usdc: 50 }, performanceFeeBps: 0 }), /paper_arbitrage_notional_unavailable/);
await assert.rejects(async () => derivePaperArbitrageAccounting({ result, account: { cash_balance_usdc: 200 }, performanceFeeBps: 1000.5 }), /paper_arbitrage_performance_fee_bps_invalid/);

assert.equal(PAPER_ARBITRAGE_PERSISTENCE.legacy_training_positions_reused, false);
assert.equal(PAPER_ARBITRAGE_PERSISTENCE.transaction_count_cap, null);
assert.deepEqual(PAPER_ARBITRAGE_PERSISTENCE.performance_windows, ['TODAY','7D','30D','ALL_TIME']);
assert.equal(PAPER_ARBITRAGE_PERSISTENCE.live_execution_authorized, false);

const migration = fs.readFileSync(new URL('../migrations/024_paper_arbitrage_persistence.sql', import.meta.url), 'utf8');
assert.match(migration, /member_paper_arbitrage_accounts/);
assert.match(migration, /member_paper_arbitrage_cycles/);
assert.match(migration, /TWO_LEG_ARBITRAGE/);
assert.match(migration, /live_execution_authorized=false/);
assert.doesNotMatch(migration, /member_autotrade_demo_trades/);

console.log('PAPER arbitrage persistence regression: PASS');
