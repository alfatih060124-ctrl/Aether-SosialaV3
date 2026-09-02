import assert from 'node:assert/strict';
import { buildAutoTradeMandateFromPersisted } from '../services/api/src/copy-mandate-autotrade-adapter.mjs';
import { evaluateAutoTrade } from '../services/api/src/auto-trade-engine.mjs';

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

const adapted = buildAutoTradeMandateFromPersisted(row, 'follower-1', runtimeRisk);
assert.equal(adapted.schema, 'aether.autotrade.persisted_mandate_adapter.v1');
assert.equal(adapted.authorization.allowed, true);
assert.equal(adapted.engine_mandate.mode, 'SHADOW');
assert.equal(adapted.engine_mandate.capital_limit_usd, 1000);
assert.equal(adapted.engine_mandate.available_capital_usd, 600);
assert.equal(adapted.engine_mandate.max_trade_usd, 100);
assert.equal(adapted.engine_mandate.max_allocation_bps, 1500);
assert.equal(adapted.engine_mandate.max_slippage_bps, 80);
assert.equal(adapted.engine_mandate.max_daily_loss_usd, 30);
assert.equal(adapted.execution_dispatched, false);
assert.equal(adapted.live_execution_authorized, false);
assert.equal(adapted.network_submission_authorized, false);
assert.equal(adapted.signer_required, false);
assert.equal(adapted.audit_metadata.execution_scope, 'INTENT_ONLY');

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
const decision = evaluateAutoTrade({ assessment, mandate: adapted.engine_mandate, position: {}, runtime: { liveEnabled: false } });
assert.equal(decision.mode, 'SHADOW');
assert.equal(decision.live_execution_authorized, false);
assert.equal(decision.action, 'BUY');
assert.ok(decision.requested_amount_usd > 0 && decision.requested_amount_usd <= 100);

assert.throws(() => buildAutoTradeMandateFromPersisted(row, 'other-follower', runtimeRisk), /copy_mandate_follower_mismatch/);
assert.throws(() => buildAutoTradeMandateFromPersisted({ ...row, live_execution_authorized: true }, 'follower-1', runtimeRisk), /live_execution_forbidden/);
assert.throws(() => buildAutoTradeMandateFromPersisted({ ...row, mode: 'LIVE' }, 'follower-1', runtimeRisk), /copy_mandate_shadow_only/);
assert.throws(() => buildAutoTradeMandateFromPersisted({ ...row, enabled: false }, 'follower-1', runtimeRisk), /copy_mandate_disabled/);
assert.throws(() => buildAutoTradeMandateFromPersisted({ ...row, policy_type: 'PERCENT_EQUITY' }, 'follower-1', runtimeRisk), /copy_mandate_policy_runtime_unsupported/);
assert.throws(() => buildAutoTradeMandateFromPersisted(row, 'follower-1', null), /autotrade_runtime_risk_required/);
assert.throws(() => buildAutoTradeMandateFromPersisted(row, 'follower-1', { ...runtimeRisk, available_capital_usd: 6000 }), /available_capital_exceeds_capital_limit/);
assert.throws(() => buildAutoTradeMandateFromPersisted({ ...row, max_slippage_bps: 5000 }, 'follower-1', runtimeRisk), /invalid_max_slippage_bps/);

console.log('copy-mandate-autotrade-adapter regression: ok');
