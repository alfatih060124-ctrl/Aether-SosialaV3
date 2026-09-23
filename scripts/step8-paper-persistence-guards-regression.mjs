import assert from 'node:assert/strict';
import {
  persistQualifiedPaperArbitrageProbe
} from '../services/api/src/paper-arbitrage-persistence.mjs';

const candidate = Object.freeze({
  mode: 'SHADOW',
  execution_dispatched: false,
  transaction_signed: false,
  network_submission_authorized: false,
  live_execution_authorized: false,
  costs_verified: true,
  exact_transaction_fee_ready: true,
  transaction_built: true,
  atomic_two_leg: true,
  roundtrip_simulation_ok: true,
  analysis_sla_passed: true,
  paper_approval_passed: true,
  analysis_latency_ms: 120,
  opportunity_age_ms: 450,
  expected_net_edge_bps: 5,
  gross_executable_spread_bps: 10,
  notional_usdc: 5,
  gross_profit_before_costs_usdc: 0.005,
  market_execution_cost_usdc: 0.0025,
  market_net_pnl_usdc: 0.0025,
  network_fee_usdc: 0.001,
  account_setup_usdc: 0,
  buy_dex_family: 'ORCA',
  sell_dex_family: 'RAYDIUM',
  buy_dex: 'Orca Whirlpool',
  sell_dex: 'Raydium AMM',
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  buy_pool_address: 'BUY_POOL',
  sell_pool_address: 'SELL_POOL',
  buy_pool_pair_verified: true,
  sell_pool_pair_verified: true,
  observed_at: '2026-09-19T08:00:00.000Z'
});

const noConnect = {
  connect() {
    throw new Error('must_not_connect');
  }
};

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, buy_pool_pair_verified: false },
    { performanceFeeBps: 0, idempotencyKey: 'unverified-pair', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_pool_pair_verification_required/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, atomic_two_leg: false },
    { performanceFeeBps: 0, idempotencyKey: 'non-atomic', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_verification_required/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, analysis_latency_ms: 301 },
    { performanceFeeBps: 0, idempotencyKey: 'slow', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_scanner_sla_rejected/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, opportunity_age_ms: 3001 },
    { performanceFeeBps: 0, idempotencyKey: 'stale', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_stale_opportunity/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, expected_net_edge_bps: 0.49 },
    { performanceFeeBps: 0, idempotencyKey: 'below-edge', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_net_edge_below_floor/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, sell_dex_family: 'RAYDIUM', sell_dex: 'Raydium', sell_pool_address: 'BUY_POOL' },
    { performanceFeeBps: 0, idempotencyKey: 'same-pool', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_distinct_pool_required/
);

await assert.rejects(
  () => persistQualifiedPaperArbitrageProbe(
    noConnect,
    { user_id: 'user-1' },
    { ...candidate, sell_dex_family: 'ORCA', sell_dex: 'Orca Whirlpool', sell_pool_address: 'SELL_POOL_ORCA_2' },
    { performanceFeeBps: 0, idempotencyKey: 'same-dex', minNetEdgeBps: 0.5 }
  ),
  /paper_arbitrage_probe_cross_dex_required/
);

const queries = [];
const account = {
  user_id: 'user-1',
  initial_balance_usdc: '100',
  cash_balance_usdc: '100',
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  live_execution_authorized: false
};
const existing = {
  cycle_id: 'existing-cycle',
  user_id: 'user-1',
  idempotency_key: 'stable-key'
};
const fakeClient = {
  async query(sql) {
    const compact = String(sql).replace(/\s+/g, ' ').trim();
    queries.push(compact);
    if (compact.startsWith('SELECT * FROM member_paper_arbitrage_accounts')) return { rows: [account] };
    if (compact.startsWith('SELECT * FROM member_paper_arbitrage_cycles')) return { rows: [existing] };
    return { rows: [] };
  },
  release() {}
};
const duplicate = await persistQualifiedPaperArbitrageProbe(
  { async connect() { return fakeClient; } },
  { user_id: 'user-1' },
  { ...candidate, sell_pool_address: 'SELL_POOL_RAYDIUM_2' },
  {
    performanceFeeBps: 0,
    executionFeeBps: 0,
    idempotencyKey: 'stable-key',
    minNetEdgeBps: 0.5
  }
);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.cycle.cycle_id, 'existing-cycle');
assert.equal(queries.some(sql => sql.startsWith('UPDATE member_paper_arbitrage_accounts')), false);
assert.equal(queries.some(sql => sql.startsWith('INSERT INTO member_paper_arbitrage_cycles')), false);

console.log('step8 PAPER persistence guards regression: PASS');