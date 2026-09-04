import { createTraderControlPlaneRoleAuth } from './trader-control-plane-role-auth.mjs';

const EVIDENCE_EVENT = 'TRADER_VERIFICATION_EVIDENCE_RECORDED';
const VERIFICATION_EVENT = 'TRADER_DATA_VERIFICATION_REVIEWED';
const ROLE_EVIDENCE = 'TRADER_EVIDENCE_RECORDER';
const ROLE_VERIFIER = 'TRADER_VERIFIER';
function cleanId(value, code) { const id = String(value || '').trim(); if (!id || id.length > 160) throw new Error(code); return id; }
function payloadOf(row) { if (!row?.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw new Error('trader_control_plane_audit_history_invalid'); return row.payload; }

export function isTraderControlPlaneMutation({ method, parts = [] } = {}) {
  const verb = String(method || '').toUpperCase();
  if (parts[0] !== 'api' || parts[1] !== 'admin' || parts[2] !== 'traders' || !parts[3]) return false;
  if (verb === 'POST' && parts[4] === 'evidence' && !parts[5]) return true;
  if (verb === 'PATCH' && parts[4] === 'verification' && !parts[5]) return true;
  if (verb === 'PATCH' && parts[4] === 'publication' && !parts[5]) return true;
  return false;
}

export function createTraderControlPlaneRuntimeSoD({ pool, env = process.env } = {}) {
  if (!pool?.query) throw new Error('trader_control_plane_pool_required');
  const roleAuth = createTraderControlPlaneRoleAuth({ env });
  async function evidenceHistory(traderId, evidenceId) {
    const t = cleanId(traderId, 'trader_id_required'); const e = cleanId(evidenceId, 'evidence_id_required');
    const row = (await pool.query(`SELECT actor,payload,created_at FROM audit_events WHERE event_type=$1 AND entity_type='trader_verification_evidence' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1`, [EVIDENCE_EVENT, e])).rows?.[0];
    if (!row) throw new Error('trader_control_plane_evidence_audit_required');
    const payload = payloadOf(row);
    if (String(payload.trader_id || '') !== t || payload.actor_role !== ROLE_EVIDENCE) throw new Error('trader_control_plane_evidence_audit_invalid');
    return { actor: cleanId(row.actor, 'trader_control_plane_evidence_actor_required'), evidence_id: e };
  }
  async function latestVerificationHistory(traderId) {
    const t = cleanId(traderId, 'trader_id_required');
    const row = (await pool.query(`SELECT actor,payload,created_at FROM audit_events WHERE event_type=$1 AND entity_type='trader' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1`, [VERIFICATION_EVENT, t])).rows?.[0];
    if (!row) throw new Error('trader_control_plane_verification_audit_required');
    const payload = payloadOf(row);
    if (String(payload.decision || '').toUpperCase() !== 'VERIFY' || payload.actor_role !== ROLE_VERIFIER || payload.verified !== true) throw new Error('trader_control_plane_verification_audit_invalid');
    return { actor: cleanId(row.actor, 'trader_control_plane_verifier_actor_required'), evidence_id: cleanId(payload.evidence_id, 'evidence_id_required') };
  }
  const authorizeEvidence = async req => roleAuth.authorize(req, 'EVIDENCE');
  const authorizeVerification = async (req, { traderId, evidenceId } = {}) => { const evidence = await evidenceHistory(traderId, evidenceId); return roleAuth.authorize(req, 'VERIFICATION', { evidence_recorded_by: evidence.actor }); };
  const authorizePublication = async (req, { traderId } = {}) => { const verification = await latestVerificationHistory(traderId); const evidence = await evidenceHistory(traderId, verification.evidence_id); return roleAuth.authorize(req, 'PUBLICATION', { evidence_recorded_by: evidence.actor, verified_by: verification.actor }); };
  function auditPayload(authz, payload = {}) {
    if (!authz?.actor || !authz?.role || authz.live_execution_authorized !== false) throw new Error('trader_control_plane_authorization_required');
    return Object.freeze({ ...payload, actor_role: authz.role, actor_capability: authz.capability, role_auth_contract: authz.contract, mode: 'SHADOW', execution_dispatched: false, network_submission_authorized: false, live_execution_authorized: false, signer_required: false });
  }
  return Object.freeze({ contract: 'aether.trader_control_plane.runtime_sod.v1', authorizeEvidence, authorizeVerification, authorizePublication, evidenceHistory, latestVerificationHistory, auditPayload });
}
