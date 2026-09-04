import assert from 'node:assert/strict';
import { settleDemoAction } from '../services/api/src/demo-autotrade-ledger.mjs';

const base = {
  initial_balance_usdc: 100,
  cash_balance_usdc: 100,
  open_position: {}
};

const buy = settleDemoAction({ account: base, engineAction: 'BUY', requestedAmountUsdc: 100, performanceFeeBps: 1000 });
assert.equal(buy.settlement_status, 'OPENED');
assert.equal(buy.cash_balance_usdc, 0);
assert.equal(buy.balance_after_usdc, 100);

const profitable = settleDemoAction({
  account: { ...base, cash_balance_usdc: buy.cash_balance_usdc, open_position: buy.open_position },
  engineAction: 'SELL',
  positionPnlBps: 1111,
  performanceFeeBps: 1000
});
assert.equal(profitable.settlement_status, 'CLOSED');
assert.equal(profitable.performance_fee_usdc > 0, true);
assert.equal(profitable.net_pnl_usdc > 9.99 && profitable.net_pnl_usdc < 10.01, true);
assert.equal(profitable.balance_after_usdc > 109.99 && profitable.balance_after_usdc < 110.01, true);
assert.equal(profitable.winning_trades_delta, 1);

const lossBuy = settleDemoAction({ account: { ...base, cash_balance_usdc: 100 }, engineAction: 'BUY', requestedAmountUsdc: 50 });
const loss = settleDemoAction({
  account: { ...base, cash_balance_usdc: lossBuy.cash_balance_usdc, open_position: lossBuy.open_position },
  engineAction: 'SELL',
  positionPnlBps: -700,
  performanceFeeBps: 1000
});
assert.equal(loss.performance_fee_usdc, 0);
assert.equal(loss.net_pnl_usdc, -3.5);
assert.equal(loss.balance_after_usdc, 96.5);
assert.equal(loss.losing_trades_delta, 1);

const duplicateBuy = settleDemoAction({
  account: { ...base, cash_balance_usdc: 90, open_position: { notional_usdc: 10 } },
  engineAction: 'BUY',
  requestedAmountUsdc: 10
});
assert.equal(duplicateBuy.settlement_status, 'OPEN_POSITION_EXISTS');
assert.equal(duplicateBuy.balance_after_usdc, 100);

const noOpenSell = settleDemoAction({ account: base, engineAction: 'SELL', positionPnlBps: 800 });
assert.equal(noOpenSell.settlement_status, 'NO_OPEN_POSITION');
assert.equal(noOpenSell.balance_after_usdc, 100);

console.log(JSON.stringify({ ok: true, schema: 'aether.member_autotrade_demo.regression.v1', mode: 'SHADOW', live_execution_authorized: false }));
