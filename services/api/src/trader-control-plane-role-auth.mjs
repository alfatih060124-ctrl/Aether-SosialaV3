import { timingSafeEqual } from 'node:crypto';

export const TRADER_CONTROL_PLANE_ROLE_AUTH_CONTRACT = Object.freeze({
  contract: 'aether.trader_control_plane.role_auth.v1',
  mode: 'SHADOW',
  live_execution_authorized: false,
  shared_admin_token_authority: false,
  roles: Object.freeze({
    EVIDENCE: 'TRADER_EVIDENCE_RECORDER',
    VERIFICATION: 'TRADER_VERIFIER',
    PUBLICATION: 'TRADER_PUBLISHER',
  }),
});

const ROLE_CONFIG = Object.freeze({
  EVIDENCE: { role: 'TRADER_EVIDENCE_RECORDER', env: 'TRADER_EVIDENCE_RECORDER_API_TOKEN' },
  VERIFICATION: { role: 'TRADER_VERIFIER', env: 'TRADER_VERIFIER_API_TOKEN' },
  PUBLICATION: { role: 'TRADER_PUBLISHER', env: 'TRADER_PUBLISHER_API_TOKEN' },
});

const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/;

function bearerToken(req) {
  const value = String(req?.headers?.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function actorHeader(req) {
  return String(req?.headers?.['x-aether-actor'] || '').trim();
}

function sameSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredSecrets(env) {
  return Object.fromEntries(Object.entries(ROLE_CONFIG).map(([key, config]) => [key, String(env?.[config.env] || '').trim()]));
}

export function validateTraderControlPlaneRoleConfig(env = process.env) {
  const secrets = configuredSecrets(env);
  for (const [key, config] of Object.entries(ROLE_CONFIG)) {
    if (!secrets[key]) throw new Error(`trader_control_plane_${config.role.toLowerCase()}_credential_required`);
  }
  const values = Object.values(secrets);
  if (new Set(values).size !== values.length) throw new Error('trader_control_plane_role_credentials_must_be_distinct');
  if (env?.ADMIN_API_TOKEN && values.includes(String(env.ADMIN_API_TOKEN).trim())) throw new Error('trader_control_plane_shared_admin_credential_forbidden');
  return true;
}

export function createTraderControlPlaneRoleAuth({ env = process.env } = {}) {
  validateTraderControlPlaneRoleConfig(env);
  const secrets = configuredSecrets(env);

  function authorize(req, capability, history = {}) {
    const config = ROLE_CONFIG[capability];
    if (!config) throw new Error('trader_control_plane_capability_invalid');
    const actor = actorHeader(req);
    if (!ACTOR_RE.test(actor)) throw new Error('trader_control_plane_actor_invalid');
    const supplied = bearerToken(req);
    if (!sameSecret(supplied, secrets[capability])) throw new Error('trader_control_plane_role_unauthorized');

    const evidenceRecordedBy = String(history.evidence_recorded_by || '').trim();
    const verifiedBy = String(history.verified_by || '').trim();
    if (capability === 'VERIFICATION') {
      if (!ACTOR_RE.test(evidenceRecordedBy)) throw new Error('trader_control_plane_evidence_actor_required');
      if (actor === evidenceRecordedBy) throw new Error('trader_control_plane_actor_reuse_forbidden');
    }
    if (capability === 'PUBLICATION') {
      if (!ACTOR_RE.test(evidenceRecordedBy) || !ACTOR_RE.test(verifiedBy)) throw new Error('trader_control_plane_prior_actor_context_required');
      if (verifiedBy === evidenceRecordedBy || actor === evidenceRecordedBy || actor === verifiedBy) throw new Error('trader_control_plane_actor_reuse_forbidden');
    }

    return Object.freeze({
      contract: TRADER_CONTROL_PLANE_ROLE_AUTH_CONTRACT.contract,
      actor,
      role: config.role,
      capability,
      credential_source: config.env,
      caller_authority: false,
      shared_admin_token_authority: false,
      execution_dispatched: false,
      network_submission_authorized: false,
      live_execution_authorized: false,
      signer_required: false,
      mode: 'SHADOW',
    });
  }

  return Object.freeze({ contract: TRADER_CONTROL_PLANE_ROLE_AUTH_CONTRACT, authorize });
}
