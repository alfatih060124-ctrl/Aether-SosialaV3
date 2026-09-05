const finite = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function requiredBps(value, code) {
  const numeric = finite(value);
  if (numeric === null || numeric < 0 || numeric > 10_000) throw new Error(code);
  return numeric;
}

function instructionContext(row, expectedDex, observedSlot) {
  const context = row?.instruction_context;
  if (!context || typeof context !== 'object' || context.verified !== true) throw new Error(`${expectedDex}_instruction_context_required`);
  if (context.read_only !== true || context.live_execution_authorized === true || context.private_key_present === true || context.signature_present === true) {
    throw new Error(`${expectedDex}_instruction_context_boundary_invalid`);
  }
  if (Number(context.source_slot) !== observedSlot) throw new Error(`${expectedDex}_instruction_context_slot_mismatch`);
  return context;
}

function normalizeProviderRow(row, expectedDex, tokenMint, quoteMint) {
  if (!row || typeof row !== 'object') throw new Error(`${expectedDex}_provider_row_required`);
  const reportedDex = String(row.dex_id || expectedDex).trim().toLowerCase();
  if (reportedDex !== expectedDex) throw new Error(`${expectedDex}_provider_dex_mismatch`);
  const rowTokenMint = text(row.token_mint, `${expectedDex}_token_mint_required`);
  const rowQuoteMint = text(row.quote_mint, `${expectedDex}_quote_mint_required`);
  if (rowTokenMint !== tokenMint || rowQuoteMint !== quoteMint) throw new Error(`${expectedDex}_provider_pair_mismatch`);

  const buyPriceUsd = finite(row.buy_price_usd);
  const sellPriceUsd = finite(row.sell_price_usd);
  if (!(buyPriceUsd > 0)) throw new Error(`${expectedDex}_buy_price_required`);
  if (!(sellPriceUsd > 0)) throw new Error(`${expectedDex}_sell_price_required`);
  const buyFeeBps = requiredBps(row.buy_fee_bps, `${expectedDex}_buy_fee_bps_required`);
  const sellFeeBps = requiredBps(row.sell_fee_bps, `${expectedDex}_sell_fee_bps_required`);
  const buyPriceImpactBps = requiredBps(row.buy_price_impact_bps, `${expectedDex}_buy_price_impact_bps_required`);
  const sellPriceImpactBps = requiredBps(row.sell_price_impact_bps, `${expectedDex}_sell_price_impact_bps_required`);

  if (row.quote_verified !== true) throw new Error(`${expectedDex}_quote_unverified`);
  if (row.costs_verified !== true) throw new Error(`${expectedDex}_costs_unverified`);
  const observedAt = text(row.observed_at, `${expectedDex}_observed_at_required`);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`${expectedDex}_observed_at_invalid`);
  const observedSlot = Number(row.observed_slot);
  if (!Number.isSafeInteger(observedSlot) || observedSlot <= 0) throw new Error(`${expectedDex}_observed_slot_required`);
  const verifiedContext = instructionContext(row, expectedDex, observedSlot);

  return Object.freeze({
    dex_id: expectedDex,
    pool_address: text(row.pool_address, `${expectedDex}_pool_address_required`),
    token_mint: rowTokenMint,
    quote_mint: rowQuoteMint,
    buy_price_usd: buyPriceUsd,
    sell_price_usd: sellPriceUsd,
    buy_fee_bps: buyFeeBps,
    sell_fee_bps: sellFeeBps,
    buy_price_impact_bps: buyPriceImpactBps,
    sell_price_impact_bps: sellPriceImpactBps,
    liquidity_usd: finite(row.liquidity_usd),
    quote_source: text(row.quote_source, `${expectedDex}_quote_source_required`),
    quote_verified: true,
    costs_verified: true,
    observed_at: new Date(Date.parse(observedAt)).toISOString(),
    observed_slot: observedSlot,
    instruction_context: verifiedContext
  });
}

function normalizeRows(rows, dex, tokenMint, quoteMint) {
  if (!Array.isArray(rows)) throw new Error(`${dex}_provider_payload_invalid`);
  return rows.map(row => normalizeProviderRow(row, dex, tokenMint, quoteMint));
}

export function createOrcaRaydiumReadOnlyPoolLoader({ loadOrcaQuotes, loadRaydiumQuotes } = {}) {
  if (typeof loadOrcaQuotes !== 'function') throw new Error('orca_quote_loader_required');
  if (typeof loadRaydiumQuotes !== 'function') throw new Error('raydium_quote_loader_required');

  return async function loadPools({ token_mint, quote_mint, dexes } = {}) {
    const tokenMint = text(token_mint, 'provider_token_mint_required');
    const quoteMint = text(quote_mint, 'provider_quote_mint_required');
    if (tokenMint === quoteMint) throw new Error('provider_distinct_mints_required');
    if (!Array.isArray(dexes) || dexes.length !== 2 || dexes[0] !== 'orca' || dexes[1] !== 'raydium') {
      throw new Error('provider_orca_raydium_scope_required');
    }

    const request = Object.freeze({
      token_mint: tokenMint,
      quote_mint: quoteMint,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE'
    });
    const [orcaRows, raydiumRows] = await Promise.all([
      loadOrcaQuotes(request),
      loadRaydiumQuotes(request)
    ]);
    const orca = normalizeRows(orcaRows, 'orca', tokenMint, quoteMint);
    const raydium = normalizeRows(raydiumRows, 'raydium', tokenMint, quoteMint);
    if (!orca.length) throw new Error('orca_provider_no_verified_quotes');
    if (!raydium.length) throw new Error('raydium_provider_no_verified_quotes');
    return Object.freeze([...orca, ...raydium]);
  };
}
