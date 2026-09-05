const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finitePositive = (value, code) => {
  const numeric = Number(value);
  if (!(numeric > 0) || !Number.isFinite(numeric)) throw new Error(code);
  return numeric;
};

const safeSlot = (value, code) => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(code);
  return numeric;
};

export function createSolanaOnchainSolUsdEvidenceLoader({
  quoteSolUsdcPool,
  poolAddress,
  notionalUsdc = 100
} = {}) {
  if (typeof quoteSolUsdcPool !== 'function') throw new Error('sol_usd_quote_loader_required');
  const configuredPool = text(poolAddress, 'sol_usd_pool_address_required');
  const configuredNotional = finitePositive(notionalUsdc, 'sol_usd_notional_required');

  return async function loadCurrentSolUsdEvidence(context = {}) {
    if (context?.read_only !== true) throw new Error('sol_usd_read_only_required');
    if (context?.live_execution_authorized === true) throw new Error('sol_usd_live_boundary_violation');
    const minimumSlot = safeSlot(context?.source_slot, 'sol_usd_source_slot_required');

    const quote = await quoteSolUsdcPool(Object.freeze({
      pool_address: configuredPool,
      token_mint: WSOL_MINT,
      quote_mint: USDC_MINT,
      notional_usdc: configuredNotional,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE'
    }));
    if (!quote || typeof quote !== 'object') throw new Error('sol_usd_quote_evidence_required');
    if (quote.quote_verified !== true || quote.costs_verified !== true) throw new Error('sol_usd_quote_unverified');
    if (quote.read_only !== true || quote.live_execution_authorized === true) throw new Error('sol_usd_quote_boundary_violation');

    const buy = finitePositive(quote.buy_price_usd, 'sol_usd_buy_price_required');
    const sell = finitePositive(quote.sell_price_usd, 'sol_usd_sell_price_required');
    if (buy < sell) throw new Error('sol_usd_crossed_quote_invalid');
    const sourceSlot = safeSlot(quote.observed_slot, 'sol_usd_observed_slot_required');
    if (sourceSlot < minimumSlot) throw new Error('sol_usd_slot_before_message');
    const observedAt = text(quote.observed_at, 'sol_usd_observed_at_required');
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error('sol_usd_observed_at_invalid');
    const source = text(quote.quote_source, 'sol_usd_quote_source_required');

    const solUsd = (buy + sell) / 2;
    return Object.freeze({
      verified: true,
      sol_usd: solUsd,
      bid_usd: sell,
      ask_usd: buy,
      source_slot: sourceSlot,
      source_reference: `SOL_USD_ONCHAIN:${configuredPool}:${sourceSlot}:${source}`,
      observed_at: new Date(Date.parse(observedAt)).toISOString(),
      read_only: true,
      network_submission_authorized: false,
      transaction_signing_authorized: false,
      live_execution_authorized: false
    });
  };
}

export const SOLANA_ONCHAIN_SOL_USD_EVIDENCE_LOADER = Object.freeze({
  mode: 'SHADOW',
  token_mint: WSOL_MINT,
  quote_mint: USDC_MINT,
  requires_configured_pool_address: true,
  requires_verified_onchain_quote: true,
  requires_source_slot_at_or_after_message: true,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
