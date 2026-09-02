import assert from 'node:assert/strict';
import {
  hydratePersistedCopyMandate,
  assertPersistedCopyMandateAllowsIntent,
  createCopyMandateRuntimeRepository
} from '../services/api/src/copy-mandate-runtime.mjs';

const row = {
  policy_id: 'mandate-runtime-001',
  follower_user_id: 'follower-001',
  trader_id: 'trader-001',
  enabled: true,
  status: 'ACTIVE',
  mode: 'SHADOW',
  live_execution_authorized: false,
  max_copy_amount_usd: '100.00',
  max_position_amount_usd: '250.00',
  allocation_bps: 1000,
  max_slippage_bps: 100,
  max_daily_loss_bps: 300,
  stop_drawdown_bps: 1500,
  policy_type: 'FIXED_USD',
  policy_value: '25.00',
  consent_version: 'copy-mandate-v1',
  consented_at: '2026-09-02T00:00:00.000Z'
};

const context = { follower_user_id: row.follower_user_id, trader_id: row.trader_id };
const canonical = hydratePersistedCopyMandate(row);
assert.equal(canonical.schema, 'aether.copy_mandate.v1');
assert.equal(canonical.execution_mode, 'SHADOW');
assert.equal(canonical.execution_scope, 'INTENT_ONLY');
assert.equal(canonical.live_execution_authorized, false);
assert.equal(canonical.network_submission_authorized, false);
assert.equal(canonical.signer_required, false);

const authorized = assertPersistedCopyMandateAllowsIntent(row, context);
assert.equal(authorized.authorization.allowed, true);
assert.equal(authorized.execution_dispatched, false);
assert.equal(authorized.live_execution_authorized, false);
assert.equal(authorized.network_submission_authorized, false);
assert.equal(authorized.signer_required, false);

for (const [patch, error] of [
  [{ policy_type: null }, 'invalid_policy_type'],
  [{ policy_value: null }, 'invalid_policy_value'],
  [{ consent_version: null }, 'invalid_consent_version'],
  [{ consented_at: null }, 'invalid_consented_at'],
  [{ enabled: false }, 'copy_mandate_disabled'],
  [{ mode: 'LIVE' }, 'copy_mandate_shadow_only'],
  [{ live_execution_authorized: true }, 'live_execution_forbidden'],
  [{ max_position_amount_usd: '50.00' }, 'copy_mandate_position_limit_below_copy_limit']
]) {
  assert.throws(() => hydratePersistedCopyMandate({ ...row, ...patch }), new RegExp(error));
}

assert.throws(
  () => assertPersistedCopyMandateAllowsIntent({ ...row, status: 'PAUSED', enabled: false }, context),
  /copy_mandate_not_active/
);
assert.throws(
  () => assertPersistedCopyMandateAllowsIntent({ ...row, status: 'CANCELLED', enabled: false }, context),
  /copy_mandate_not_active/
);
assert.throws(
  () => assertPersistedCopyMandateAllowsIntent(row, { ...context, follower_user_id: 'other-follower' }),
  /copy_mandate_follower_mismatch/
);
assert.throws(
  () => assertPersistedCopyMandateAllowsIntent(row, { ...context, trader_id: 'other-trader' }),
  /copy_mandate_trader_mismatch/
);
assert.throws(() => assertPersistedCopyMandateAllowsIntent(row), /invalid_copy_mandate_context/);

const queries = [];
const repository = createCopyMandateRuntimeRepository({
  async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [row] };
  }
});
const loaded = await repository.getByPolicyId(row.policy_id);
assert.equal(loaded.policy_id, row.policy_id);
assert.deepEqual(queries[0].params, [row.policy_id]);
assert.match(queries[0].sql, /WHERE policy_id=\$1/);
assert.doesNotMatch(queries[0].sql, /follower_user_id=\$1/);
await assert.rejects(() => repository.getByPolicyId(''), /policy_id_required/);

console.log('Copy Mandate Runtime Regression: PASS');
