import assert from 'node:assert/strict';
import { createTrustedAutoTradePositionResolver } from '../services/api/src/trusted-autotrade-position.mjs';
import { evaluateAuthenticatedAutoTradeRoute } from '../services/api/src/autotrade-route-boundary.mjs';
import { handleMemberAutoTradeRoute } from '../services/api/src/member-autotrade-route.mjs';

const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const POLICY = '22222222-2222-4222-8222-222222222222';
const TRADER = '33333333-3333-4333-8333-333333333333';
const ASSESSMENT = '44444444-4444-4444-8444-444444444444';
const POSITION = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'TokenMint111111111111111111111111111111111';
const NOW = new Date('2026-09-04T06:00:00.000Z');

const assessment = Object.freeze({
  assessment_id: ASSESSMENT,
  token_mint: TOKEN,
  quote_mint: 'USDC',
  quality_score: 90,
  verdict: 'QUALIFIED',
  hard_rejects: [],
  components: {},
  snapshot: {
    current_price_usdc: 90,
    estimated_price_impact_bps: 10,
    sell_simulation_ok: true,
    momentum_5m_bps: 0,
    momentum_1h_bps: 0
  },
  observed_at: NOW.toISOString(),
  live_execution_authorized: false,
  quality_first: true
});

const positionRow = {
  position_id: POSITION,
  policy_id: POLICY,
  trader_id: TRADER,
  token_mint: TOKEN,
  quote_mint: 'USDC',
  status: 'OPEN',
  token_quantity: '1',
  cost_basis_usdc: '100',
  realized_pnl_usdc: '0',
  last_mark_price_usdc: '110',
  mark_observed_at: '2026-09-04T05:59:55.000Z',
  opened_at: '2026-09-04T05:50:00.000Z',
  updated_at: '2026-09-04T05:59:55.000Z'
};
const readyState = {
  follower_user_id: FOLLOWER,
  accounting_ready: true,
  complete_through: '2026-09-04T05:59:55.000Z',
  source_version: 'shadow-lifecycle-v1',
  mode: 'SHADOW',
  live_execution_authorized: false
};

{
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM follower_shadow_positions')) return { rows: [positionRow] };
    if (sql.includes('FROM follower_shadow_accounting_state')) return { rows: [readyState] };
    throw new Error('unexpected_query');
  }};
  const resolve = createTrustedAutoTradePositionResolver({ pool, now: () => new Date(NOW) });
  const position = await resolve({ authenticated_follower_user_id: FOLLOWER, policy_id: POLICY, assessment });
  assert.equal(position.position_id, POSITION);
  assert.equal(position.position_value_usd, 90);
  assert.equal(position.entry_price_usd, 100);
  assert.equal(position.current_price_usd, 90);
  assert.equal(position.peak_price_usd, 110);
  assert.equal(Math.round(position.unrealized_pnl_bps), -1000);
  assert.equal(position.caller_authority, false);
  assert.equal(position.live_execution_authorized, false);
  assert.equal(calls.length, 2);
}

{
  const pool = { query: async sql => sql.includes('FROM follower_shadow_positions') ? { rows: [] } : (() => { throw new Error('accounting_state_must_not_be_needed_without_position'); })() };
  const resolve = createTrustedAutoTradePositionResolver({ pool, now: () => new Date(NOW) });
  assert.deepEqual(await resolve({ authenticated_follower_user_id: FOLLOWER, policy_id: POLICY, assessment }), {});
}

{
  const pool = { query: async sql => sql.includes('FROM follower_shadow_positions') ? { rows: [positionRow, { ...positionRow, position_id: '66666666-6666-4666-8666-666666666666' }] } : { rows: [readyState] } };
  const resolve = createTrustedAutoTradePositionResolver({ pool, now: () => new Date(NOW) });
  await assert.rejects(() => resolve({ authenticated_follower_user_id: FOLLOWER, policy_id: POLICY, assessment }), /trusted_position_ambiguous/);
}

{
  const pool = { query: async sql => sql.includes('FROM follower_shadow_positions') ? { rows: [positionRow] } : { rows: [{ ...readyState, complete_through: '2026-09-04T05:00:00.000Z' }] } };
  const resolve = createTrustedAutoTradePositionResolver({ pool, now: () => new Date(NOW) });
  await assert.rejects(() => resolve({ authenticated_follower_user_id: FOLLOWER, policy_id: POLICY, assessment }), /trusted_position_accounting_not_ready/);
}

const persistedMandate = {
  policy_id: POLICY,
  follower_user_id: FOLLOWER,
  trader_id: TRADER,
  enabled: true,
  status: 'ACTIVE',
  mode: 'SHADOW',
  live_execution_authorized: false,
  max_copy_amount_usd: '25',
  max_position_amount_usd: '100',
  allocation_bps: 1000,
  max_slippage_bps: 100,
  max_daily_loss_bps: 300,
  stop_drawdown_bps: 500,
  policy_type: 'FIXED_USD',
  policy_value: '25',
  consent_version: 'aether.copy_mandate.consent.v1',
  consented_at: '2026-09-04T05:00:00.000Z',
  trader_status: 'ACTIVE',
  trader_verified: true,
  trader_mode: 'SHADOW',
  trader_onboarding_status: 'APPROVED',
  trader_verification_status: 'VERIFIED',
  trader_published: true
};
const runtimeRisk = {
  capital_limit_usd: 100,
  available_capital_usd: 100,
  daily_realized_pnl_usd: 0,
  trades_today: 0,
  max_trades_per_day: 100,
  cooldown_seconds: 0,
  seconds_since_last_trade: 86400,
  min_signal_score: 82,
  exit_quality_floor: 55,
  allowed_tokens: [TOKEN],
  risk_metadata: { daily_pnl_accounting_ready: true, risk_source: 'TEST_TRUSTED_BACKEND', base_currency: 'USDC' }
};

