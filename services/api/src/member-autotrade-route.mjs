import { persistAuthenticatedAutoTradeDecisionAtomically } from './autotrade-atomic-persistence.mjs';
import { createTrustedAutoTradeRuntimeRiskResolver } from './trusted-autotrade-runtime-risk.mjs';
import { createTrustedAutoTradePositionResolver } from './trusted-autotrade-position.mjs';
import { createShadowAutoTradeLifecycleBridge } from './shadow-autotrade-lifecycle-bridge.mjs';
import { handleMemberPositionsRoute } from './member-positions-route.mjs';
import { getMemberAutoTradeDemoState, runMemberAutoTradeDemoStep } from './member-autotrade-demo.mjs';

const MEMBER_ROUTE = '/api/account/autotrade/evaluate';
const LEGACY_ROUTE = '/api/autotrade/evaluate';
const DEMO_STATE_ROUTE = '/api/account/auto-strategy/demo';
const DEMO_SIMULATE_ROUTE = '/api/account/auto-strategy/simulate';

function statusFor(error) {
  const code = String(error?.message || '');
  if (['session_required', 'session_invalid', 'authenticated_session_required'].includes(code)) return 401;
  if (['copy_mandate_not_found', 'signal_assessment_not_found'].includes(code)) return 404;
  if (['autotrade_live_blocked', 'copy_mandate_shadow_only', 'live_execution_forbidden'].includes(code)) return 423;
  if ([
    'copy_mandate_follower_mismatch', 'copy_mandate_not_active', 'copy_mandate_disabled',
    'trader_not_copyable', 'trader_not_shadow', 'copy_mandate_scope_violation'
  ].includes(code)) return 403;
  if (['autotrade_usdc_balance_required', 'trusted_position_accounting_not_ready', 'trusted_position_ambiguous'].includes(code)) return 409;
  if (code === 'solana_rpc_unconfigured') return 503;
  if (['solana_rpc_http_error', 'solana_rpc_error', 'solana_rpc_timeout'].includes(code)) return 502;
  if (code.startsWith('invalid_') || code.endsWith('_required') || code.includes('_mismatch')) return 400;
  return 500;
}

function assertLifecycleSafety(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('shadow_lifecycle_result_required');
  if (result.mode !== 'SHADOW' || result.live_execution_authorized !== false) throw new Error('shadow_lifecycle_invariant_failed');
  if (result.network_submission_authorized === true || result.signer_required === true || result.funds_moved === true) {
    throw new Error('shadow_lifecycle_invariant_failed');
  }
  return result;
}

