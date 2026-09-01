import assert from 'node:assert/strict';
import { reconcileNetBalanceChanges } from '../services/ingestion-worker/src/reconciliation.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production signature, tx hash, wallet, source reference, or trader metric is represented here.
const TOKEN_IN = 'SYNTHETIC_TOKEN_IN_TEST_ONLY';
const TOKEN_OUT = 'SYNTHETIC_TOKEN_OUT_TEST_ONLY';

const aggregated = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '-600' },
    { token: TOKEN_IN, deltaRaw: '-400' },
    { token: TOKEN_OUT, deltaRaw: '700' },
    { token: TOKEN_OUT, deltaRaw: '300' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '1000',
  amountOutRaw: '1000'
});
assert.deepEqual(aggregated, {
  ok: true,
  amount_in_raw: '1000',
  amount_out_raw: '1000',
  reconciliation_method: 'AGGREGATED_NET_TOKEN_BALANCE_CHANGE_V1'
});

const partialFirstRowWouldBeWrong = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '-10' },
    { token: TOKEN_IN, deltaRaw: '-90' },
    { token: TOKEN_OUT, deltaRaw: '25' },
    { token: TOKEN_OUT, deltaRaw: '75' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '100',
  amountOutRaw: '100'
});
assert.equal(partialFirstRowWouldBeWrong.ok, true);

const malformedMatchingDelta = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '-50' },
    { token: TOKEN_IN, deltaRaw: 'not-an-integer' },
    { token: TOKEN_OUT, deltaRaw: '100' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '50',
  amountOutRaw: '100'
});
assert.deepEqual(malformedMatchingDelta, { ok: false, reason: 'INVALID_BALANCE_CHANGE' });

const malformedExpected = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '-100' },
    { token: TOKEN_OUT, deltaRaw: '100' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '1e2',
  amountOutRaw: '100'
});
assert.deepEqual(malformedExpected, { ok: false, reason: 'INVALID_EXPECTED_RAW_AMOUNT' });

const unsafeExpectedNumber = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '-9007199254740992' },
    { token: TOKEN_OUT, deltaRaw: '100' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: Number.MAX_SAFE_INTEGER + 1,
  amountOutRaw: 100
});
assert.deepEqual(unsafeExpectedNumber, { ok: false, reason: 'INVALID_EXPECTED_RAW_AMOUNT' });

const unsafeBalanceNumber = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: -(Number.MAX_SAFE_INTEGER + 1) },
    { token: TOKEN_OUT, deltaRaw: 100 }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '9007199254740992',
  amountOutRaw: '100'
});
assert.deepEqual(unsafeBalanceNumber, { ok: false, reason: 'INVALID_BALANCE_CHANGE' });

const wrongDirection = reconcileNetBalanceChanges({
  tokenBalanceChanges: [
    { token: TOKEN_IN, deltaRaw: '100' },
    { token: TOKEN_OUT, deltaRaw: '-100' }
  ],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '100',
  amountOutRaw: '100'
});
assert.deepEqual(wrongDirection, { ok: false, reason: 'BALANCE_CHANGE_DIRECTION_MISMATCH' });

const missingOutput = reconcileNetBalanceChanges({
  tokenBalanceChanges: [{ token: TOKEN_IN, deltaRaw: '-100' }],
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: '100',
  amountOutRaw: '100'
});
assert.deepEqual(missingOutput, { ok: false, reason: 'BALANCE_CHANGE_NOT_FOUND' });

console.log('ingestion reconciliation regression: ok');
