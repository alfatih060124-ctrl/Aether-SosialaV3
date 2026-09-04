import assert from 'node:assert/strict';
import { handleTraderControlPlaneRoute } from '../services/api/src/trader-control-plane-route.mjs';
import { isTraderControlPlaneMutation } from '../services/api/src/trader-control-plane-runtime-sod.mjs';

const env = {
  ADMIN_API_TOKEN: 'admin-secret',
  TRADER_EVIDENCE_RECORDER_API_TOKEN: 'evidence-secret',
  TRADER_VERIFIER_API_TOKEN: 'verifier-secret',
  TRADER_PUBLISHER_API_TOKEN: 'publisher-secret',
};

const audit = [];
const pool = {
  async query(sql, params) {
    const [eventType, entityId] = params;
    const entityType = String(sql).includes("entity_type='trader_verification_evidence'") ? 'trader_verification_evidence' : 'trader';
    const rows = audit.filter(row => row.event_type === eventType && row.entity_type === entityType && row.entity_id === String(entityId)).slice(-1).reverse();
    return { rows };
  },
};

let verified = false;
const repos = {
  marketplace: {
    async recordTraderVerificationEvidence(traderId, body) {
      return { evidence_id: 'evidence-1', trader_id: traderId, source_type: body.source_type, source_reference: body.source_reference, observed_at: body.observed_at, evidence_status: 'READY' };
    },
    async reviewTraderVerification(traderId, body) {
      verified = String(body.decision || '').toUpperCase() === 'VERIFY';
      return { trader_id: traderId, verification_status: verified ? 'VERIFIED' : 'REJECTED', verified, published: false, verification_source: 'MANUAL_EVIDENCE', mode: 'SHADOW' };
    },
    async setTraderPublished(traderId, body) {
      if (!verified) throw new Error('trader_publication_gate_failed');
      return { trader_id: traderId, onboarding_status: 'APPROVED', verification_status: 'VERIFIED', verified: true, published: body.published === true, mode: 'SHADOW' };
    },
  },
  auditEvents: {
    async append(event) {
      audit.push({ ...event, created_at: new Date().toISOString() });
      return event;
    },
  },
};

const jsonBody = async req => req.body || {};
const invoke = async ({ method, parts, token, actor, body }) => {
  const req = { method, headers: { authorization: `Bearer ${token}`, 'x-aether-actor': actor }, body };
  let response;
  const send = (_res, status, payload) => { response = { status, payload }; };
  const handled = await handleTraderControlPlaneRoute({ req, res: {}, parts, pool, repos, jsonBody, send, env });
  return { handled, response };
};

assert.equal(isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence','collect'] }), false, 'collector route must remain outside Backend/Product SoD handler');
assert.equal(isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence'] }), true);

const sharedAdmin = await invoke({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence'], token: env.ADMIN_API_TOKEN, actor: 'admin.operator', body: { source_type: 'MANUAL', source_reference: 'ref-1', observed_at: '2026-09-05T00:00:00Z' } });
assert.equal(sharedAdmin.response.status, 401);
assert.equal(audit.length, 0);

const evidence = await invoke({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence'], token: env.TRADER_EVIDENCE_RECORDER_API_TOKEN, actor: 'evidence.operator', body: { source_type: 'MANUAL', source_reference: 'ref-1', observed_at: '2026-09-05T00:00:00Z' } });
assert.equal(evidence.response.status, 201);
assert.equal(audit[0].payload.actor_role, 'TRADER_EVIDENCE_RECORDER');
assert.equal(audit[0].payload.execution_dispatched, false);

const actorReuseVerify = await invoke({ method: 'PATCH', parts: ['api','admin','traders','trader-1','verification'], token: env.TRADER_VERIFIER_API_TOKEN, actor: 'evidence.operator', body: { decision: 'VERIFY', evidence_id: 'evidence-1' } });
assert.equal(actorReuseVerify.response.status, 403);
assert.equal(verified, false);

const verification = await invoke({ method: 'PATCH', parts: ['api','admin','traders','trader-1','verification'], token: env.TRADER_VERIFIER_API_TOKEN, actor: 'verification.operator', body: { decision: 'VERIFY', evidence_id: 'evidence-1' } });
assert.equal(verification.response.status, 200);
assert.equal(verification.response.payload.publication_authorized, false);
assert.equal(audit[1].payload.actor_role, 'TRADER_VERIFIER');

const actorReusePublish = await invoke({ method: 'PATCH', parts: ['api','admin','traders','trader-1','publication'], token: env.TRADER_PUBLISHER_API_TOKEN, actor: 'verification.operator', body: { published: true } });
assert.equal(actorReusePublish.response.status, 403);

const publication = await invoke({ method: 'PATCH', parts: ['api','admin','traders','trader-1','publication'], token: env.TRADER_PUBLISHER_API_TOKEN, actor: 'publication.operator', body: { published: true } });
assert.equal(publication.response.status, 200);
assert.equal(audit[2].payload.actor_role, 'TRADER_PUBLISHER');
assert.equal(audit[2].payload.execution_dispatched, false);
assert.equal(audit[2].payload.network_submission_authorized, false);
assert.equal(audit[2].payload.live_execution_authorized, false);
assert.equal(audit[2].payload.signer_required, false);

console.log('Trader Control Plane Endpoint SoD Regression: PASS');
