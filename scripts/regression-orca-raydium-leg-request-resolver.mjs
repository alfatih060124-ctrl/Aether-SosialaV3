import assert from 'node:assert/strict';
import { createOrcaRaydiumLegRequestResolver, ORCA_RAYDIUM_LEG_REQUEST_RESOLVER } from '../services/api/src/orca-raydium-leg-request-resolver.mjs';

const simulationAccounts = Object.freeze({
  orca: Object.freeze({
    authority: 'ORCA_AUTH',
    token_owner_account_a: 'ORCA_OWNER_A',
    token_owner_account_b: 'ORCA_OWNER_B'
  }),
  raydium: Object.freeze({
    payer: 'RAY_PAYER',
    token_account: 'RAY_TOKEN_ACCOUNT',
    quote_account: 'RAY_QUOTE_ACCOUNT'
  })
});

const resolver = createOrcaRaydiumLegRequestResolver({ simulationAccounts });

const opportunity = Object.freeze({
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  read_only: true,
  live_execution_authorized: false,
  buy_route: Object.freeze({
    dex_id: 'orca',
    pool_address: 'ORCA_POOL',
    quote_verified: true,
    costs_verified: true,
    observed_slot: 100,
    observed_at: '2026-09-06T00:00:00.000Z',
    instruction_context: Object.freeze({
      verified: true,
      source_slot: 100,
      observed_at: '2026-09-06T00:00:00.000Z',
      token_program: 'TOKEN_PROGRAM',
      token_vault_a: 'ORCA_VAULT_A',
      token_vault_b: 'ORCA_VAULT_B',
      oracle: 'ORCA_ORACLE',
      buy: Object.freeze({
        tick_array_0: 'TICK0', tick_array_1: 'TICK1', tick_array_2: 'TICK2',
        amount: '1000', other_amount_threshold: '900', sqrt_price_limit: '0',
        amount_specified_is_input: true, a_to_b: false
      })
    })
  }),
  sell_route: Object.freeze({
    dex_id: 'raydium',
    pool_address: 'RAY_POOL',
    quote_verified: true,
    costs_verified: true,
    observed_slot: 101,
    observed_at: '2026-09-06T00:00:01.000Z',
    instruction_context: Object.freeze({
      verified: true,
      source_slot: 101,
      observed_at: '2026-09-06T00:00:01.000Z',
      pool_type: 'CPMM',
      program_id: 'RAY_PROGRAM',
      authority: 'RAY_AUTHORITY',
      config_id: 'RAY_CONFIG',
      observation_id: 'RAY_OBSERVATION',
      sell: Object.freeze({
        input_vault: 'RAY_TOKEN_VAULT', output_vault: 'RAY_USDC_VAULT',
        input_mint: 'TOKEN', output_mint: 'USDC',
        input_token_program: 'TOKEN_PROGRAM', output_token_program: 'TOKEN_PROGRAM',
        amount_in: '500', amount_out_min: '490'
      })
    })
  })
});

const orca = await resolver({ opportunity, side: 'BUY', dex: 'ORCA', read_only: true, strategy: 'TWO_LEG_ARBITRAGE' });
assert.equal(orca.pool_address, 'ORCA_POOL');
assert.equal(orca.token_authority, 'ORCA_AUTH');
assert.equal(orca.token_vault_a, 'ORCA_VAULT_A');
assert.equal(orca.tick_array_2, 'TICK2');
assert.equal(orca.source_slot, 100);

const raydium = await resolver({ opportunity, side: 'SELL', dex: 'RAYDIUM', read_only: true, strategy: 'TWO_LEG_ARBITRAGE' });
assert.equal(raydium.pool_type, 'CPMM');
assert.equal(raydium.payer, 'RAY_PAYER');
assert.equal(raydium.user_input_account, 'RAY_TOKEN_ACCOUNT');
assert.equal(raydium.user_output_account, 'RAY_QUOTE_ACCOUNT');
assert.equal(raydium.amount_in, '500');
assert.equal(raydium.source_slot, 101);

await assert.rejects(
  () => resolver({ opportunity, side: 'BUY', dex: 'RAYDIUM', read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /leg_request_resolver_dex_mismatch/
);

const unverified = { ...opportunity, buy_route: { ...opportunity.buy_route, instruction_context: { ...opportunity.buy_route.instruction_context, verified: false } } };
await assert.rejects(
  () => resolver({ opportunity: unverified, side: 'BUY', dex: 'ORCA', read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /leg_request_resolver_instruction_context_unverified/
);

const live = { ...opportunity, live_execution_authorized: true };
await assert.rejects(
  () => resolver({ opportunity: live, side: 'BUY', dex: 'ORCA', read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /leg_request_resolver_live_boundary_violation/
);

assert.equal(ORCA_RAYDIUM_LEG_REQUEST_RESOLVER.requires_verified_instruction_context, true);
assert.equal(ORCA_RAYDIUM_LEG_REQUEST_RESOLVER.requires_explicit_simulation_accounts, true);
assert.equal(ORCA_RAYDIUM_LEG_REQUEST_RESOLVER.live_execution_authorized, false);
assert.equal(ORCA_RAYDIUM_LEG_REQUEST_RESOLVER.network_submission_authorized, false);

console.log('orca raydium leg request resolver regression: ok');
