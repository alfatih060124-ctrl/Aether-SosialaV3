import { persistAuthenticatedAutoTradeDecisionAtomically } from './autotrade-atomic-persistence.mjs';
import { createTrustedAutoTradeRuntimeRiskResolver } from './trusted-autotrade-runtime-risk.mjs';
import { handleMemberPositionsRoute } from './member-positions-route.mjs';
import { getMemberAutoTradeDemoState, runMemberAutoTradeDemoStep } from './member-autotrade-demo.mjs';
import { getMarketShadowRuntimeState, startMarketShadowRuntimeScan } from './market-shadow-runtime.mjs';
import {
  getMemberSubscriptionOverview,
  createMemberSubscriptionQuote,
  verifyMemberSubscriptionPayment
} from './member-subscription-billing.mjs';

const MEMBER_ROUTE = '/api/account/autotrade/evaluate';
const LEGACY_ROUTE = '/api/autotrade/evaluate';
const DEMO_STATE_ROUTE = '/api/account/auto-strategy/demo';
const DEMO_SIMULATE_ROUTE = '/api/account/auto-strategy/simulate';
const MARKET_SHADOW_ROUTE = '/api/account/auto-strategy/market-shadow';
const SUBSCRIPTION_ROUTE = '/api/account/subscription';
const SUBSCRIPTION_QUOTE_ROUTE = '/api/account/subscription/quote';
const SUBSCRIPTION_VERIFY_ROUTE = '/api/account/subscription/verify';
const auditedTerminalMarketShadowScans = new Set();

function rememberTerminalMarketShadowAudit(scanId) {
  if (!scanId) return;
  auditedTerminalMarketShadowScans.add(scanId);
  if (auditedTerminalMarketShadowScans.size > 256) {
    auditedTerminalMarketShadowScans.delete(auditedTerminalMarketShadowScans.values().next().value);
  }
}

async function appendMarketShadowAudit(repos, eventType, session, scan) {
  if (!repos?.auditEvents?.append || !scan?.scan_id) return false;
  try {
    await repos.auditEvents.append({
      event_type: eventType,
      actor: session?.primary_wallet || session?.user_id || 'member',
      entity_type: 'market_shadow_scan',
      entity_id: scan.scan_id,
      payload: {
        status: scan.status,
        duration_ms: scan.duration_ms ?? scan.observability?.current_scan_duration_ms ?? null,
        scans_started: scan.observability?.scans_started ?? null,
        scans_completed: scan.observability?.scans_completed ?? null,
        scans_failed: scan.observability?.scans_failed ?? null,
        candidates_scanned: scan.summary?.candidates_scanned ?? null,
        qualified_count: scan.summary?.qualified_count ?? null,
        min_expected_net_edge_bps: Math.max(20, Number(scan.min_expected_net_edge_bps || 20)),
        mode: 'SHADOW',
        execution_dispatched: false,
        transaction_signed: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      }
    });
    return true;
  } catch {
    return false;
  }
}

