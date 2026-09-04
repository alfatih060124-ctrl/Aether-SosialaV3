const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = value => Math.round((finite(value) + Number.EPSILON) * 1e8) / 1e8;
const clampBps = value => Math.max(0, Math.min(10000, Math.round(finite(value))));

export function demoEquity(account) {
  const cash = finite(account?.cash_balance_usdc);
  const open = account?.open_position && typeof account.open_position === 'object' ? account.open_position : {};
  const principal = finite(open.notional_usdc);
  return round(cash + principal);
}

export function settleDemoAction({ account, engineAction, requestedAmountUsdc = 0, positionPnlBps = 0, performanceFeeBps = 1000, now = new Date().toISOString() }) {
  if (!account || typeof account !== 'object') throw new Error('demo_account_required');
  const action = String(engineAction || '').toUpperCase();
  if (!['BUY','SELL','HOLD','REJECT'].includes(action)) throw new Error('invalid_demo_engine_action');

  const cashBefore = finite(account.cash_balance_usdc);
  const openBefore = account.open_position && typeof account.open_position === 'object' ? account.open_position : {};
  const hasOpen = finite(openBefore.notional_usdc) > 0;
  const balanceBefore = round(cashBefore + finite(openBefore.notional_usdc));
  const feeBps = clampBps(performanceFeeBps);

  let cashAfter = cashBefore;
  let openAfter = { ...openBefore };
  let settlementStatus = action === 'HOLD' ? 'HELD' : 'REJECTED';
  let notional = 0;
  let grossPnl = 0;
  let performanceFee = 0;
  let netPnl = 0;
  let pnlBps = null;
  let tradesClosedDelta = 0;
  let winningTradesDelta = 0;
  let losingTradesDelta = 0;

  if (action === 'BUY') {
    if (hasOpen) {
      settlementStatus = 'OPEN_POSITION_EXISTS';
    } else {
      notional = round(Math.max(0, Math.min(cashBefore, finite(requestedAmountUsdc))));
      if (notional <= 0) {
        settlementStatus = 'INSUFFICIENT_DEMO_BALANCE';
      } else {
        cashAfter = round(cashBefore - notional);
        openAfter = { notional_usdc: notional, opened_at: now };
        settlementStatus = 'OPENED';
      }
    }
  } else if (action === 'SELL') {
    if (!hasOpen) {
      settlementStatus = 'NO_OPEN_POSITION';
      openAfter = {};
    } else {
      notional = round(finite(openBefore.notional_usdc));
      pnlBps = Math.round(finite(positionPnlBps));
      grossPnl = round(notional * pnlBps / 10000);
      performanceFee = grossPnl > 0 ? round(grossPnl * feeBps / 10000) : 0;
      netPnl = round(grossPnl - performanceFee);
      cashAfter = round(cashBefore + notional + netPnl);
      openAfter = {};
      settlementStatus = 'CLOSED';
      tradesClosedDelta = 1;
      if (netPnl > 0) winningTradesDelta = 1;
      else if (netPnl < 0) losingTradesDelta = 1;
    }
  }

  const balanceAfter = round(cashAfter + finite(openAfter.notional_usdc));
  return Object.freeze({
    settlement_status: settlementStatus,
    notional_usdc: notional,
    gross_pnl_usdc: grossPnl,
    performance_fee_usdc: performanceFee,
    net_pnl_usdc: netPnl,
    pnl_bps: pnlBps,
    balance_before_usdc: balanceBefore,
    balance_after_usdc: balanceAfter,
    cash_balance_usdc: cashAfter,
    open_position: Object.freeze(openAfter),
    trades_closed_delta: tradesClosedDelta,
    winning_trades_delta: winningTradesDelta,
    losing_trades_delta: losingTradesDelta,
    performance_fee_bps: feeBps,
    mode: 'SHADOW',
    live_execution_authorized: false
  });
}
