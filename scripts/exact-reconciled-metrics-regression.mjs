import assert from 'node:assert/strict';
import { calculateReconciledMetrics } from '../services/api/src/trader-evidence-collector.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These values are not production trader evidence.
const aggregateBoundary = calculateReconciledMetrics([
  {
    trade_id: 'synthetic-aggregate-a',
    realized_pnl_minor: -3_867_749_999_936_725,
    capital_minor: 8_999_999_999_861_279,
    equity_after_minor: 8_999_999_999_000_000
  },
  {
    trade_id: 'synthetic-aggregate-b',
    realized_pnl_minor: -3_867_749_999_936_724,
    capital_minor: 8_999_999_999_844_244,
    equity_after_minor: 8_999_999_999_000_000
  }
]);

assert.equal(aggregateBoundary.trades_count, 2);
assert.equal(aggregateBoundary.total_return_bps, -4298);
assert.equal(aggregateBoundary.win_rate_bps, 0);

const drawdownBoundary = calculateReconciledMetrics([
  {
    trade_id: 'synthetic-drawdown-peak',
    realized_pnl_minor: 1,
    capital_minor: 1,
    equity_after_minor: 8_999_999_999_983_425
  },
  {
    trade_id: 'synthetic-drawdown-trough',
    realized_pnl_minor: -1,
    capital_minor: 1,
    equity_after_minor: 4_934_249_999_990_913
  }
]);

assert.equal(drawdownBoundary.drawdown_bps, 4517);

assert.throws(
  () => calculateReconciledMetrics([{
    trade_id: 'synthetic-unsafe-number',
    realized_pnl_minor: Number.MAX_SAFE_INTEGER + 1,
    capital_minor: 1,
    equity_after_minor: 1
  }]),
  /invalid_trade_0_realized_pnl_minor/
);

console.log('exact reconciled metrics regression: PASS');