{
  let riskPosition;
  const result = await evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: FOLLOWER },
    requestBody: { policy_id: POLICY, assessment_id: ASSESSMENT },
    mandateRepository: { getByPolicyId: async () => persistedMandate },
    resolveAssessment: async () => ({ assessment_id: ASSESSMENT, assessment }),
    resolvePosition: async () => ({
      position_id: POSITION, policy_id: POLICY, trader_id: TRADER, token_mint: TOKEN, status: 'OPEN',
      position_value_usd: 90, entry_price_usd: 100, current_price_usd: 90, peak_price_usd: 110,
      unrealized_pnl_bps: -1000, source: 'BACKEND_FOLLOWER_SHADOW_POSITION_ACCOUNTING', caller_authority: false,
      mode: 'SHADOW', live_execution_authorized: false, network_submission_authorized: false, signer_required: false
    }),
    resolveRuntimeRisk: async context => { riskPosition = context.position; return runtimeRisk; },
    liveEnabled: false
  });
  assert.equal(riskPosition.position_id, POSITION);
  assert.equal(result.position_reference.position_id, POSITION);
  assert.equal(result.decision.action, 'SELL');
  assert.ok(result.decision.reason_codes.includes('STOP_LOSS'));
  assert.equal(result.execution_dispatched, false);
  assert.equal(result.live_execution_authorized, false);
}

await assert.rejects(() => evaluateAuthenticatedAutoTradeRoute({
  session: { user_id: FOLLOWER },
  requestBody: { policy_id: POLICY, assessment_id: ASSESSMENT, position: { position_id: POSITION } },
  mandateRepository: { getByPolicyId: async () => persistedMandate },
  resolveAssessment: async () => ({ assessment_id: ASSESSMENT, assessment }),
  resolvePosition: async () => ({}),
  resolveRuntimeRisk: async () => runtimeRisk,
  liveEnabled: false
}), /invalid_autotrade_caller_authority/);

{
  const sent = [];
  let lifecycleInput = null;
  let resolverCalled = false;
  const req = { method: 'POST' };
  const res = {};
  const handled = await handleMemberAutoTradeRoute({
    req,
    res,
    route: '/api/account/autotrade/evaluate',
    pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error('not_used'); } },
    repos: { signalIntelligence: { getAssessment: async () => assessment } },
    walletAuth: {},
    sessionFor: async () => ({ user_id: FOLLOWER, primary_wallet: 'wallet-test' }),
    jsonBody: async () => ({ policy_id: POLICY, assessment_id: ASSESSMENT }),
    send: (_res, status, body) => sent.push({ status, body }),
    executionMode: 'SHADOW',
    liveEnabled: false,
    walletPortfolio: {},
    assessmentProjection: row => row,
    createRiskResolver: () => async () => runtimeRisk,
    createPositionResolver: () => async () => { resolverCalled = true; return { position_id: POSITION, mode: 'SHADOW', live_execution_authorized: false }; },
    persistDecision: async args => {
      const resolved = await args.resolvePosition({ authenticated_follower_user_id: FOLLOWER, policy_id: POLICY, assessment });
      assert.equal(resolved.position_id, POSITION);
      return {
        decision_id: '77777777-7777-4777-8777-777777777777', assessment_id: ASSESSMENT, mandate_id: POLICY, trader_id: TRADER,
        assessment, decision: { action: 'HOLD', mode: 'SHADOW', live_execution_authorized: false, reason_codes: ['POSITION_HEALTHY'], requested_amount_usd: 0 },
        position_reference: { position_id: POSITION, policy_id: POLICY, trader_id: TRADER, token_mint: TOKEN, status: 'OPEN', mode: 'SHADOW', live_execution_authorized: false },
        execution_dispatched: false, live_execution_authorized: false, network_submission_authorized: false, signer_required: false
      };
    },
    createLifecycleBridge: () => ({ applyDecision: async input => { lifecycleInput = input; return { position_id: POSITION, mark_price_usdc: 90, mode: 'SHADOW', live_execution_authorized: false }; } })
  });
  assert.equal(handled, true);
  assert.equal(resolverCalled, true);
  assert.equal(lifecycleInput.position.position_id, POSITION);
  assert.equal(lifecycleInput.mandate.follower_user_id, FOLLOWER);
  assert.equal(lifecycleInput.context.liveEnabled, false);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.lifecycle_applied, true);
  assert.equal(sent[0].body.execution_dispatched, false);
  assert.equal(sent[0].body.live_execution_authorized, false);
}

console.log(JSON.stringify({ ok: true, contract: 'member-autotrade-trusted-position-lifecycle', mode: 'SHADOW', caller_position_authority: false, live_execution_authorized: false }));
