import assert from 'node:assert/strict';
import { settleDemoArbitrage } from '../services/api/src/demo-autotrade-ledger.mjs';

const base = {
  initial_balance_usdc: 100,
  cash_balance_usdc: 100,
  open_position: {}
};

const profitable = settleDemoArbitrage({
  account: base,
  notionalUsdc: 100,
  finalUsdc: 101,
  performanceFeeBps: 1000
});
assert.equal(profitable.settlement_status, 'ARBITRAGE_CLOSED');
assert.equal(profitable.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(profitable.gross_pnl_usdc, 1);
assert.equal(profitable.performance_fee_usdc, 0.1);
assert.equal(profitable.net_pnl_usdc, 0.9);
assert.equal(profitable.balance_after_usdc, 100.9);
assert.equal(profitable.winning_trades_delta, 1);
assert.deepEqual(profitable.open_position, {});
assert.equal(profitable.live_execution_authorized, false);

const loss = settleDemoArbitrage({
  account: base,
  notionalUsdc: 50,
  finalUsdc: 49.5,
  performanceFeeBps: 1000
});
assert.equal(loss.performance_fee_usdc, 0);
assert.equal(loss.net_pnl_usdc, -0.5);
assert.equal(loss.balance_after_usdc, 99.5);
assert.equal(loss.losing_trades_delta, 1);
assert.deepEqual(loss.open_position, {});

await assert.rejects(
  async () => settleDemoArbitrage({
    account: { ...base, cash_balance_usdc: 90, open_position: { notional_usdc: 10 } },
    notionalUsdc: 10,
    finalUsdc: 10.1
  }),
  /arbitrage_open_position_not_allowed/
);

console.log(JSON.stringify({
  ok: true,
  schema: 'aether.member_autotrade_demo.regression.v2',
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  live_execution_authorized: false
}));
