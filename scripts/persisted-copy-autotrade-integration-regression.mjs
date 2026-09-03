import assert from 'node:assert/strict';
import { hydratePersistedCopyMandate } from '../services/api/src/copy-mandate-runtime.mjs';
import { buildAutoTradeMandateFromPersisted } from '../services/api/src/copy-mandate-autotrade-adapter.mjs';
import { evaluateAuthenticatedAutoTradeRoute, AUTOTRADE_ROUTE_FORBIDDEN_CALLER_FIELDS } from '../services/api/src/autotrade-route-boundary.mjs';
import { persistAuthenticatedAutoTradeDecisionAtomically } from '../services/api/src/autotrade-atomic-persistence.mjs';
import { createTrustedAutoTradeRuntimeRiskResolver } from '../services/api/src/trusted-autotrade-runtime-risk.mjs';

const followerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const traderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyId = '11111111-1111-4111-8111-111111111111';
const assessmentId = '22222222-2222-4222-8222-222222222222';
const tokenMint = 'TokenMint11111111111111111111111111111111';
const wallet = 'Wallet1111111111111111111111111111111111';

const persisted = Object.freeze({
  policy_id: policyId,
  follower_user_id: followerId,
  trader_id: traderId,
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
  consented_at: '2026-09-03T00:00:00.000Z',
  trader_status: 'ACTIVE',
  trader_verified: true,
  trader_mode: 'SHADOW',
  trader_onboarding_status: 'APPROVED',
  trader_verification_status: 'VERIFIED',
  trader_published: true
});

const assessment = Object.freeze({
  token_mint: tokenMint,
  quality_score: 90,
  verdict: 'QUALIFIED',
  snapshot: Object.freeze({
    token_mint: tokenMint,
    estimated_price_impact_bps: 20,
    sell_simulation_ok: true
  })
});

const trustedRisk = Object.freeze({
  capital_limit_usd: 250,
  available_capital_usd: 150,
  daily_realized_pnl_usd: 0,
  trades_today: 2,
  max_trades_per_day: 6,
  cooldown_seconds: 1800,
  seconds_since_last_trade: 1800,
  min_signal_score: 82,
  exit_quality_floor: 55,
  allowed_tokens: Object.freeze([tokenMint]),
  risk_metadata: Object.freeze({
    risk_source: 'SESSION_WALLET_USDC_AND_DECISION_HISTORY',
    base_currency: 'USDC',
    portfolio_observed_at: '2026-09-03T12:00:00.000Z',
    daily_pnl_accounting_ready: false
  })
});

const canonical = hydratePersistedCopyMandate(persisted);
assert.equal(canonical.schema, 'aether.copy_mandate.v1');
assert.equal(canonical.execution_mode, 'SHADOW');
assert.equal(canonical.execution_scope, 'INTENT_ONLY');
assert.equal(canonical.live_execution_authorized, false);
assert.throws(() => hydratePersistedCopyMandate({ ...persisted, trader_published: false }), /trader_not_copyable/);
assert.throws(() => hydratePersistedCopyMandate({ ...persisted, consent_version: null }), /invalid_consent_version/);

const adapted = buildAutoTradeMandateFromPersisted(persisted, followerId, trustedRisk);
assert.equal(adapted.engine_mandate.capital_limit_usd, 250);
assert.equal(adapted.engine_mandate.available_capital_usd, 150);
assert.equal(adapted.engine_mandate.max_trade_usd, 100);
assert.equal(adapted.engine_mandate.mode, 'SHADOW');
assert.equal(adapted.execution_dispatched, false);
assert.throws(() => buildAutoTradeMandateFromPersisted(persisted, 'other-follower', trustedRisk), /copy_mandate_follower_mismatch/);

