import { createTraderControlPlaneRuntimeSoD, isTraderControlPlaneMutation } from './trader-control-plane-runtime-sod.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODES = new Set([
  'trader_control_plane_role_unauthorized','trader_control_plane_actor_invalid','trader_control_plane_actor_reuse_forbidden',
  'trader_control_plane_evidence_actor_required','trader_control_plane_prior_actor_context_required','trader_control_plane_evidence_audit_required',
  'trader_control_plane_evidence_audit_invalid','trader_control_plane_verification_audit_required','trader_control_plane_verification_audit_invalid',
  'trader_control_plane_audit_history_invalid','trader_control_plane_authorization_required','evidence_id_required','trader_id_required',
  'trader_publication_gate_failed','trader_not_verified','trader_not_approved','trader_mode_invalid'
]);
function safeStatus(code) {
  if (code === 'trader_control_plane_role_unauthorized' || code === 'trader_control_plane_actor_invalid') return 401;
  if (code === 'trader_control_plane_actor_reuse_forbidden') return 403;
  if (code.includes('_audit_') || code === 'evidence_id_required') return 409;
  if (code.includes('_credential_required') || code.includes('credentials_must_be_distinct') || code.includes('shared_admin_credential_forbidden')) return 503;
  return 400;
}
function routeParts(req, parts) { if (Array.isArray(parts) && parts.length) return parts; const path = new URL(String(req?.url || '/'), 'http://localhost').pathname; return path.replace(/\/+$/, '').split('/').filter(Boolean); }
function safeClientError(error) {
  const code = String(error?.message || '');
  if (SAFE_ERROR_CODES.has(code) || code.startsWith('trader_control_plane_')) return { code, status: safeStatus(code) };
  return { code: 'trader_control_plane_request_rejected', status: 500 };
}

export async function handleTraderControlPlaneRoute({ req, res, parts, pool, repos, jsonBody, send, env = process.env } = {}) {
  const resolvedParts = routeParts(req, parts);
  if (!isTraderControlPlaneMutation({ method: req?.method, parts: resolvedParts })) return false;
  const traderId = String(resolvedParts[3] || '');
  if (!UUID_RE.test(traderId)) { send(res, 400, { error: 'trader_id_invalid', mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false }); return true; }
  if (!pool || !repos?.marketplace || !repos?.auditEvents) { send(res, 503, { error: 'database_unconfigured', live_execution_authorized: false }); return true; }
  let sod;
  try { sod = createTraderControlPlaneRuntimeSoD({ pool, env }); }
  catch { send(res, 503, { error: 'trader_control_plane_role_config_invalid', live_execution_authorized: false }); return true; }
  try {
    if (req.method === 'POST' && resolvedParts[4] === 'evidence' && !resolvedParts[5]) {
      const authz = await sod.authorizeEvidence(req);
      const evidence = await repos.marketplace.recordTraderVerificationEvidence(traderId, await jsonBody(req));
      await repos.auditEvents.append({ event_type: 'TRADER_VERIFICATION_EVIDENCE_RECORDED', actor: authz.actor, entity_type: 'trader_verification_evidence', entity_id: String(evidence.evidence_id), payload: sod.auditPayload(authz, { trader_id: evidence.trader_id, source_type: evidence.source_type, source_reference: evidence.source_reference, observed_at: evidence.observed_at, evidence_status: evidence.evidence_status, verified: false, published: false }) });
      send(res, 201, { evidence, evidence_recorded: true, verification_authorized: false, publication_authorized: false, mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false }); return true;
    }
    if (req.method === 'PATCH' && resolvedParts[4] === 'verification' && !resolvedParts[5]) {
      const body = await jsonBody(req); const authz = await sod.authorizeVerification(req, { traderId, evidenceId: body.evidence_id });
      const trader = await repos.marketplace.reviewTraderVerification(traderId, body);
      await repos.auditEvents.append({ event_type: 'TRADER_DATA_VERIFICATION_REVIEWED', actor: authz.actor, entity_type: 'trader', entity_id: String(trader.trader_id), payload: sod.auditPayload(authz, { decision: String(body.decision || '').toUpperCase(), evidence_id: body.evidence_id, verification_status: trader.verification_status, verified: trader.verified === true, published: trader.published === true, verification_source: trader.verification_source }) });
      send(res, 200, { trader, publication_authorized: false, publication_requires_explicit_action: true, mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false }); return true;
    }
    if (req.method === 'PATCH' && resolvedParts[4] === 'publication' && !resolvedParts[5]) {
      const authz = await sod.authorizePublication(req, { traderId }); const body = await jsonBody(req); const trader = await repos.marketplace.setTraderPublished(traderId, body);
      await repos.auditEvents.append({ event_type: trader.published ? 'TRADER_MARKETPLACE_PUBLISHED' : 'TRADER_MARKETPLACE_UNPUBLISHED', actor: authz.actor, entity_type: 'trader', entity_id: String(trader.trader_id), payload: sod.auditPayload(authz, { published: trader.published === true, onboarding_status: trader.onboarding_status, verification_status: trader.verification_status, verified: trader.verified === true, trader_mode: trader.mode }) });
      send(res, 200, { trader, mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false }); return true;
    }
  } catch (error) {
    const safe = safeClientError(error);
    send(res, safe.status, { error: safe.code, mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false }); return true;
  }
  return false;
}
