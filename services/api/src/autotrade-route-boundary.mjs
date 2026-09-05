import { evaluatePersistedCopyMandateAutoTrade } from './persisted-autotrade-service.mjs';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_CALLER_FIELDS = Object.freeze([
  'mandate',
  'follower_user_id',
  'trader_id',
  'runtime_risk',
  'position',
  'snapshot',
  'execution_mode',
  'mode',
  'live_execution_authorized',
  'network_submission_authorized',
  'signer_required'
]);

function requireObject(value, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value;
}

function canonicalSession(session) {
  const value = requireObject(session, 'authenticated_session_required');
  if (typeof value.user_id !== 'string' || value.user_id.trim() === '' || value.user_id !== value.user_id.trim()) {
    throw new Error('invalid_authenticated_session_user_id');
  }
  return value;
}

function canonicalUuid(value, field) {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function rejectCallerAuthority(body) {
  for (const field of FORBIDDEN_CALLER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) throw new Error('invalid_autotrade_caller_authority');
  }
}

function requireResolver(fn, error) {
  if (typeof fn !== 'function') throw new Error(error);
  return fn;
}

function positionReference(position) {
  if (!position?.position_id) return Object.freeze({});
  return Object.freeze({
    position_id: position.position_id,
    policy_id: position.policy_id || null,
    trader_id: position.trader_id || null,
    token_mint: position.token_mint || null,
    status: position.status || null,
    source: position.source || 'BACKEND_TRUSTED_POSITION',
    caller_authority: false,
    mode: 'SHADOW',
    live_execution_authorized: false
  });
}

function assertPositionSafety(position) {
  if (
    position?.caller_authority === true ||
    position?.live_execution_authorized === true ||
    position?.network_submission_authorized === true ||
    position?.signer_required === true ||
    (position?.mode && position.mode !== 'SHADOW')
  ) throw new Error('invalid_trusted_position_authority');
}

export async function evaluateAuthenticatedAutoTradeRoute({
  session,
  requestBody,
  mandateRepository,
  resolveAssessment,
  resolveRuntimeRisk,
  resolvePosition,
  liveEnabled = false
}) {
  if (liveEnabled === true) throw new Error('autotrade_live_blocked');
  const authenticated = canonicalSession(session);
  const body = requireObject(requestBody, 'autotrade_request_body_required');
  rejectCallerAuthority(body);

  const policyId = canonicalUuid(body.policy_id, 'policy_id');
  const assessmentId = canonicalUuid(body.assessment_id, 'assessment_id');
  const assessmentResolver = requireResolver(resolveAssessment, 'autotrade_assessment_resolver_required');
  const riskResolver = requireResolver(resolveRuntimeRisk, 'autotrade_runtime_risk_resolver_required');

  const assessmentResult = await assessmentResolver({ assessment_id: assessmentId });
  const resolved = requireObject(assessmentResult, 'signal_assessment_required');
  if (resolved.assessment_id !== assessmentId) throw new Error('signal_assessment_id_mismatch');
  const assessment = requireObject(resolved.assessment, 'signal_assessment_required');

  const trustedPosition = resolvePosition
    ? requireObject(await resolvePosition({
        authenticated_follower_user_id: authenticated.user_id,
        policy_id: policyId,
        assessment
      }), 'autotrade_trusted_position_required')
    : Object.freeze({});
  assertPositionSafety(trustedPosition);

  const runtimeRisk = requireObject(await riskResolver({
    authenticated_follower_user_id: authenticated.user_id,
    policy_id: policyId,
    assessment,
    position: trustedPosition
  }), 'autotrade_runtime_risk_required');
  const riskMetadata = runtimeRisk.risk_metadata && typeof runtimeRisk.risk_metadata === 'object' && !Array.isArray(runtimeRisk.risk_metadata)
    ? runtimeRisk.risk_metadata
    : {};

  const result = await evaluatePersistedCopyMandateAutoTrade({
    repository: mandateRepository,
    authenticatedFollowerUserId: authenticated.user_id,
    policyId,
    assessment,
    position: trustedPosition,
    runtimeRisk,
    liveEnabled: false
  });

  if (
    result.execution_dispatched !== false ||
    result.live_execution_authorized !== false ||
    result.network_submission_authorized !== false ||
    result.signer_required !== false
  ) throw new Error('autotrade_route_shadow_invariant_failed');

  const reference = positionReference(trustedPosition);
  return Object.freeze({
    schema: 'aether.autotrade.authenticated_route_boundary.v2',
    assessment_id: assessmentId,
    mandate_id: result.mandate_id,
    trader_id: result.trader_id,
    assessment: result.assessment,
    decision: result.decision,
    position_reference: reference,
    audit_metadata: Object.freeze({
      ...result.audit_metadata,
      route_schema: 'aether.autotrade.authenticated_route_boundary.v2',
      authenticated_follower_user_id: authenticated.user_id,
      runtime_risk_source: riskMetadata.risk_source || null,
      runtime_risk_base_currency: riskMetadata.base_currency || null,
      runtime_risk_portfolio_observed_at: riskMetadata.portfolio_observed_at || null,
      runtime_risk_daily_pnl_accounting_ready: riskMetadata.daily_pnl_accounting_ready === true,
      trusted_position_source: trustedPosition.source || null,
      trusted_position_id: trustedPosition.position_id || null,
      caller_mandate_authority: false,
      caller_identity_authority: false,
      caller_runtime_risk_authority: false,
      caller_position_authority: false,
      caller_signal_snapshot_authority: false,
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    }),
    execution_dispatched: false,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}

export const AUTOTRADE_ROUTE_FORBIDDEN_CALLER_FIELDS = FORBIDDEN_CALLER_FIELDS;
