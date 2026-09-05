import assert from 'node:assert/strict';
import { evaluateAuthenticatedAutoTradeRoute } from '../services/api/src/autotrade-route-boundary.mjs';

const policyId = '11111111-1111-4111-8111-111111111111';
const assessmentId = '22222222-2222-4222-8222-222222222222';
const followerUserId = 'follower-user-1';

const persistedRow = Object.freeze({
  policy_id: policyId,
  follower_user_id: followerUserId,
  trader_id: 'trader-1',
  enabled: true,
  status: 'ACTIVE',
  mode: 'SHADOW',
  live_execution_authorized: false,
  max_copy_amount_usd: '100.00',
  max_position_amount_usd: '1000.00',
  allocation_bps: 1000,
  max_slippage_bps: 100,
  max_daily_loss_bps: 200,
  stop_drawdown_bps: 500,
  policy_type: 'FIXED_USD',
  policy_value: '50.00',
  consent_version: 'aether.copy_mandate.consent.v1',
  consented_at: '2026-09-03T15:00:00.000Z',
  trader_status: 'ACTIVE',
  trader_verified: true,
  trader_mode: 'SHADOW',
  trader_onboarding_status: 'APPROVED',
  trader_verification_status: 'VERIFIED',
  trader_published: true
});

const assessment = Object.freeze({
  token_mint: 'So11111111111111111111111111111111111111112',
  verdict: 'QUALIFIED',
  quality_score: 99,
  snapshot: Object.freeze({
    token_mint: 'So11111111111111111111111111111111111111112',
    estimated_price_impact_bps: 10,
    sell_simulation_ok: true
  })
});

const result = await evaluateAuthenticatedAutoTradeRoute({
  session: { user_id: followerUserId },
  requestBody: { policy_id: policyId, assessment_id: assessmentId },
  mandateRepository: {
    async getByPolicyId(id) {
      assert.equal(id, policyId);
      return persistedRow;
    }
  },
  async resolveAssessment({ assessment_id }) {
    assert.equal(assessment_id, assessmentId);
    return { assessment_id: assessmentId, assessment };
  },
  async resolveRuntimeRisk() {
    return {
      capital_limit_usd: 1000,
      available_capital_usd: 1000,
      daily_realized_pnl_usd: 0,
      trades_today: 0,
      max_trades_per_day: 6,
      cooldown_seconds: 0,
      seconds_since_last_trade: 31536000,
      min_signal_score: 82,
      exit_quality_floor: 55,
      allowed_tokens: [assessment.token_mint],
      risk_metadata: {
        risk_source: 'SESSION_WALLET_USDC_AND_DECISION_HISTORY',
        base_currency: 'USDC',
        daily_pnl_accounting_ready: false,
        read_only: true,
        non_custodial: true,
        live_execution_authorized: false,
        network_submission_authorized: false,
        signer_required: false
      }
    };
  },
  liveEnabled: false
});

assert.equal(result.execution_dispatched, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.signer_required, false);
assert.equal(result.audit_metadata.runtime_risk_daily_pnl_accounting_ready, false);
assert.notEqual(
  result.decision?.action,
  'BUY',
  'Auto Trade must fail closed for new BUY intent while trusted daily PnL accounting is not ready'
);

console.log('Auto Trade daily PnL readiness regression passed');
