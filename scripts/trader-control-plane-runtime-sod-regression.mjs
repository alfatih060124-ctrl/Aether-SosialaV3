import assert from 'node:assert/strict';
import { createTraderControlPlaneRuntimeSoD, isTraderControlPlaneMutation } from '../services/api/src/trader-control-plane-runtime-sod.mjs';

const env = {
  ADMIN_API_TOKEN: 'legacy-admin-token',
  TRADER_EVIDENCE_RECORDER_API_TOKEN: 'evidence-token-01',
  TRADER_VERIFIER_API_TOKEN: 'verify-token-02',
  TRADER_PUBLISHER_API_TOKEN: 'publish-token-03',
};
const req = (token, actor) => ({ headers: { authorization: `Bearer ${token}`, 'x-aether-actor': actor } });
const rows = new Map();
const pool = {
  async query(sql, params) {
    const [eventType, entityId] = params || [];
    const key = `${eventType}:${entityId}`;
    return { rows: rows.has(key) ? [rows.get(key)] : [] };
  },
};
const runtime = createTraderControlPlaneRuntimeSoD({ pool, env });
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const rejects = async (fn, expected) => { await assert.rejects(fn, expected); assertions += 1; };

ok(isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence'] }), 'manual evidence is sensitive');
ok(isTraderControlPlaneMutation({ method: 'PATCH', parts: ['api','admin','traders','trader-1','verification'] }), 'verification is sensitive');
ok(isTraderControlPlaneMutation({ method: 'PATCH', parts: ['api','admin','traders','trader-1','publication'] }), 'publication is sensitive');
ok(!isTraderControlPlaneMutation({ method: 'POST', parts: ['api','admin','traders','trader-1','evidence','collect'] }), 'collector invocation remains outside human control-plane mutation boundary');

const evidenceAuth = await runtime.authorizeEvidence(req(env.TRADER_EVIDENCE_RECORDER_API_TOKEN, 'ops-evidence-01'));
ok(evidenceAuth.role === 'TRADER_EVIDENCE_RECORDER', 'evidence role bound');
ok(evidenceAuth.live_execution_authorized === false && evidenceAuth.signer_required === false, 'SHADOW safety invariant');
await rejects(() => runtime.authorizeEvidence(req(env.ADMIN_API_TOKEN, 'ops-evidence-01')), /role_unauthorized/);

rows.set('TRADER_VERIFICATION_EVIDENCE_RECORDED:evidence-1', {
  actor: 'ops-evidence-01',
  payload: { trader_id: 'trader-1', actor_role: 'TRADER_EVIDENCE_RECORDER' },
  created_at: new Date().toISOString(),
});
const verifyAuth = await runtime.authorizeVerification(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-verify-02'), { traderId: 'trader-1', evidenceId: 'evidence-1' });
ok(verifyAuth.role === 'TRADER_VERIFIER', 'verifier role bound to prior evidence history');
await rejects(() => runtime.authorizeVerification(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-evidence-01'), { traderId: 'trader-1', evidenceId: 'evidence-1' }), /actor_reuse_forbidden/);
await rejects(() => runtime.authorizeVerification(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-verify-02'), { traderId: 'trader-1', evidenceId: 'missing' }), /evidence_audit_required/);

rows.set('TRADER_DATA_VERIFICATION_REVIEWED:trader-1', {
  actor: 'ops-verify-02',
  payload: { decision: 'VERIFY', verified: true, evidence_id: 'evidence-1', actor_role: 'TRADER_VERIFIER' },
  created_at: new Date().toISOString(),
});
const publishAuth = await runtime.authorizePublication(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-publish-03'), { traderId: 'trader-1' });
ok(publishAuth.role === 'TRADER_PUBLISHER', 'publisher role requires immutable evidence + verifier history');
ok(publishAuth.execution_dispatched === false && publishAuth.network_submission_authorized === false, 'publication has no execution authority');
await rejects(() => runtime.authorizePublication(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-verify-02'), { traderId: 'trader-1' }), /actor_reuse_forbidden/);
await rejects(() => runtime.authorizePublication(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-evidence-01'), { traderId: 'trader-1' }), /actor_reuse_forbidden/);

rows.set('TRADER_DATA_VERIFICATION_REVIEWED:trader-legacy', {
  actor: 'admin',
  payload: { decision: 'VERIFY', verified: true, evidence_id: 'legacy-evidence' },
  created_at: new Date().toISOString(),
});
await rejects(() => runtime.authorizePublication(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-publish-03'), { traderId: 'trader-legacy' }), /verification_audit_invalid/);

const audit = runtime.auditPayload(publishAuth, { published: true, trader_id: 'trader-1' });
ok(audit.actor_role === 'TRADER_PUBLISHER' && audit.actor_capability === 'PUBLICATION', 'audit persists role metadata');
ok(audit.mode === 'SHADOW' && audit.live_execution_authorized === false && audit.signer_required === false, 'audit remains fail-closed');

console.log(JSON.stringify({ regression: 'Trader Control Plane Runtime SoD Regression', assertions, status: 'GREEN', mode: 'SHADOW', live_execution_authorized: false }, null, 2));
