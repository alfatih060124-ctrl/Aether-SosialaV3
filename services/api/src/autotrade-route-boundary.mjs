import { evaluatePersistedCopyMandateAutoTrade } from './persisted-autotrade-service.mjs';

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

function rejectCallerAuthority(body) {
  for (const field of ['mandate', 'follower_user_id', 'trader_id', 'runtime_risk', 'live_execution_authorized', 'network_submission_authorized', 'signer_required']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) throw new Error('invalid_autotrade_caller_authority');
  }
}

function requireResolver(fn, error) {
  if (typeof fn !== 'function') throw new Error(error);
  return fn;
}

export async function evaluateAuthenticatedAutoTradeRoute({
  session,
  requestBody,
  mandateRepository,
  resolveAssessment,
  resolveRuntimeRisk,
  liveEnabled = false
}) {
  if (liveEnabled === true) throw new Error('autotrade_live_blocked');
  const authenticated = canonicalSession(session);
  const body = requireObject(requestBody, 'autotrade_request_body_required');
  rejectCallerAuthority(body);

  if (typeof body.policy_id !== 'string' || body.policy_id.trim() === '' || body.policy_id !== body.policy_id.trim()) {
    throw new Error('invalid_policy_id');
  }
  if (body.position !== undefined && (!body.position || typeof body.position !== 'object' || Array.isArray(body.position))) {
    throw new Error('invalid_position');
  }

  const assessmentResolver = requireResolver(resolveAssessment, 'autotrade_assessment_resolver_required');
  const riskResolver = requireResolver(resolveRuntimeRisk, 'autotrade_runtime_risk_resolver_required');

  const assessmentResult = await assessmentResolver({
    assessment_id: body.assessment_id,
    snapshot: body.snapshot
  });
  const resolved = requireObject(assessmentResult, 'signal_assessment_required');
  const assessment = requireObject(resolved.assessment, 'signal_assessment_required');
  const assessmentId = resolved.assessment_id ?? null;

  const runtimeRisk = await riskResolver({
    authenticated_follower_user_id: authenticated.user_id,
    policy_id: body.policy_id,
    assessment,
    position: body.position ?? {}
  });

  const result = await evaluatePersistedCopyMandateAutoTrade({
    repository: mandateRepository,
    authenticatedFollowerUserId: authenticated.user_id,
    policyId: body.policy_id,
    assessment,
    position: body.position ?? {},
    runtimeRisk,
    liveEnabled: false
  });

  if (result.execution_dispatched !== false || result.live_execution_authorized !== false || result.network_submission_authorized !== false || result.signer_required !== false) {
    throw new Error('autotrade_route_shadow_invariant_failed');
  }

  return Object.freeze({
    schema: 'aether.autotrade.authenticated_route_boundary.v1',
    assessment_id: assessmentId,
    mandate_id: result.mandate_id,
    trader_id: result.trader_id,
    decision: result.decision,
    audit_metadata: Object.freeze({
      ...result.audit_metadata,
      route_schema: 'aether.autotrade.authenticated_route_boundary.v1',
      authenticated_follower_user_id: authenticated.user_id,
      caller_mandate_authority: false,
      caller_identity_authority: false,
      caller_runtime_risk_authority: false,
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