export async function handleMemberAutoTradeRoute({
  req,
  res,
  route,
  pool,
  repos,
  walletAuth,
  sessionFor,
  jsonBody,
  send,
  executionMode,
  liveEnabled,
  walletPortfolio,
  assessmentProjection,
  persistDecision = persistAuthenticatedAutoTradeDecisionAtomically,
  createRiskResolver = createTrustedAutoTradeRuntimeRiskResolver,
  createPositionResolver = createTrustedAutoTradePositionResolver,
  createLifecycleBridge = createShadowAutoTradeLifecycleBridge
}) {
  if (await handleMemberPositionsRoute({ req, res, route, pool, walletAuth, sessionFor, send })) return true;

  if (route === DEMO_STATE_ROUTE || route === DEMO_SIMULATE_ROUTE) {
    const expectedMethod = route === DEMO_STATE_ROUTE ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    if (!pool || !walletAuth) {
      send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    if (liveEnabled || executionMode !== 'SHADOW') {
      send(res, 423, { error: 'autotrade_live_blocked', reason: 'persistent_demo_shadow_only', live_execution_authorized: false });
      return true;
    }
    try {
      const session = await sessionFor(req);
      if (!session) {
        send(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });
        return true;
      }
      if (route === DEMO_STATE_ROUTE) {
        const state = await getMemberAutoTradeDemoState(pool, session.user_id, { limit: 20 });
        send(res, 200, { demo_wallet: state, simulator_runtime: 'PRIMARY_VM_PERSISTENT_DEMO', mode: 'SHADOW', funds_moved: false, live_execution_authorized: false });
        return true;
      }
      const result = await runMemberAutoTradeDemoStep(pool, session, await jsonBody(req));
      send(res, 200, result);
      return true;
    } catch (error) {
      send(res, statusFor(error), {
        error: String(error?.message || 'persistent_demo_failed'),
        mode: 'SHADOW',
        execution_dispatched: false,
        funds_moved: false,
        live_execution_authorized: false
      });
      return true;
    }
  }

  if (route === LEGACY_ROUTE) {
    if (req.method !== 'POST') return false;
    send(res, 410, {
      error: 'legacy_autotrade_route_disabled',
      replacement: MEMBER_ROUTE,
      authentication: 'WALLET_SESSION',
      mode: 'SHADOW',
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    });
    return true;
  }

  if (route !== MEMBER_ROUTE) return false;
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
    return true;
  }
  if (!pool || !repos || !walletAuth) {
    send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', live_execution_authorized: false });
    return true;
  }
  if (liveEnabled || executionMode !== 'SHADOW') {
    send(res, 423, { error: 'autotrade_live_blocked', reason: 'shadow_only_member_route', live_execution_authorized: false });
    return true;
  }

  try {
    const session = await sessionFor(req);
    if (!session) {
      send(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    const body = await jsonBody(req);
    const resolveAssessment = async ({ assessment_id }) => {
      const row = await repos.signalIntelligence.getAssessment(assessment_id);
      if (!row) throw new Error('signal_assessment_not_found');
      return { assessment_id: row.assessment_id, assessment: assessmentProjection(row) };
    };
    const resolveRuntimeRisk = createRiskResolver({
      pool,
      portfolioService: walletPortfolio,
      walletAddress: session.primary_wallet
    });
    const resolvePosition = createPositionResolver({ pool });
    const result = await persistDecision({
      pool,
      session,
      requestBody: body,
      resolveAssessment,
      resolveRuntimeRisk,
      resolvePosition,
      liveEnabled: false
    });
    if (
      result?.execution_dispatched !== false ||
      result?.live_execution_authorized !== false ||
      result?.network_submission_authorized !== false ||
      result?.signer_required !== false
    ) throw new Error('autotrade_member_shadow_invariant_failed');

    let lifecycle;
    try {
      const bridge = createLifecycleBridge(pool);
      lifecycle = assertLifecycleSafety(await bridge.applyDecision({
        decision: result.decision,
        assessment: result.assessment,
        mandate: {
          follower_user_id: session.user_id,
          policy_id: result.mandate_id,
          trader_id: result.trader_id
        },
        position: result.position_reference || {},
        context: {
          source_id: result.assessment_id,
          assessment_id: result.assessment_id,
          executionMode: 'SHADOW',
          liveEnabled: false
        }
      }));
    } catch (lifecycleError) {
      send(res, 503, {
        error: 'shadow_position_lifecycle_failed',
        reason: String(lifecycleError?.message || 'unknown_lifecycle_error'),
        decision_id: result.decision_id || null,
        assessment_id: result.assessment_id || null,
        decision_persisted: true,
        lifecycle_applied: false,
        mode: 'SHADOW',
        execution_dispatched: false,
        live_execution_authorized: false,
        network_submission_authorized: false,
        signer_required: false
      });
      return true;
    }

    send(res, 200, {
      ...result,
      lifecycle,
      lifecycle_applied: lifecycle.persisted !== false,
      route: MEMBER_ROUTE,
      authentication: 'WALLET_SESSION',
      mode: 'SHADOW',
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    });
    return true;
  } catch (error) {
    send(res, statusFor(error), {
      error: String(error?.message || 'autotrade_member_route_failed'),
      mode: 'SHADOW',
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    });
    return true;
  }
}

export const MEMBER_AUTOTRADE_ROUTE = MEMBER_ROUTE;
export const MEMBER_AUTOTRADE_DEMO_STATE_ROUTE = DEMO_STATE_ROUTE;
export const MEMBER_AUTOTRADE_DEMO_SIMULATE_ROUTE = DEMO_SIMULATE_ROUTE;
