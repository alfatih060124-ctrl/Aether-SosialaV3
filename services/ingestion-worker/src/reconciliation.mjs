export function reconcileNetBalanceChanges({ tokenBalanceChanges = [], tokenIn, tokenOut, amountInRaw, amountOutRaw }) {
  const inChange = tokenBalanceChanges.find((x) => x.token === tokenIn && BigInt(x.deltaRaw) < 0n);
  const outChange = tokenBalanceChanges.find((x) => x.token === tokenOut && BigInt(x.deltaRaw) > 0n);
  if (!inChange || !outChange) return { ok: false, reason: 'BALANCE_CHANGE_NOT_FOUND' };

  const actualIn = -BigInt(inChange.deltaRaw);
  const actualOut = BigInt(outChange.deltaRaw);
  if (actualIn !== BigInt(amountInRaw) || actualOut !== BigInt(amountOutRaw)) {
    return { ok: false, reason: 'RAW_AMOUNT_MISMATCH' };
  }
  return { ok: true, amount_in_raw: actualIn.toString(), amount_out_raw: actualOut.toString() };
}
