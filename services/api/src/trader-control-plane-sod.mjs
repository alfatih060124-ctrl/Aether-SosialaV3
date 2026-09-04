const ROLE = Object.freeze({
  EVIDENCE_RECORDER: 'TRADER_EVIDENCE_RECORDER',
  VERIFIER: 'TRADER_VERIFIER',
  PUBLISHER: 'TRADER_PUBLISHER'
});

const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;

function cleanActor(value) {
  const actor = String(value ?? '').trim();
  if (!ACTOR_RE.test(actor)) throw new Error('trader_control_actor_invalid');
  return actor;
}

function requireRole(value) {
  const role = String(value ?? '').trim().toUpperCase();
  if (!Object.values(ROLE).includes(role)) throw new Error('trader_control_role_invalid');
  return role;
}

export const TRADER_CONTROL_PLANE_SOD_CONTRACT = Object.freeze({
  schema: 'aether.trader_control_plane.sod.v1',
  mode: 'SHADOW',
  live_execution_authorized: false,
  evidence_recording_does_not_verify: true,
  verification_does_not_publish: true,
  publication_requires_prior_verification: true,
  role_credentials_must_be_distinct: true,
  actor_reuse_across_sensitive_steps_forbidden: true,
  roles: ROLE
});

export function createTraderControlPrincipal({ actor, role } = {}) {
  return Object.freeze({ actor: cleanActor(actor), role: requireRole(role) });
}

export function authorizeEvidenceRecording(principal) {
  const p = createTraderControlPrincipal(principal);
  if (p.role !== ROLE.EVIDENCE_RECORDER) throw new Error('trader_evidence_recorder_role_required');
  return Object.freeze({
    authorized: true,
    actor: p.actor,
    role: p.role,
    verification_authorized: false,
    publication_authorized: false,
    live_execution_authorized: false
  });
}

export function authorizeVerification(principal, { evidence_recorded_by } = {}) {
  const p = createTraderControlPrincipal(principal);
  if (p.role !== ROLE.VERIFIER) throw new Error('trader_verifier_role_required');
  const evidenceActor = cleanActor(evidence_recorded_by);
  if (p.actor === evidenceActor) throw new Error('trader_verifier_must_differ_from_evidence_recorder');
  return Object.freeze({
    authorized: true,
    actor: p.actor,
    role: p.role,
    evidence_recorded_by: evidenceActor,
    publication_authorized: false,
    live_execution_authorized: false
  });
}

export function authorizePublication(principal, { verified, verification_actor, evidence_recorded_by } = {}) {
  const p = createTraderControlPrincipal(principal);
  if (p.role !== ROLE.PUBLISHER) throw new Error('trader_publisher_role_required');
  if (verified !== true) throw new Error('trader_publication_requires_prior_verification');
  const verificationActor = cleanActor(verification_actor);
  const evidenceActor = cleanActor(evidence_recorded_by);
  if (p.actor === verificationActor) throw new Error('trader_publisher_must_differ_from_verifier');
  if (p.actor === evidenceActor) throw new Error('trader_publisher_must_differ_from_evidence_recorder');
  if (verificationActor === evidenceActor) throw new Error('trader_verifier_must_differ_from_evidence_recorder');
  return Object.freeze({
    authorized: true,
    actor: p.actor,
    role: p.role,
    verification_actor: verificationActor,
    evidence_recorded_by: evidenceActor,
    live_execution_authorized: false
  });
}

export function assertDistinctTraderControlCredentials({ evidence_token_id, verifier_token_id, publisher_token_id } = {}) {
  const values = [evidence_token_id, verifier_token_id, publisher_token_id].map((value) => String(value ?? '').trim());
  if (values.some((value) => value.length < 8)) throw new Error('trader_control_credential_id_invalid');
  if (new Set(values).size !== values.length) throw new Error('trader_control_role_credentials_must_be_distinct');
  return true;
}
