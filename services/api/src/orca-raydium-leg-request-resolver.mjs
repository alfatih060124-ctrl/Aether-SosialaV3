const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const positiveInt = (value, code) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(code);
  return n;
};

function assertBoundary(input) {
  if (!input || typeof input !== 'object') throw new Error('leg_request_resolver_input_required');
  if (input.read_only !== true || input.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('leg_request_resolver_context_invalid');
  if (!input.opportunity || typeof input.opportunity !== 'object') throw new Error('leg_request_resolver_opportunity_required');
  if (input.opportunity.live_execution_authorized === true || input.opportunity.private_key_present === true || input.opportunity.signature_present === true) {
    throw new Error('leg_request_resolver_live_boundary_violation');
  }
}

function routeFor(opportunity, side) {
  const key = `${String(side || '').toLowerCase()}_route`;
  const route = opportunity?.[key];
  if (!route || typeof route !== 'object') throw new Error('leg_request_resolver_route_required');
  if (route.quote_verified !== true || route.costs_verified !== true) throw new Error('leg_request_resolver_route_unverified');
  if (!route.instruction_context || typeof route.instruction_context !== 'object') throw new Error('leg_request_resolver_instruction_context_required');
  if (route.instruction_context.verified !== true) throw new Error('leg_request_resolver_instruction_context_unverified');
  return route;
}

function common(route, input) {
  const context = route.instruction_context;
  const sourceSlot = positiveInt(context.source_slot ?? route.observed_slot, 'leg_request_resolver_source_slot_required');
  const observedAt = text(context.observed_at ?? route.observed_at, 'leg_request_resolver_observed_at_required');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('leg_request_resolver_observed_at_invalid');
  return {
    side: String(input.side || '').toUpperCase(),
    pool_address: text(route.pool_address, 'leg_request_resolver_pool_required'),
    token_mint: text(input.opportunity.token_mint, 'leg_request_resolver_token_mint_required'),
    quote_mint: text(input.opportunity.quote_mint, 'leg_request_resolver_quote_mint_required'),
    source_slot: sourceSlot,
    observed_at: new Date(Date.parse(observedAt)).toISOString()
  };
}

function simulationAccount(accounts, key, code) {
  return text(accounts?.[key], code);
}

function resolveOrca(route, input, accounts) {
  const ctx = route.instruction_context;
  const sideCtx = ctx[String(input.side || '').toLowerCase()];
  if (!sideCtx || typeof sideCtx !== 'object') throw new Error('leg_request_resolver_orca_side_context_required');
  return Object.freeze({
    ...common(route, input),
    token_authority: simulationAccount(accounts, 'authority', 'leg_request_resolver_orca_authority_required'),
    token_program: text(ctx.token_program, 'leg_request_resolver_orca_token_program_required'),
    token_owner_account_a: simulationAccount(accounts, 'token_owner_account_a', 'leg_request_resolver_orca_owner_a_required'),
    token_owner_account_b: simulationAccount(accounts, 'token_owner_account_b', 'leg_request_resolver_orca_owner_b_required'),
    token_vault_a: text(ctx.token_vault_a, 'leg_request_resolver_orca_vault_a_required'),
    token_vault_b: text(ctx.token_vault_b, 'leg_request_resolver_orca_vault_b_required'),
    tick_array_0: text(sideCtx.tick_array_0, 'leg_request_resolver_orca_tick0_required'),
    tick_array_1: text(sideCtx.tick_array_1, 'leg_request_resolver_orca_tick1_required'),
    tick_array_2: text(sideCtx.tick_array_2, 'leg_request_resolver_orca_tick2_required'),
    oracle: text(ctx.oracle, 'leg_request_resolver_orca_oracle_required'),
    amount: text(sideCtx.amount, 'leg_request_resolver_orca_amount_required'),
    other_amount_threshold: text(sideCtx.other_amount_threshold, 'leg_request_resolver_orca_threshold_required'),
    sqrt_price_limit: text(sideCtx.sqrt_price_limit, 'leg_request_resolver_orca_sqrt_limit_required'),
    amount_specified_is_input: sideCtx.amount_specified_is_input === true,
    a_to_b: sideCtx.a_to_b === true
  });
}

function resolveRaydium(route, input, accounts) {
  const ctx = route.instruction_context;
  const sideCtx = ctx[String(input.side || '').toLowerCase()];
  if (!sideCtx || typeof sideCtx !== 'object') throw new Error('leg_request_resolver_raydium_side_context_required');
  const poolType = text(ctx.pool_type, 'leg_request_resolver_raydium_pool_type_required').toUpperCase();
  const base = {
    ...common(route, input),
    pool_type: poolType,
    program_id: text(ctx.program_id, 'leg_request_resolver_raydium_program_required'),
    payer: simulationAccount(accounts, 'payer', 'leg_request_resolver_raydium_payer_required'),
    user_input_account: simulationAccount(accounts, String(input.side).toUpperCase() === 'BUY' ? 'quote_account' : 'token_account', 'leg_request_resolver_raydium_user_input_required'),
    user_output_account: simulationAccount(accounts, String(input.side).toUpperCase() === 'BUY' ? 'token_account' : 'quote_account', 'leg_request_resolver_raydium_user_output_required'),
    input_vault: text(sideCtx.input_vault, 'leg_request_resolver_raydium_input_vault_required'),
    output_vault: text(sideCtx.output_vault, 'leg_request_resolver_raydium_output_vault_required'),
    input_mint: text(sideCtx.input_mint, 'leg_request_resolver_raydium_input_mint_required'),
    output_mint: text(sideCtx.output_mint, 'leg_request_resolver_raydium_output_mint_required'),
    observation_id: text(ctx.observation_id, 'leg_request_resolver_raydium_observation_required'),
    amount_in: text(sideCtx.amount_in, 'leg_request_resolver_raydium_amount_in_required'),
    amount_out_min: text(sideCtx.amount_out_min, 'leg_request_resolver_raydium_amount_out_min_required')
  };
  if (poolType === 'CPMM') {
    return Object.freeze({
      ...base,
      authority: text(ctx.authority, 'leg_request_resolver_raydium_authority_required'),
      config_id: text(ctx.config_id, 'leg_request_resolver_raydium_config_required'),
      input_token_program: text(sideCtx.input_token_program, 'leg_request_resolver_raydium_input_program_required'),
      output_token_program: text(sideCtx.output_token_program, 'leg_request_resolver_raydium_output_program_required')
    });
  }
  if (poolType === 'CLMM') {
    if (!Array.isArray(sideCtx.tick_arrays) || !sideCtx.tick_arrays.length) throw new Error('leg_request_resolver_raydium_tick_arrays_required');
    return Object.freeze({
      ...base,
      amm_config: text(ctx.amm_config, 'leg_request_resolver_raydium_amm_config_required'),
      tick_arrays: Object.freeze(sideCtx.tick_arrays.map(value => text(value, 'leg_request_resolver_raydium_tick_array_invalid'))),
      tick_array_bitmap_extension: sideCtx.tick_array_bitmap_extension ? text(sideCtx.tick_array_bitmap_extension, 'leg_request_resolver_raydium_bitmap_invalid') : undefined,
      sqrt_price_limit_x64: String(sideCtx.sqrt_price_limit_x64 ?? '0')
    });
  }
  throw new Error('leg_request_resolver_raydium_pool_type_unsupported');
}

export function createOrcaRaydiumLegRequestResolver({ simulationAccounts } = {}) {
  if (!simulationAccounts || typeof simulationAccounts !== 'object') throw new Error('leg_request_resolver_simulation_accounts_required');
  return async function resolve(input = {}) {
    assertBoundary(input);
    const side = String(input.side || '').toUpperCase();
    const dex = String(input.dex || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) throw new Error('leg_request_resolver_side_invalid');
    if (!['ORCA', 'RAYDIUM'].includes(dex)) throw new Error('leg_request_resolver_dex_invalid');
    const route = routeFor(input.opportunity, side);
    if (String(route.dex_id || '').toUpperCase() !== dex) throw new Error('leg_request_resolver_dex_mismatch');
    const accounts = simulationAccounts[dex.toLowerCase()];
    if (!accounts || typeof accounts !== 'object') throw new Error('leg_request_resolver_dex_accounts_required');
    return dex === 'ORCA' ? resolveOrca(route, { ...input, side }, accounts) : resolveRaydium(route, { ...input, side }, accounts);
  };
}

export const ORCA_RAYDIUM_LEG_REQUEST_RESOLVER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  requires_verified_instruction_context: true,
  requires_explicit_simulation_accounts: true,
  private_key_allowed: false,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
