import assert from 'node:assert/strict';
import { persistAuthenticatedAutoTradeDecisionAtomically } from '../services/api/src/autotrade-atomic-persistence.mjs';

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
  snapshot: {
    token_mint: 'TokenMint11111111111111111111111111111111',
    estimated_price_impact_bps: 20,
    sell_simulation_ok: true
  }
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

function makePool({ failAudit = false } = {}) {
  const commands = [];
  let released = false;
  let decisionWrites = 0;
  let auditWrites = 0;
  const client = {
    async query(sql) {
      commands.push(sql);
      return { rows: [] };
    },
    release() { released = true; }
  };
  const pool = { async connect() { return client; } };
  const factories = {
    createMandateRepository(seenClient) {
      assert.equal(seenClient, client);
      return { async getByPolicyId(id) { assert.equal(id, policyId); return row; } };
    },
    createSignalRepository(seenClient) {
      assert.equal(seenClient, client);
      return {
        async recordDecision() {
          decisionWrites += 1;
          return { decision_id: 'decision-1' };
        }
      };
    },
    createAuditRepository(seenClient) {
      assert.equal(seenClient, client);
      return {
        async append() {
          auditWrites += 1;
          if (failAudit) throw new Error('synthetic_audit_failure');
          return { audit_id: 'audit-1' };
        }
      };
    }
  };
  return {
    pool,
    factories,
    state: () => ({ commands: [...commands], released, decisionWrites, auditWrites })
  };
}

const success = makePool();
const result = await persistAuthenticatedAutoTradeDecisionAtomically({
  pool: success.pool,
  session: { user_id: 'follower-1', primary_wallet: 'Wallet1111111111111111111111111111111111' },
  requestBody: { policy_id: policyId, assessment_id: 'assessment-1', position: {} },
  ...success.factories,
  resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }),
  resolveRuntimeRisk: async () => runtimeRisk,
  liveEnabled: false
});
assert.equal(result.schema, 'aether.autotrade.atomic_persistence.v1');
assert.equal(result.decision_audit_atomic, true);
assert.equal(result.execution_dispatched, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.signer_required, false);
assert.deepEqual(success.state().commands, ['BEGIN', 'COMMIT']);
assert.equal(success.state().decisionWrites, 1);
assert.equal(success.state().auditWrites, 1);
assert.equal(success.state().released, true);

const auditFailure = makePool({ failAudit: true });
await assert.rejects(
  persistAuthenticatedAutoTradeDecisionAtomically({
    pool: auditFailure.pool,
    session: { user_id: 'follower-1' },
    requestBody: { policy_id: policyId, assessment_id: 'assessment-1' },
    ...auditFailure.factories,
    resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }),
    resolveRuntimeRisk: async () => runtimeRisk,
    liveEnabled: false
  }),
  /synthetic_audit_failure/
);
assert.deepEqual(auditFailure.state().commands, ['BEGIN', 'ROLLBACK']);
assert.equal(auditFailure.state().decisionWrites, 1);
assert.equal(auditFailure.state().auditWrites, 1);
assert.equal(auditFailure.state().released, true);

const rejectedCaller = makePool();
await assert.rejects(
  persistAuthenticatedAutoTradeDecisionAtomically({
    pool: rejectedCaller.pool,
    session: { user_id: 'follower-1' },
    requestBody: { policy_id: policyId, assessment_id: 'assessment-1', mandate: {} },
    ...rejectedCaller.factories,
    resolveAssessment: async () => ({ assessment_id: 'assessment-1', assessment }),
    resolveRuntimeRisk: async () => runtimeRisk,
    liveEnabled: false
  }),
  /invalid_autotrade_caller_authority/
);
assert.deepEqual(rejectedCaller.state().commands, ['BEGIN', 'ROLLBACK']);
assert.equal(rejectedCaller.state().decisionWrites, 0);
assert.equal(rejectedCaller.state().auditWrites, 0);
assert.equal(rejectedCaller.state().released, true);

await assert.rejects(
  persistAuthenticatedAutoTradeDecisionAtomically({ pool: {} }),
  /autotrade_transaction_pool_required/
);

console.log('autotrade atomic persistence regression: ok');