function statusFor(error) {
  const code = String(error?.message || '');
  if (['session_required', 'session_invalid', 'authenticated_session_required'].includes(code)) return 401;
  if (['copy_mandate_not_found', 'signal_assessment_not_found', 'subscription_order_not_found'].includes(code)) return 404;
  if (['autotrade_live_blocked', 'copy_mandate_shadow_only', 'live_execution_forbidden'].includes(code)) return 423;
  if ([
    'copy_mandate_follower_mismatch', 'copy_mandate_not_active', 'copy_mandate_disabled',
    'trader_not_copyable', 'trader_not_shadow', 'copy_mandate_scope_violation'
  ].includes(code)) return 403;
  if (['autotrade_usdc_balance_required','subscription_quote_expired','subscription_order_not_pending','subscription_payment_signature_already_used','subscription_treasury_configuration_changed','subscription_usdc_mint_configuration_changed'].includes(code)) return 409;
  if (['solana_rpc_unconfigured','subscription_rpc_url_required','subscription_treasury_wallet_required','subscription_usdc_mint_required'].includes(code)) return 503;
  if (['solana_rpc_http_error','solana_rpc_error','solana_rpc_timeout','subscription_rpc_timeout'].includes(code) || code.startsWith('subscription_rpc_')) return 502;
  if (code.startsWith('invalid_') || code.endsWith('_required') || code.includes('_mismatch') || code.includes('_invalid') || code.includes('_unsupported') || code.includes('_unavailable')) return 400;
  return 500;
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
  if (await handleMemberPositionsRoute({ req, res, route, pool, walletAuth, sessionFor, jsonBody, send })) return true;


  if ([SUBSCRIPTION_ROUTE, SUBSCRIPTION_QUOTE_ROUTE, SUBSCRIPTION_VERIFY_ROUTE].includes(route)) {
    const expectedMethod = route === SUBSCRIPTION_ROUTE ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    if (!pool || !walletAuth) {
      send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    try {
      const session = await sessionFor(req);
      if (!session) {
        send(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });
        return true;
      }
      if (route === SUBSCRIPTION_ROUTE) {
        const overview = await getMemberSubscriptionOverview(pool, session.user_id);
        send(res, 200, { ...overview, route: SUBSCRIPTION_ROUTE, authentication: 'WALLET_SESSION', mode: 'SHADOW', live_execution_authorized: false });
        return true;
      }
      const body = await jsonBody(req);
      if (route === SUBSCRIPTION_QUOTE_ROUTE) {
        const quote = await createMemberSubscriptionQuote(pool, session, { duration_days: body?.duration_days });
        send(res, 201, { quote, route: SUBSCRIPTION_QUOTE_ROUTE, authentication: 'WALLET_SESSION', mode: 'SHADOW', live_execution_authorized: false });
        return true;
      }
      const result = await verifyMemberSubscriptionPayment(pool, session, { order_id: body?.order_id, signature: body?.signature });
      send(res, 200, { ...result, route: SUBSCRIPTION_VERIFY_ROUTE, authentication: 'WALLET_SESSION', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    } catch (error) {
      send(res, statusFor(error), {
        error: String(error?.message || 'member_subscription_failed'),
        mode: 'SHADOW', funds_moved_by_aether: false, transaction_submission_authorized: false,
        signing_authorized: false, live_execution_authorized: false
      });
      return true;
    }
  }

  if (route === MARKET_SHADOW_ROUTE) {
    if (!['GET', 'POST'].includes(req.method)) {
      send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    if (!pool || !walletAuth) {
      send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', live_execution_authorized: false });
      return true;
    }
    if (liveEnabled || executionMode !== 'SHADOW') {
      send(res, 423, { error: 'autotrade_live_blocked', reason: 'real_market_shadow_only', live_execution_authorized: false });
      return true;
    }
    try {
      const session = await sessionFor(req);
      if (!session) {
        send(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });
        return true;
      }
      const before = getMarketShadowRuntimeState();
      const scan = req.method === 'POST' ? startMarketShadowRuntimeScan() : before;
      let auditRecorded = false;
      let auditEventType = null;
      if (req.method === 'POST' && scan.status === 'RUNNING' && scan.scan_id && scan.scan_id !== before.scan_id) {
        auditEventType = 'MARKET_SHADOW_SCAN_STARTED';
        auditRecorded = await appendMarketShadowAudit(repos, auditEventType, session, scan);
      } else if (req.method === 'GET' && ['COMPLETE', 'ERROR'].includes(scan.status) && scan.scan_id && !auditedTerminalMarketShadowScans.has(scan.scan_id)) {
        auditEventType = scan.status === 'COMPLETE' ? 'MARKET_SHADOW_SCAN_COMPLETED' : 'MARKET_SHADOW_SCAN_FAILED';
        auditRecorded = await appendMarketShadowAudit(repos, auditEventType, session, scan);
        if (auditRecorded) rememberTerminalMarketShadowAudit(scan.scan_id);
      }
      send(res, req.method === 'POST' ? 202 : 200, {
        scan,
        observability: {
          audit_recorded: auditRecorded,
          audit_event_type: auditEventType,
          runtime_metrics: scan.observability || null,
          mode: 'SHADOW',
          live_execution_authorized: false
        },
        simulator_runtime: 'PRIMARY_VM_REAL_MARKET_SHADOW',
        authenticated_user_id: session.user_id,
        market_data_only: true,
        min_expected_net_edge_bps: 20,
        execution_dispatched: false,
        funds_moved: false,
        transaction_signed: false,
        network_submission_authorized: false,
        live_execution_authorized: false,
        mode: 'SHADOW'
      });
      return true;
    } catch (error) {
      send(res, statusFor(error), {
        error: String(error?.message || 'market_shadow_runtime_failed'),
        mode: 'SHADOW',
        execution_dispatched: false,
        funds_moved: false,
        transaction_signed: false,
        network_submission_authorized: false,
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
export const MEMBER_AUTOTRADE_MARKET_SHADOW_ROUTE = MARKET_SHADOW_ROUTE;
export const MEMBER_SUBSCRIPTION_ROUTE = SUBSCRIPTION_ROUTE;
export const MEMBER_SUBSCRIPTION_QUOTE_ROUTE = SUBSCRIPTION_QUOTE_ROUTE;
export const MEMBER_SUBSCRIPTION_VERIFY_ROUTE = SUBSCRIPTION_VERIFY_ROUTE;
