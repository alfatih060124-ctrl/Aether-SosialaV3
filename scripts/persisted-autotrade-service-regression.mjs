import assert from 'node:assert/strict';
import { evaluatePersistedCopyMandateAutoTrade } from '../services/api/src/persisted-autotrade-service.mjs';

const row = Object.freeze({
  policy_id: '11111111-1111-4111-8111-111111111111',
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

let lookups = 0;
const repository = {
  async getByPolicyId(policyId) {
    lookups += 1;
    assert.equal(policyId, row.policy_id);
    return row;
  }
};

const result = await evaluatePersistedCopyMandateAutoTrade({
  repository,
  authenticatedFollowerUserId: 'follower-1',
  policyId: row.policy_id,
  assessment,
  position: {},
  runtimeRisk,
  liveEnabled: false
});

assert.equal(lookups, 1);
assert.equal(result.schema, 'aether.autotrade.persisted_mandate_service.v1');
assert.equal(result.mandate_id, row.policy_id);
assert.equal(result.follower_user_id, 'follower-1');
assert.equal(result.trader_id, 'trader-1');
assert.equal(result.decision.mode, 'SHADOW');
assert.equal(result.decision.live_execution_authorized, false);
assert.equal(result.execution_dispatched, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.signer_required, false);
assert.equal(result.audit_metadata.authenticated_follower_user_id, 'follower-1');
assert.equal(result.audit_metadata.execution_scope, 'INTENT_ONLY');
assert.equal(result.audit_metadata.execution_dispatched, false);

await assert.rejects(
  evaluatePersistedCopyMandateAutoTrade({ repository, authenticatedFollowerUserId: 'other-follower', policyId: row.policy_id, assessment, runtimeRisk }),
  /copy_mandate_follower_mismatch/
);
await assert.rejects(
  evaluatePersistedCopyMandateAutoTrade({ repository, authenticatedFollowerUserId: 'follower-1', policyId: row.policy_id, assessment, runtimeRisk, liveEnabled: true }),
  /autotrade_live_blocked/
);
await assert.rejects(
  evaluatePersistedCopyMandateAutoTrade({ repository: { getByPolicyId: async () => null }, authenticatedFollowerUserId: 'follower-1', policyId: row.policy_id, assessment, runtimeRisk }),
  /copy_mandate_not_found/
);
await assert.rejects(
  evaluatePersistedCopyMandateAutoTrade({ repository, authenticatedFollowerUserId: ' follower-1 ', policyId: row.policy_id, assessment, runtimeRisk }),
  /invalid_authenticated_follower_user_id/
);
await assert.rejects(
  evaluatePersistedCopyMandateAutoTrade({ repository: null, authenticatedFollowerUserId: 'follower-1', policyId: row.policy_id, assessment, runtimeRisk }),
  /copy_mandate_runtime_repository_required/
);

console.log('persisted-autotrade-service regression: ok');
