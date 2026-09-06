const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finitePositive = (value, code) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !(numeric > 0)) throw new Error(code);
  return numeric;
};

function assertShadowContext(context = {}) {
  if (context.read_only !== true || context.strategy !== 'TWO_LEG_ARBITRAGE') {
    throw new Error('sell_simulation_shadow_context_required');
  }
  if (context.live_execution_authorized === true || context.network_submission_authorized === true || context.transaction_signing_authorized === true) {
    throw new Error('sell_simulation_live_boundary_violation');
  }
  const opportunity = context.opportunity;
  if (!opportunity || typeof opportunity !== 'object') throw new Error('sell_simulation_opportunity_required');
  const sell = opportunity.sell_route;
  if (!sell || typeof sell !== 'object') throw new Error('sell_simulation_sell_route_required');
  const dex = text(sell.dex_id, 'sell_simulation_sell_dex_required').toLowerCase();
  if (!['orca', 'raydium'].includes(dex)) throw new Error('sell_simulation_sell_dex_invalid');
  if (sell.quote_verified !== true || sell.costs_verified !== true) throw new Error('sell_simulation_sell_route_unverified');
  return Object.freeze({
    token_mint: text(context.token_mint || opportunity.token_mint, 'sell_simulation_token_mint_required'),
    quote_mint: text(context.quote_mint || opportunity.quote_mint, 'sell_simulation_quote_mint_required'),
    sell_dex: dex,
    sell_pool: text(sell.pool_address, 'sell_simulation_sell_pool_required'),
    notional_usdc: finitePositive(context.notional_usdc, 'sell_simulation_notional_required'),
    sell_quote_source: text(sell.quote_source, 'sell_simulation_quote_source_required')
  });
}

function assertUnsignedEvidence(raw, expected) {
  if (!raw || typeof raw !== 'object' || raw.verified !== true) throw new Error('sell_simulation_unsigned_evidence_required');
  if (raw.read_only !== true || raw.unsigned !== true || raw.simulation_only !== true) throw new Error('sell_simulation_unsigned_context_invalid');
  if (raw.transaction_signed === true || raw.signer_requested === true || raw.private_key_present === true || raw.signature_present === true) {
    throw new Error('sell_simulation_signing_boundary_violation');
  }
  if (raw.network_submission_authorized === true || raw.live_execution_authorized === true || raw.execution_transaction_building_authorized === true) {
    throw new Error('sell_simulation_execution_boundary_violation');
  }
  if (text(raw.token_mint, 'sell_simulation_evidence_token_required') !== expected.token_mint) throw new Error('sell_simulation_token_mismatch');
  if (text(raw.quote_mint, 'sell_simulation_evidence_quote_required') !== expected.quote_mint) throw new Error('sell_simulation_quote_mismatch');
  if (text(raw.sell_dex, 'sell_simulation_evidence_dex_required').toLowerCase() !== expected.sell_dex) throw new Error('sell_simulation_dex_mismatch');
  if (text(raw.sell_pool, 'sell_simulation_evidence_pool_required') !== expected.sell_pool) throw new Error('sell_simulation_pool_mismatch');
  if (finitePositive(raw.notional_usdc, 'sell_simulation_evidence_notional_required') !== expected.notional_usdc) throw new Error('sell_simulation_notional_mismatch');
  if (text(raw.sell_quote_source, 'sell_simulation_evidence_quote_source_required') !== expected.sell_quote_source) throw new Error('sell_simulation_quote_source_mismatch');
  text(raw.transaction_base64, 'sell_simulation_transaction_required');
  text(raw.source_reference, 'sell_simulation_evidence_reference_required');
  return raw;
}

export function createOrcaRaydiumSellSimulationBoundary({ buildUnsignedSellSimulation, simulateUnsignedTransaction, now = () => Date.now() } = {}) {
  if (typeof buildUnsignedSellSimulation !== 'function') throw new Error('sell_simulation_builder_required');
  if (typeof simulateUnsignedTransaction !== 'function') throw new Error('sell_simulation_rpc_required');

  return async function loadSellSimulationSource(context = {}) {
    const expected = assertShadowContext(context);
    const unsigned = assertUnsignedEvidence(await buildUnsignedSellSimulation(Object.freeze({
      ...context,
      expected_sell_identity: expected,
      simulation_only: true,
      read_only: true,
      transaction_signing_authorized: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    })), expected);

    const simulated = await simulateUnsignedTransaction(Object.freeze({
      transaction_base64: unsigned.transaction_base64,
      source_slot: unsigned.source_slot,
      simulation_only: true,
      sig_verify: false,
      read_only: true,
      network_submission_authorized: false,
      live_execution_authorized: false
    }));
    if (!simulated || typeof simulated !== 'object' || simulated.verified !== true) throw new Error('sell_simulation_rpc_unverified');
    if (simulated.transaction_signed === true || simulated.network_submission_authorized === true || simulated.live_execution_authorized === true) {
      throw new Error('sell_simulation_rpc_boundary_violation');
    }
    if (simulated.simulation_ok !== true) throw new Error('sell_simulation_failed');

    return Object.freeze({
      verified: true,
      sell_simulation_ok: true,
      source: 'SOLANA_RPC_UNSIGNED_SELL_SIMULATION',
      source_reference: `${unsigned.source_reference}|${text(simulated.source_reference, 'sell_simulation_rpc_reference_required')}`,
      observed_at: new Date(Number(now())).toISOString(),
      token_mint: expected.token_mint,
      quote_mint: expected.quote_mint,
      sell_dex: expected.sell_dex,
      sell_pool: expected.sell_pool,
      notional_usdc: expected.notional_usdc,
      sell_quote_source: expected.sell_quote_source,
      simulation_only: true,
      read_only: true,
      execution_transaction_building_authorized: false,
      transaction_signing_authorized: false,
      network_submission_authorized: false,
      funds_moved: false,
      live_execution_authorized: false
    });
  };
}

export const ORCA_RAYDIUM_SELL_SIMULATION_BOUNDARY = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  exact_sell_identity_required: true,
  simulation_only_unsigned_construction_authorized: true,
  execution_transaction_building_authorized: false,
  transaction_signing_authorized: false,
  private_key_allowed: false,
  network_submission_authorized: false,
  funds_moved: false,
  live_execution_authorized: false
});
