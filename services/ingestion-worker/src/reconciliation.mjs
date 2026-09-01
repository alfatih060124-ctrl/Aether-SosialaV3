function parseIntegerRaw(value) {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^-?(0|[1-9]\d*)$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function sumTokenChanges(tokenBalanceChanges, token) {
  let matched = false;
  let total = 0n;

  for (const change of tokenBalanceChanges) {
    if (!change || change.token !== token) continue;
    matched = true;
    const parsed = parseIntegerRaw(change.deltaRaw);
    if (parsed === null) return { ok: false, reason: 'INVALID_BALANCE_CHANGE' };
    total += parsed;
  }

  return matched ? { ok: true, total } : { ok: false, reason: 'BALANCE_CHANGE_NOT_FOUND' };
}

export function reconcileNetBalanceChanges({ tokenBalanceChanges = [], tokenIn, tokenOut, amountInRaw, amountOutRaw }) {
  if (!Array.isArray(tokenBalanceChanges)) return { ok: false, reason: 'INVALID_BALANCE_CHANGES' };
  if (typeof tokenIn !== 'string' || typeof tokenOut !== 'string' || !tokenIn || !tokenOut || tokenIn === tokenOut) {
    return { ok: false, reason: 'INVALID_TOKEN_PAIR' };
  }

  const expectedIn = parseIntegerRaw(amountInRaw);
  const expectedOut = parseIntegerRaw(amountOutRaw);
  if (expectedIn === null || expectedOut === null || expectedIn <= 0n || expectedOut <= 0n) {
    return { ok: false, reason: 'INVALID_EXPECTED_RAW_AMOUNT' };
  }

  const inChanges = sumTokenChanges(tokenBalanceChanges, tokenIn);
  if (!inChanges.ok) return inChanges;
  const outChanges = sumTokenChanges(tokenBalanceChanges, tokenOut);
  if (!outChanges.ok) return outChanges;

  const actualIn = -inChanges.total;
  const actualOut = outChanges.total;
  if (actualIn <= 0n || actualOut <= 0n) return { ok: false, reason: 'BALANCE_CHANGE_DIRECTION_MISMATCH' };

  if (actualIn !== expectedIn || actualOut !== expectedOut) {
    return { ok: false, reason: 'RAW_AMOUNT_MISMATCH' };
  }

  return {
    ok: true,
    amount_in_raw: actualIn.toString(),
    amount_out_raw: actualOut.toString(),
    reconciliation_method: 'AGGREGATED_NET_TOKEN_BALANCE_CHANGE_V1'
  };
}
