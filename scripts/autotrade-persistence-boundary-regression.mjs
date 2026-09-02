import assert from 'node:assert/strict';
import { persistAuthenticatedAutoTradeDecision } from '../services/api/src/autotrade-persistence-boundary.mjs';

const policyId = '11111111-1111-4111-8111-111111111111';
const row = {
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
};
const assessment = {
  token_mint: 'TokenMint11111111111111111111111111111111',
  quality_score: 90,
  verdict: 'QUALIFIED',
  snapshot: { token_mint: 'TokenMint11111111111111111111111111111111', estimated_price_impact_bps: 20, sell_simulation_ok: true }
};
const runtimeRisk = {
  capital_limit_usd: 5000,
  available_capital_usd: 600,
  daily_realized_pnl_usd: 0,
  trades_today: 0,
  max_trades_per_day: 5,
  cooldown_seconds: 60,
  seconds_since_last_trade: 600,
  min_signal_score: 80,
  exit_quality_floor: 55,
  allowed_tokens: [assessment.token_mint]
};
let persistedInput;
let auditInput;
const result = await persistAuthenticatedAutoTradeDecision({
  session: { user_id: 'follower-1', primary_wallet: 'Wallet1111111111111111111111111111111111' },
  requestBody: { policy_id: policyId, assessment_id: 'assessment-1', position: {} },
  mandateRepository: { async getByPolicyId(id) { assert.equal(id, policyId); return row; } },
  signalRepository: { async recordDecision(input) { persistedInput = input; return { decision_id: 'decision-1' }; } },
  auditRepository: { async append(input) { auditInput = input; return { audit_id: 'audit-1' }; } },
  resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }),
  resolveRuntimeRisk: async () => runtimeRisk,
  liveEnabled: false
});

assert.equal(result.schema, 'aether.autotrade.persistence_boundary.v1');
assert.equal(result.decision_id, 'decision-1');
assert.equal(result.execution_dispatched, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.signer_required, false);
assert.equal(persistedInput.mandate.schema, 'aether.copy_mandate.persistence_reference.v1');
assert.equal(persistedInput.mandate.mandate_id, policyId);
assert.equal(persistedInput.mandate.caller_authority, false);
assert.equal(auditInput.event_type, 'AUTOTRADE_SHADOW_DECISION');
assert.equal(auditInput.payload.mandate_id, policyId);
assert.equal(auditInput.payload.authenticated_follower_user_id, 'follower-1');
assert.equal(auditInput.payload.caller_mandate_authority, false);
assert.equal(auditInput.payload.caller_identity_authority, false);
assert.equal(auditInput.payload.caller_runtime_risk_authority, false);
assert.equal(auditInput.payload.execution_dispatched, false);
assert.equal(auditInput.payload.live_execution_authorized, false);
assert.equal(auditInput.payload.network_submission_authorized, false);
assert.equal(auditInput.payload.signer_required, false);

await assert.rejects(
  persistAuthenticatedAutoTradeDecision({
    session: { user_id: 'follower-1' }, requestBody: { policy_id: policyId, assessment_id: 'assessment-1' },
    mandateRepository: { async getByPolicyId() { return row; } }, signalRepository: {}, auditRepository: { append() {} },
    resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }), resolveRuntimeRisk: async () => runtimeRisk
  }), /autotrade_decision_repository_required/
);
await assert.rejects(
  persistAuthenticatedAutoTradeDecision({
    session: { user_id: 'follower-1' }, requestBody: { policy_id: policyId, assessment_id: 'assessment-1', mandate: {} },
    mandateRepository: { async getByPolicyId() { return row; } }, signalRepository: { recordDecision() {} }, auditRepository: { append() {} },
    resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }), resolveRuntimeRisk: async () => runtimeRisk
  }), /invalid_autotrade_caller_authority/
);

console.log('autotrade persistence boundary regression: ok');
