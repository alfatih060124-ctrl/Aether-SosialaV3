import assert from 'node:assert/strict';
import { createFollowerPositionAccountingService } from '../services/api/src/follower-position-accounting.mjs';
import { createTrustedAutoTradeRuntimeRiskResolver } from '../services/api/src/trusted-autotrade-runtime-risk.mjs';

const followerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policyId = '11111111-1111-4111-8111-111111111111';
const traderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const positionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const wallet = 'Wallet1111111111111111111111111111111111';
const now = new Date('2026-09-04T00:00:30.000Z');

function makePositionPool({ state = null, pnl = '0', positions = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM follower_shadow_accounting_state')) return { rows: state ? [state] : [] };
      if (sql.includes('FROM follower_shadow_position_events')) return { rows: [{ daily_realized_pnl_usdc: pnl, daily_realized_pnl_usd: pnl }] };
      if (sql.includes('FROM follower_shadow_positions')) return { rows: positions };
      throw new Error(`unexpected_position_query: ${sql}`);
    }
  };
}

const unavailablePool = makePositionPool();
const unavailable = createFollowerPositionAccountingService(unavailablePool, { now: () => now });
const unavailableSnapshot = await unavailable.getFollowerSnapshot(followerId);
assert.equal(unavailableSnapshot.accounting_ready, false);
assert.equal(unavailableSnapshot.reason, 'ACCOUNTING_NOT_READY');
assert.equal(unavailableSnapshot.daily_realized_pnl_usdc, null);
assert.deepEqual(unavailableSnapshot.items, []);
assert.equal(unavailableSnapshot.mode, 'SHADOW');
assert.equal(unavailableSnapshot.simulated, true);
assert.equal(unavailableSnapshot.live_execution_authorized, false);
assert.equal(unavailablePool.queries.length, 1, 'fail-closed snapshot must not query partial positions');

const stalePool = makePositionPool({
  state: {
    follower_user_id: followerId,
    accounting_ready: true,
    complete_through: '2026-09-03T23:55:00.000Z',
    source_version: 'shadow-fill-ledger-v1',
    mode: 'SHADOW',
    live_execution_authorized: false
  }
});
const stale = createFollowerPositionAccountingService(stalePool, { now: () => now, maxAccountingLagMs: 60_000 });
const staleSnapshot = await stale.getFollowerSnapshot(followerId);
assert.equal(staleSnapshot.accounting_ready, false);
assert.equal(staleSnapshot.reason, 'ACCOUNTING_STALE');
assert.deepEqual(staleSnapshot.items, []);

const readyState = {
  follower_user_id: followerId,
  accounting_ready: true,
  complete_through: '2026-09-04T00:00:20.000Z',
  source_cursor: 'cursor-1',
  source_version: 'shadow-fill-ledger-v1',
  mode: 'SHADOW',
  live_execution_authorized: false,
  updated_at: '2026-09-04T00:00:20.000Z'
};
const readyPool = makePositionPool({
  state: readyState,
  pnl: '-1.25',
  positions: [{
    position_id: positionId,
    policy_id: policyId,
    trader_id: traderId,
    token_mint: 'TokenMint11111111111111111111111111111111',
    quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    status: 'OPEN',
    token_quantity: '2',
    cost_basis_usdc: '10',
    realized_pnl_usdc: '-1.25',
    last_mark_price_usdc: '6',
    mark_observed_at: '2026-09-04T00:00:25.000Z',
    opened_at: '2026-09-03T23:59:00.000Z',
    closed_at: null,
    updated_at: '2026-09-04T00:00:25.000Z'
  }]
});
const ready = createFollowerPositionAccountingService(readyPool, { now: () => now });
const readySnapshot = await ready.getFollowerSnapshot(followerId, 50);
assert.equal(readySnapshot.accounting_ready, true);
assert.equal(readySnapshot.daily_realized_pnl_usdc, -1.25);
assert.equal(readySnapshot.items.length, 1);
assert.equal(readySnapshot.items[0].status, 'OPEN');
assert.equal(readySnapshot.items[0].mark_status, 'FRESH');
assert.equal(readySnapshot.items[0].market_value_usdc, 12);
assert.equal(readySnapshot.items[0].unrealized_pnl_usdc, 2);
assert.equal(readySnapshot.items[0].mode, 'SHADOW');
assert.equal(readySnapshot.items[0].simulated, true);
assert.equal(readySnapshot.items[0].live_execution_authorized, false);

