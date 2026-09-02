import assert from 'node:assert/strict';
import { evaluateAuthenticatedAutoTradeRoute } from '../services/api/src/autotrade-route-boundary.mjs';

const policyId = '11111111-1111-4111-8111-111111111111';
const row = Object.freeze({
  policy_id: policyId,
  follower_user_id: 'follower-1',
  trader_id: 'trader-1',
  enabled: true,
  status: 'ACTIVE',
  mode: 'SHADOW',
  live_execution_authorized: false,
  max_copy_amount_usd: '250.00',
  max_position_amount_usd: '1000.00',
  allocation_bps: 1500,
  max_slippage_bps: 80,
  max_daily_loss_bps: 300,
  stop_drawdown_bps: 1200,
  policy_type: 'FIXED_USD',
  policy_value: '100.00',
  consent_version: 'aether.copy_mandate.consent.v1',
  consented_at: '2026-09-02T00:00:00.000Z'
});

const assessment = Object.freeze({
  token_mint: 'TokenMint11111111111111111111111111111111',
  quality_score: 90,
  verdict: 'QUALIFIED',
  snapshot: Object.freeze({
    token_mint: 'TokenMint11111111111111111111111111111111',
    estimated_price_impact_bps: 20,
    sell_simulation_ok: true
  })
});

const runtimeRisk = Object.freeze({
  capital_limit_usd: 5000,
  available_capital_usd: 600,
  daily_realized_pnl_usd: 0,
  trades_today: 0,
  max_trades_per_day: 5,
  cooldown_seconds: 60,
  seconds_since_last_trade: 600,
  min_signal_score: 80,
  exit_quality_floor: 55,
  allowed_tokens: ['TokenMint11111111111111111111111111111111']
});

let mandateLookups = 0;
let assessmentResolutions = 0;
let riskResolutions = 0;
const mandateRepository = {
  async getByPolicyId(id) {
    mandateLookups += 1;
    assert.equal(id, policyId);
    return row;
  }
};
const resolveAssessment = async input => {
  assessmentResolutions += 1;
  assert.equal(input.assessment_id, 'assessment-1');
  assert.equal(input.snapshot, undefined);
  return { assessment_id: 'assessment-1', assessment };
};
const resolveRuntimeRisk = async context => {
  riskResolutions += 1;
  assert.equal(context.authenticated_follower_user_id, 'follower-1');
  assert.equal(context.policy_id, policyId);
  assert.equal(context.assessment, assessment);
  return runtimeRisk;
};

const result = await evaluateAuthenticatedAutoTradeRoute({
  session: { user_id: 'follower-1', primary_wallet: 'Wallet1111111111111111111111111111111111' },
  requestBody: { policy_id: policyId, assessment_id: 'assessment-1', position: {} },
  mandateRepository,
  resolveAssessment,
  resolveRuntimeRisk,
  liveEnabled: false
});

assert.equal(mandateLookups, 1);
assert.equal(assessmentResolutions, 1);
assert.equal(riskResolutions, 1);
assert.equal(result.schema, 'aether.autotrade.authenticated_route_boundary.v1');
assert.equal(result.assessment_id, 'assessment-1');
assert.equal(result.mandate_id, policyId);
assert.equal(result.trader_id, 'trader-1');
assert.equal(result.decision.mode, 'SHADOW');
assert.equal(result.execution_dispatched, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.signer_required, false);
assert.equal(result.audit_metadata.authenticated_follower_user_id, 'follower-1');
assert.equal(result.audit_metadata.caller_mandate_authority, false);
assert.equal(result.audit_metadata.caller_identity_authority, false);
assert.equal(result.audit_metadata.caller_runtime_risk_authority, false);

for (const [field, value] of [
  ['mandate', {}],
  ['follower_user_id', 'follower-1'],
  ['trader_id', 'trader-1'],
  ['runtime_risk', runtimeRisk],
  ['live_execution_authorized', false],
  ['network_submission_authorized', false],
  ['signer_required', false]
]) {
  await assert.rejects(
    evaluateAuthenticatedAutoTradeRoute({
      session: { user_id: 'follower-1' },
      requestBody: { policy_id: policyId, assessment_id: 'assessment-1', [field]: value },
      mandateRepository,
      resolveAssessment,
      resolveRuntimeRisk
    }),
    /invalid_autotrade_caller_authority/
  );
}

await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: null,
    requestBody: { policy_id: policyId, assessment_id: 'assessment-1' },
    mandateRepository,
    resolveAssessment,
    resolveRuntimeRisk
  }),
  /authenticated_session_required/
);
await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: ' follower-1 ' },
    requestBody: { policy_id: policyId, assessment_id: 'assessment-1' },
    mandateRepository,
    resolveAssessment,
    resolveRuntimeRisk
  }),
  /invalid_authenticated_session_user_id/
);
await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: 'follower-1' },
    requestBody: { policy_id: 'not-a-uuid', assessment_id: 'assessment-1' },
    mandateRepository,
    resolveAssessment,
    resolveRuntimeRisk
  }),
  /invalid_policy_id/
);
await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: 'follower-1' },
    requestBody: { policy_id: policyId, assessment_id: 'assessment-1' },
    mandateRepository,
    resolveAssessment,
    resolveRuntimeRisk,
    liveEnabled: true
  }),
  /autotrade_live_blocked/
);

console.log('authenticated autotrade route boundary regression: ok');