const route = await evaluateAuthenticatedAutoTradeRoute({
  session: { user_id: followerId, primary_wallet: wallet },
  requestBody: { policy_id: policyId, assessment_id: assessmentId },
  mandateRepository: { async getByPolicyId(id) { assert.equal(id, policyId); return persisted; } },
  resolveAssessment: async ({ assessment_id }) => ({ assessment_id, assessment }),
  resolveRuntimeRisk: async () => trustedRisk,
  liveEnabled: false
});
assert.equal(route.schema, 'aether.autotrade.authenticated_route_boundary.v2');
assert.equal(route.decision.action, 'BUY');
assert.equal(route.decision.requested_amount_usd, 37.5);
assert.equal(route.audit_metadata.runtime_risk_source, 'SESSION_WALLET_USDC_AND_DECISION_HISTORY');
assert.equal(route.audit_metadata.runtime_risk_base_currency, 'USDC');
assert.equal(route.audit_metadata.runtime_risk_daily_pnl_accounting_ready, false);
assert.equal(route.audit_metadata.caller_position_authority, false);
assert.equal(route.audit_metadata.caller_signal_snapshot_authority, false);
assert.equal(route.execution_dispatched, false);
assert.equal(route.live_execution_authorized, false);
assert.equal(route.network_submission_authorized, false);
assert.equal(route.signer_required, false);

for (const field of AUTOTRADE_ROUTE_FORBIDDEN_CALLER_FIELDS) {
  await assert.rejects(
    evaluateAuthenticatedAutoTradeRoute({
      session: { user_id: followerId },
      requestBody: { policy_id: policyId, assessment_id: assessmentId, [field]: field === 'position' || field === 'mandate' || field === 'runtime_risk' ? {} : false },
      mandateRepository: { async getByPolicyId() { return persisted; } },
      resolveAssessment: async ({ assessment_id }) => ({ assessment_id, assessment }),
      resolveRuntimeRisk: async () => trustedRisk
    }),
    /invalid_autotrade_caller_authority/
  );
}
await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: followerId }, requestBody: { policy_id: 'not-a-uuid', assessment_id: assessmentId },
    mandateRepository: {}, resolveAssessment: async () => ({}), resolveRuntimeRisk: async () => ({})
  }), /invalid_policy_id/
);
await assert.rejects(
  evaluateAuthenticatedAutoTradeRoute({
    session: { user_id: followerId }, requestBody: { policy_id: policyId, assessment_id: 'not-a-uuid' },
    mandateRepository: {}, resolveAssessment: async () => ({}), resolveRuntimeRisk: async () => ({})
  }), /invalid_assessment_id/
);

const riskQueries = [];
const riskPool = {
  async query(sql, params) {
    riskQueries.push({ sql, params });
    if (sql.includes('FROM copy_policies')) return { rows: [{ reserved_usd: '100.00' }] };
    if (sql.includes('FROM auto_trade_decisions')) return { rows: [{ decisions_today: 2, last_decision_at: '2026-09-03T11:30:00.000Z' }] };
    throw new Error('unexpected_risk_query');
  }
};
const portfolioService = {
  async getPortfolio(address) {
    assert.equal(address, wallet);
    return {
      wallet,
      base_currency: 'USDC',
      observed_at: '2026-09-03T12:00:00.000Z',
      read_only: true,
      non_custodial: true,
      signer_required: false,
      transaction_created: false,
      funds_moved: false,
      live_execution_authorized: false,
      balances: { usdc: { amount: 250 } }
    };
  }
};
const resolveTrustedRisk = createTrustedAutoTradeRuntimeRiskResolver({
  pool: riskPool,
  portfolioService,
  walletAddress: wallet,
  now: () => new Date('2026-09-03T12:00:00.000Z')
});
const derivedRisk = await resolveTrustedRisk({ authenticated_follower_user_id: followerId, policy_id: policyId, assessment });
assert.equal(derivedRisk.capital_limit_usd, 250);
assert.equal(derivedRisk.available_capital_usd, 150);
assert.equal(derivedRisk.trades_today, 2);
assert.equal(derivedRisk.seconds_since_last_trade, 1800);
assert.deepEqual(derivedRisk.allowed_tokens, [tokenMint]);
assert.equal(derivedRisk.risk_metadata.base_currency, 'USDC');
assert.equal(derivedRisk.risk_metadata.other_active_mandate_reservations_usd, 100);
assert.equal(derivedRisk.risk_metadata.daily_pnl_accounting_ready, false);
assert.equal(riskQueries.length, 2);