const riskQueries = [];
const riskPool = {
  async query(sql) {
    riskQueries.push(sql);
    if (sql.includes('FROM copy_policies')) return { rows: [{ reserved_usd: '25' }] };
    if (sql.includes('FROM auto_trade_decisions')) return { rows: [{ decisions_today: 1, last_decision_at: '2026-09-03T23:59:30.000Z' }] };
    if (sql.includes('FROM follower_shadow_accounting_state')) return { rows: [readyState] };
    if (sql.includes('FROM follower_shadow_position_events')) return { rows: [{ daily_realized_pnl_usd: '-1.25' }] };
    throw new Error(`unexpected_risk_query: ${sql}`);
  }
};
const portfolioService = {
  async getPortfolio(address) {
    assert.equal(address, wallet);
    return {
      wallet,
      base_currency: 'USDC',
      observed_at: now.toISOString(),
      read_only: true,
      non_custodial: true,
      signer_required: false,
      transaction_created: false,
      funds_moved: false,
      live_execution_authorized: false,
      balances: { usdc: { amount: 100 } }
    };
  }
};
const resolver = createTrustedAutoTradeRuntimeRiskResolver({
  pool: riskPool,
  portfolioService,
  walletAddress: wallet,
  env: { AUTOTRADE_POSITION_ACCOUNTING_ENABLED: 'true', AUTOTRADE_ACCOUNTING_MAX_LAG_MS: '60000' },
  now: () => now
});
const risk = await resolver({
  authenticated_follower_user_id: followerId,
  policy_id: policyId,
  assessment: { token_mint: 'TokenMint11111111111111111111111111111111' }
});
assert.equal(risk.capital_limit_usd, 100);
assert.equal(risk.available_capital_usd, 75);
assert.equal(risk.daily_realized_pnl_usd, -1.25);
assert.equal(risk.risk_metadata.position_accounting_feature_enabled, true);
assert.equal(risk.risk_metadata.daily_pnl_accounting_ready, true);
assert.equal(risk.risk_metadata.accounting_source_version, 'shadow-fill-ledger-v1');
assert.equal(risk.risk_metadata.execution_dispatched, false);
assert.equal(risk.risk_metadata.live_execution_authorized, false);
assert.equal(risk.risk_metadata.network_submission_authorized, false);
assert.equal(risk.risk_metadata.signer_required, false);
assert.equal(riskQueries.length, 4);

const disabledQueries = [];
const disabledPool = {
  async query(sql) {
    disabledQueries.push(sql);
    if (sql.includes('FROM copy_policies')) return { rows: [{ reserved_usd: '0' }] };
    if (sql.includes('FROM auto_trade_decisions')) return { rows: [{ decisions_today: 0, last_decision_at: null }] };
    throw new Error('position accounting query must not run while feature is disabled');
  }
};
const disabled = createTrustedAutoTradeRuntimeRiskResolver({
  pool: disabledPool,
  portfolioService,
  walletAddress: wallet,
  env: {},
  now: () => now
});
const disabledRisk = await disabled({ authenticated_follower_user_id: followerId, policy_id: policyId, assessment: { token_mint: 'TokenMint11111111111111111111111111111111' } });
assert.equal(disabledRisk.risk_metadata.position_accounting_feature_enabled, false);
assert.equal(disabledRisk.risk_metadata.daily_pnl_accounting_ready, false);
assert.equal(disabledRisk.risk_metadata.daily_pnl_accounting_reason, 'ACCOUNTING_FEATURE_DISABLED');
assert.equal(disabledQueries.length, 2);

console.log('follower position accounting regression: PASS');
