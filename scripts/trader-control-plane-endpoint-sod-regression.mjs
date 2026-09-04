import assert from 'node:assert/strict';
import { handleTraderControlPlaneRoute } from '../services/api/src/trader-control-plane-route.mjs';
import { isTraderControlPlaneMutation } from '../services/api/src/trader-control-plane-runtime-sod.mjs';

const TRADER_ID = '11111111-1111-4111-8111-111111111111';
const env = { ADMIN_API_TOKEN: 'TEST_ONLY_ADMIN_TOKEN', TRADER_EVIDENCE_RECORDER_API_TOKEN: 'TEST_ONLY_EVIDENCE_TOKEN', TRADER_VERIFIER_API_TOKEN: 'TEST_ONLY_VERIFIER_TOKEN', TRADER_PUBLISHER_API_TOKEN: 'TEST_ONLY_PUBLISHER_TOKEN' };
const audit = [];
const pool = { async query(sql, params) { const [eventType, entityId] = params; const entityType = String(sql).includes("entity_type='trader_verification_evidence'") ? 'trader_verification_evidence' : 'trader'; return { rows: audit.filter(row => row.event_type === eventType && row.entity_type === entityType && row.entity_id === String(entityId)).slice(-1).reverse() }; } };
let verified = false;
let repositoryCalls = 0;
const repos = {
  marketplace: {
    async recordTraderVerificationEvidence(traderId, body) { repositoryCalls++; return { evidence_id: 'evidence-1', trader_id: traderId, source_type: body.source_type, source_reference: body.source_reference, observed_at: body.observed_at, evidence_status: 'READY' }; },
    async reviewTraderVerification(traderId, body) { verified = String(body.decision || '').toUpperCase() === 'VERIFY'; return { trader_id: traderId, verification_status: verified ? 'VERIFIED' : 'REJECTED', verified, published: false, verification_source: 'MANUAL_EVIDENCE', mode: 'SHADOW' }; },
    async setTraderPublished(traderId, body) { if (!verified) throw new Error('trader_publication_gate_failed'); return { trader_id: traderId, onboarding_status: 'APPROVED', verification_status: 'VERIFIED', verified: true, published: body.published === true, mode: 'SHADOW' }; },
  },
  auditEvents: { async append(event) { audit.push({ ...event, created_at: new Date().toISOString() }); return event; } },
};
const jsonBody = async req => req.body || {};
async function invoke({ method, traderId = TRADER_ID, suffix, token, actor, body, customRepos = repos }) {
  const parts = ['api','admin','traders',traderId,...suffix];
  const req = { method, headers: { authorization: `Bearer ${token}`, 'x-aether-actor': actor }, body };
  let response; const send = (_res, status, payload) => { response = { status, payload }; };
  const handled = await handleTraderControlPlaneRoute({ req, res: {}, parts, pool, repos: customRepos, jsonBody, send, env });
  return { handled, response };
}

assert.equal(isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders',TRADER_ID,'evidence','collect'] }), false, 'collector route must remain outside Backend/Product SoD handler');
assert.equal(isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders',TRADER_ID,'evidence'] }), true);

const malformed = await invoke({ method: 'POST', traderId: 'not-a-uuid', suffix: ['evidence'], token: env.TRADER_EVIDENCE_RECORDER_API_TOKEN, actor: 'evidence.operator', body: {} });
assert.equal(malformed.response.status, 400); assert.equal(repositoryCalls, 0); assert.equal(malformed.response.payload.execution_dispatched, false); assert.equal(malformed.response.payload.live_execution_authorized, false);

const sharedAdmin = await invoke({ method: 'POST', suffix: ['evidence'], token: env.ADMIN_API_TOKEN, actor: 'admin.operator', body: { source_type: 'MANUAL', source_reference: 'ref-1', observed_at: '2026-09-05T00:00:00Z' } });
assert.equal(sharedAdmin.response.status, 401); assert.equal(audit.length, 0);
const evidence = await invoke({ method: 'POST', suffix: ['evidence'], token: env.TRADER_EVIDENCE_RECORDER_API_TOKEN, actor: 'evidence.operator', body: { source_type: 'MANUAL', source_reference: 'ref-1', observed_at: '2026-09-05T00:00:00Z' } });
assert.equal(evidence.response.status, 201); assert.equal(audit[0].payload.actor_role, 'TRADER_EVIDENCE_RECORDER'); assert.equal(audit[0].payload.execution_dispatched, false);
const actorReuseVerify = await invoke({ method: 'PATCH', suffix: ['verification'], token: env.TRADER_VERIFIER_API_TOKEN, actor: 'evidence.operator', body: { decision: 'VERIFY', evidence_id: 'evidence-1' } });
assert.equal(actorReuseVerify.response.status, 403); assert.equal(verified, false);
const verification = await invoke({ method: 'PATCH', suffix: ['verification'], token: env.TRADER_VERIFIER_API_TOKEN, actor: 'verification.operator', body: { decision: 'VERIFY', evidence_id: 'evidence-1' } });
assert.equal(verification.response.status, 200); assert.equal(verification.response.payload.publication_authorized, false); assert.equal(audit[1].payload.actor_role, 'TRADER_VERIFIER');
const actorReusePublish = await invoke({ method: 'PATCH', suffix: ['publication'], token: env.TRADER_PUBLISHER_API_TOKEN, actor: 'verification.operator', body: { published: true } });
assert.equal(actorReusePublish.response.status, 403);
const publication = await invoke({ method: 'PATCH', suffix: ['publication'], token: env.TRADER_PUBLISHER_API_TOKEN, actor: 'publication.operator', body: { published: true } });
assert.equal(publication.response.status, 200); assert.equal(audit[2].payload.actor_role, 'TRADER_PUBLISHER'); assert.equal(audit[2].payload.execution_dispatched, false); assert.equal(audit[2].payload.network_submission_authorized, false); assert.equal(audit[2].payload.live_execution_authorized, false); assert.equal(audit[2].payload.signer_required, false);

const INTERNAL_SENTINEL = 'postgres://internal-host:5432/aether relation trader_secret missing';
const throwingRepos = { marketplace: { async recordTraderVerificationEvidence() { throw new Error(INTERNAL_SENTINEL); } }, auditEvents: { async append() {} } };
const internalFailure = await invoke({ method: 'POST', suffix: ['evidence'], token: env.TRADER_EVIDENCE_RECORDER_API_TOKEN, actor: 'evidence.operator', body: {}, customRepos: throwingRepos });
assert.equal(internalFailure.response.status, 500); assert.equal(internalFailure.response.payload.error, 'trader_control_plane_request_rejected'); assert.ok(!JSON.stringify(internalFailure.response.payload).includes('internal-host')); assert.ok(!JSON.stringify(internalFailure.response.payload).includes('trader_secret'));

console.log('Trader Control Plane Endpoint SoD Regression: PASS');
