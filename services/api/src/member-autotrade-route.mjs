import { persistAuthenticatedAutoTradeDecisionAtomically } from './autotrade-atomic-persistence.mjs';
import { createTrustedAutoTradeRuntimeRiskResolver } from './trusted-autotrade-runtime-risk.mjs';
import { handleMemberPositionsRoute } from './member-positions-route.mjs';
import { getMemberAutoTradeDemoState, runMemberAutoTradeDemoStep } from './member-autotrade-demo.mjs';
import { getMemberEngineRentalState, createMemberEngineCheckout } from './member-engine-rental-gate.mjs';

const MEMBER_ROUTE = '/api/account/autotrade/evaluate';
const LEGACY_ROUTE = '/api/autotrade/evaluate';
const DEMO_STATE_ROUTE = '/api/account/auto-strategy/demo';
const DEMO_SIMULATE_ROUTE = '/api/account/auto-strategy/simulate';
const RENTAL_STATE_ROUTE = '/api/account/engine-rental';
const RENTAL_CHECKOUT_ROUTE = '/api/account/engine-rental/checkout';

function statusFor(error) {
  const code = String(error?.message || '');
  if (['session_required', 'session_invalid', 'authenticated_session_required'].includes(code)) return 401;
  if (['copy_mandate_not_found', 'signal_assessment_not_found', 'engine_plan_not_found', 'engine_subscription_not_found'].includes(code)) return 404;
  if (['autotrade_live_blocked', 'copy_mandate_shadow_only', 'live_execution_forbidden'].includes(code)) return 423;
  if ([
    'copy_mandate_follower_mismatch', 'copy_mandate_not_active', 'copy_mandate_disabled',
    'trader_not_copyable', 'trader_not_shadow', 'copy_mandate_scope_violation',
    'engine_subscription_required', 'engine_subscription_payment_required', 'engine_subscription_expired',
    'engine_subscription_pending', 'engine_subscription_past_due', 'engine_subscription_cancelled'
  ].includes(code)) return 402;
  if (code === 'engine_subscription_already_active') return 409;
  if (code === 'autotrade_usdc_balance_required') return 409;
  if (code === 'solana_rpc_unconfigured') return 503;
  if (['solana_rpc_http_error', 'solana_rpc_error', 'solana_rpc_timeout'].includes(code)) return 502;
  if (code.startsWith('invalid_') || code.endsWith('_required') || code.includes('_mismatch')) return 400;
  return 500;
}

async function requirePaidRental(pool, userId) {
  const rental = await getMemberEngineRentalState(pool, userId);
  if (!rental.allowed) {
    const error = new Error(rental.reason);
    error.rental = rental;
    throw error;
  }
  return rental;
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
  createRiskResolver = createTrustedAutoTradeRuntimeRiskResolver
}) {
  if (await handleMemberPositionsRoute({ req, res, route, pool, walletAuth, sessionFor, send })) return true;

  if (route === RENTAL_STATE_ROUTE || route === RENTAL_CHECKOUT_ROUTE) {
    const expectedMethod = route === RENTAL_STATE_ROUTE ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      send(res, 405, { error: 'method_not_allowed', live_execution_authorized: false });
      return true;
    }
    if (!pool || !walletAuth) {
      send(res, 503, { error: 'database_unconfigured', live_execution_authorized: false });
      return true;
    }
    try {
      const session = await sessionFor(req);
      if (!session) {
        send(res, 401, { error: 'session_required', live_execution_authorized: false });
        return true;
      }
      if (route === RENTAL_STATE_ROUTE) {
        const rental = await getMemberEngineRentalState(pool, session.user_id);
        send(res, 200, { ...rental, billing_period: 'MONTHLY', currency: 'USDC', live_execution_authorized: false });
        return true;
      }
      const body = await jsonBody(req);
      const checkout = await createMemberEngineCheckout(pool, session.user_id, body.plan_code);
      send(res, 201, {
        ...checkout,
        payment_required: true,
        currency: 'USDC',
        activation_rule: 'SERVER_VERIFIED_PAYMENT_ONLY',
        note: 'A payment provider must settle this invoice before Auto Trade access becomes ACTIVE.',
        live_execution_authorized: false
      });
      return true;
    } catch (error) {
      send(res, statusFor(error), {
        error: String(error?.message || 'engine_rental_failed'),
        rental: error?.rental || undefined,
        live_execution_authorized: false
      });
      return true;
    }
  }

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
        const [state, rental] = await Promise.all([
          getMemberAutoTradeDemoState(pool, session.user_id, { limit: 20 }),
          getMemberEngineRentalState(pool, session.user_id)
        ]);
        send(res, 200, { demo_wallet: state, engine_rental: rental, simulator_runtime: 'PRIMARY_VM_PERSISTENT_DEMO', mode: 'SHADOW', funds_moved: false, live_execution_authorized: false });
        return true;
      }
      const rental = await requirePaidRental(pool, session.user_id);
      const result = await runMemberAutoTradeDemoStep(pool, session, await jsonBody(req));
      send(res, 200, { ...result, engine_rental: rental });
      return true;
    } catch (error) {
      send(res, statusFor(error), {
        error: String(error?.message || 'persistent_demo_failed'),
        rental: error?.rental || undefined,
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
    const rental = await requirePaidRental(pool, session.user_id);
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
    const result = await persistDecision({
      pool,
      session,
      requestBody: body,
      resolveAssessment,
      resolveRuntimeRisk,
      liveEnabled: false
    });
    if (
      result?.execution_dispatched !== false ||
      result?.live_execution_authorized !== false ||
      result?.network_submission_authorized !== false ||
      result?.signer_required !== false
    ) throw new Error('autotrade_member_shadow_invariant_failed');

    send(res, 200, {
      ...result,
      engine_rental: rental,
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
      rental: error?.rental || undefined,
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
export const MEMBER_ENGINE_RENTAL_STATE_ROUTE = RENTAL_STATE_ROUTE;
export const MEMBER_ENGINE_RENTAL_CHECKOUT_ROUTE = RENTAL_CHECKOUT_ROUTE;
