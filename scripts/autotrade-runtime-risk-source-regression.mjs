import assert from 'node:assert/strict';
import { resolveBackendRuntimeRisk } from '../services/api/src/autotrade-runtime-risk-source.mjs';

const follower = 'user-123';
const policy = '11111111-1111-4111-8111-111111111111';
const now = () => new Date('2026-09-03T02:00:00.000Z');
const baseSnapshot = Object.freeze({
  schema: 'aether.autotrade.runtime_risk_snapshot.v1',
  source: 'BACKEND_PERSISTED',
  authoritative: true,
  authenticated_follower_user_id: follower,
  policy_id: policy,
  observed_at: '2026-09-03T01:59:30.000Z',
  capital_limit_usd: 1000,
  available_capital_usd: 800,
  daily_realized_pnl_usd: -10,
  trades_today: 2,
  max_trades_per_day: 20,
  cooldown_seconds: 60,
  seconds_since_last_trade: 120,
  min_signal_score: 70,
  exit_quality_floor: 50,
  allowed_tokens: ['SOL', 'USDC'],
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false
});

async function expectError(fn, message) {
  await assert.rejects(fn, (error) => error?.message === message);
}

let calls = 0;
const repository = {
  async getRuntimeRiskSnapshot(input) {
    calls += 1;
    assert.equal(input.authenticated_follower_user_id, follower);
    assert.equal(input.policy_id, policy);
    assert.equal(input.assessment.signal, 'BUY');
    assert.deepEqual(input.position, { token: 'SOL' });
    return baseSnapshot;
  }
};

const risk = await resolveBackendRuntimeRisk({
  repository,
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  position: { token: 'SOL' },
  now
});
assert.equal(calls, 1);
assert.equal(risk.capital_limit_usd, 1000);
assert.equal(risk.available_capital_usd, 800);
assert.equal(risk.audit_metadata.caller_runtime_risk_authority, false);
assert.equal(risk.audit_metadata.execution_dispatched, false);
assert.equal(risk.audit_metadata.live_execution_authorized, false);
assert.equal(risk.audit_metadata.network_submission_authorized, false);
assert.equal(risk.audit_metadata.signer_required, false);

let malformedLookupCalls = 0;
await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { malformedLookupCalls += 1; return baseSnapshot; } },
  authenticatedFollowerUserId: follower,
  policyId: 'not-a-uuid',
  assessment: { signal: 'BUY' },
  now
}), 'invalid_policy_id');
assert.equal(malformedLookupCalls, 0);

await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { return { ...baseSnapshot, source: 'CALLER' }; } },
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  now
}), 'runtime_risk_source_not_authoritative');

await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { return { ...baseSnapshot, authenticated_follower_user_id: 'other-user' }; } },
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  now
}), 'runtime_risk_identity_binding_mismatch');

await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { return { ...baseSnapshot, observed_at: '2026-09-03T01:58:00.000Z' }; } },
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  now
}), 'runtime_risk_snapshot_stale');

await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { return { ...baseSnapshot, live_execution_authorized: true }; } },
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  now
}), 'runtime_risk_shadow_invariant_failed');

await expectError(() => resolveBackendRuntimeRisk({
  repository: { async getRuntimeRiskSnapshot() { return { ...baseSnapshot, available_capital_usd: 1200 }; } },
  authenticatedFollowerUserId: follower,
  policyId: policy,
  assessment: { signal: 'BUY' },
  now
}), 'available_capital_exceeds_capital_limit');

console.log('Auto Trade Runtime Risk Source Regression: PASS');
