import assert from 'node:assert/strict';
import { createCopyMandate, assertCopyMandateAllowsIntent, COPY_MANDATE_SCHEMA } from '../services/api/src/copy-mandate.mjs';

const base = {
  mandate_id: 'mandate-001',
  follower_user_id: 'follower-001',
  trader_id: 'trader-001',
  policy_type: 'FIXED_USD',
  value: 25,
  max_copy_amount_usd: 100,
  max_position_amount_usd: 250,
  status: 'ACTIVE',
  consent_version: 'copy-mandate-v1',
  consented_at: '2026-09-02T00:00:00.000Z'
};

const mandate = createCopyMandate(base);
assert.equal(mandate.schema, COPY_MANDATE_SCHEMA);
assert.equal(mandate.execution_mode, 'SHADOW');
assert.equal(mandate.execution_scope, 'INTENT_ONLY');
assert.equal(mandate.live_execution_authorized, false);
assert.equal(mandate.network_submission_authorized, false);
assert.equal(mandate.signer_required, false);
assert.equal(Object.isFrozen(mandate), true);
assert.equal(Object.isFrozen(mandate.policy), true);

const identityContext = {
  follower_user_id: base.follower_user_id,
  trader_id: base.trader_id
};
const allowed = assertCopyMandateAllowsIntent(mandate, identityContext);
assert.equal(allowed.allowed, true);
assert.equal(allowed.live_execution_authorized, false);

for (const [patch, error] of [
  [{ execution_mode: 'LIVE' }, 'copy_mandate_shadow_only'],
  [{ live_execution_authorized: true }, 'live_execution_forbidden'],
  [{ network_submission_authorized: true }, 'network_submission_forbidden'],
  [{ signer_required: true }, 'signer_forbidden'],
  [{ status: 'UNKNOWN' }, 'invalid_mandate_status'],
  [{ value: Number.POSITIVE_INFINITY }, 'invalid_policy_value'],
  [{ value: 0 }, 'invalid_policy_value'],
  [{ value: '25' }, 'invalid_policy_value'],
  [{ consented_at: 'not-a-date' }, 'invalid_consented_at']
]) {
  assert.throws(() => createCopyMandate({ ...base, ...patch }), new RegExp(error));
}

for (const status of ['PAUSED', 'REVOKED']) {
  const inactive = createCopyMandate({ ...base, status });
  assert.throws(() => assertCopyMandateAllowsIntent(inactive, identityContext), /copy_mandate_not_active/);
}

for (const missingContext of [undefined, null, {}, { follower_user_id: base.follower_user_id }, { trader_id: base.trader_id }]) {
  assert.throws(
    () => assertCopyMandateAllowsIntent(mandate, missingContext),
    /invalid_copy_mandate_context|invalid_context_follower_user_id|invalid_context_trader_id/
  );
}

assert.throws(
  () => assertCopyMandateAllowsIntent(mandate, { ...identityContext, follower_user_id: 'other-follower' }),
  /copy_mandate_follower_mismatch/
);
assert.throws(
  () => assertCopyMandateAllowsIntent(mandate, { ...identityContext, trader_id: 'other-trader' }),
  /copy_mandate_trader_mismatch/
);

const tampered = { ...mandate, live_execution_authorized: true };
assert.throws(() => assertCopyMandateAllowsIntent(tampered, identityContext), /live_execution_forbidden/);

console.log('Copy Mandate Regression: PASS');