const zeroPortfolioResolver = createTrustedAutoTradeRuntimeRiskResolver({
  pool: riskPool,
  portfolioService: { async getPortfolio() { return { wallet, base_currency:'USDC', read_only:true, non_custodial:true, signer_required:false, transaction_created:false, funds_moved:false, live_execution_authorized:false, balances:{usdc:{amount:0}} }; } },
  walletAddress: wallet,
  now: () => new Date('2026-09-03T12:00:00.000Z')
});
await assert.rejects(
  zeroPortfolioResolver({ authenticated_follower_user_id: followerId, policy_id: policyId, assessment }),
  /autotrade_usdc_balance_required/
);

function atomicHarness({ failAudit = false } = {}) {
  const commands = [];
  let released = false;
  let decisionWrites = 0;
  let auditWrites = 0;
  let persistedPosition = null;
  const client = {
    async query(sql) { commands.push(sql); return { rows: [] }; },
    release() { released = true; }
  };
  return {
    pool: { async connect() { return client; } },
    createMandateRepository(seen) {
      assert.equal(seen, client);
      return { async getByPolicyId() { return persisted; } };
    },
    createSignalRepository(seen) {
      assert.equal(seen, client);
      return { async recordDecision(input) { decisionWrites += 1; persistedPosition = input.position; return { decision_id: 'decision-1' }; } };
    },
    createAuditRepository(seen) {
      assert.equal(seen, client);
      return { async append() { auditWrites += 1; if (failAudit) throw new Error('synthetic_audit_failure'); return { audit_id: 'audit-1' }; } };
    },
    state: () => ({ commands:[...commands], released, decisionWrites, auditWrites, persistedPosition })
  };
}

const success = atomicHarness();
const atomicResult = await persistAuthenticatedAutoTradeDecisionAtomically({
  pool: success.pool,
  session: { user_id: followerId, primary_wallet: wallet },
  requestBody: { policy_id: policyId, assessment_id: assessmentId },
  createMandateRepository: success.createMandateRepository,
  createSignalRepository: success.createSignalRepository,
  createAuditRepository: success.createAuditRepository,
  resolveAssessment: async ({ assessment_id }) => ({ assessment_id, assessment }),
  resolveRuntimeRisk: async () => derivedRisk,
  liveEnabled: false
});
assert.equal(atomicResult.schema, 'aether.autotrade.atomic_persistence.v2');
assert.equal(atomicResult.decision_audit_atomic, true);
assert.deepEqual(success.state().commands, ['BEGIN','COMMIT']);
assert.equal(success.state().decisionWrites, 1);
assert.equal(success.state().auditWrites, 1);
assert.deepEqual(success.state().persistedPosition, {});
assert.equal(success.state().released, true);
assert.equal(atomicResult.execution_dispatched, false);
assert.equal(atomicResult.live_execution_authorized, false);
assert.equal(atomicResult.network_submission_authorized, false);
assert.equal(atomicResult.signer_required, false);

const failed = atomicHarness({ failAudit: true });
await assert.rejects(
  persistAuthenticatedAutoTradeDecisionAtomically({
    pool: failed.pool,
    session: { user_id: followerId, primary_wallet: wallet },
    requestBody: { policy_id: policyId, assessment_id: assessmentId },
    createMandateRepository: failed.createMandateRepository,
    createSignalRepository: failed.createSignalRepository,
    createAuditRepository: failed.createAuditRepository,
    resolveAssessment: async ({ assessment_id }) => ({ assessment_id, assessment }),
    resolveRuntimeRisk: async () => derivedRisk,
    liveEnabled: false
  }), /synthetic_audit_failure/
);
assert.deepEqual(failed.state().commands, ['BEGIN','ROLLBACK']);
assert.equal(failed.state().released, true);

console.log('persisted copy autotrade integration regression: PASS');
