import assert from 'node:assert/strict';
import { createTraderControlPlaneRoleAuth, validateTraderControlPlaneRoleConfig } from '../services/api/src/trader-control-plane-role-auth.mjs';

const env = {
  ADMIN_API_TOKEN: 'legacy-admin-token',
  TRADER_EVIDENCE_RECORDER_API_TOKEN: 'evidence-token-01',
  TRADER_VERIFIER_API_TOKEN: 'verify-token-02',
  TRADER_PUBLISHER_API_TOKEN: 'publish-token-03',
};

const req = (token, actor) => ({ headers: { authorization: `Bearer ${token}`, 'x-aether-actor': actor } });
const auth = createTraderControlPlaneRoleAuth({ env });
let assertions = 0;
const ok = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const throws = (fn, message) => { assert.throws(fn); assertions += 1; if (message) process.stdout.write(`checked: ${message}\n`); };

ok(validateTraderControlPlaneRoleConfig(env) === true, 'role config should validate');
throws(() => validateTraderControlPlaneRoleConfig({ ...env, TRADER_PUBLISHER_API_TOKEN: env.TRADER_VERIFIER_API_TOKEN }), 'duplicate credentials fail closed');
throws(() => validateTraderControlPlaneRoleConfig({ ...env, TRADER_PUBLISHER_API_TOKEN: env.ADMIN_API_TOKEN }), 'shared admin credential fails closed');

const evidence = auth.authorize(req(env.TRADER_EVIDENCE_RECORDER_API_TOKEN, 'ops-evidence-01'), 'EVIDENCE');
ok(evidence.role === 'TRADER_EVIDENCE_RECORDER', 'evidence role bound');
ok(evidence.live_execution_authorized === false && evidence.execution_dispatched === false, 'SHADOW safety invariant');
throws(() => auth.authorize(req(env.ADMIN_API_TOKEN, 'ops-evidence-01'), 'EVIDENCE'), 'legacy admin token has no evidence authority');
throws(() => auth.authorize(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-evidence-01'), 'EVIDENCE'), 'verifier token cannot record evidence');

const verification = auth.authorize(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-verify-02'), 'VERIFICATION', { evidence_recorded_by: 'ops-evidence-01' });
ok(verification.role === 'TRADER_VERIFIER', 'verification role bound');
throws(() => auth.authorize(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-evidence-01'), 'VERIFICATION', { evidence_recorded_by: 'ops-evidence-01' }), 'evidence actor cannot verify');
throws(() => auth.authorize(req(env.TRADER_VERIFIER_API_TOKEN, 'ops-verify-02'), 'VERIFICATION'), 'verification requires evidence actor history');

const publication = auth.authorize(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-publish-03'), 'PUBLICATION', { evidence_recorded_by: 'ops-evidence-01', verified_by: 'ops-verify-02' });
ok(publication.role === 'TRADER_PUBLISHER', 'publication role bound');
ok(publication.shared_admin_token_authority === false && publication.signer_required === false, 'no shared admin or signer authority');
throws(() => auth.authorize(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-evidence-01'), 'PUBLICATION', { evidence_recorded_by: 'ops-evidence-01', verified_by: 'ops-verify-02' }), 'evidence actor cannot publish');
throws(() => auth.authorize(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-verify-02'), 'PUBLICATION', { evidence_recorded_by: 'ops-evidence-01', verified_by: 'ops-verify-02' }), 'verifier cannot publish');
throws(() => auth.authorize(req(env.TRADER_PUBLISHER_API_TOKEN, 'ops-publish-03'), 'PUBLICATION', { evidence_recorded_by: 'ops-evidence-01', verified_by: 'ops-evidence-01' }), 'historical evidence/verifier reuse fails closed');
throws(() => auth.authorize(req(env.TRADER_PUBLISHER_API_TOKEN, 'bad actor'), 'PUBLICATION', { evidence_recorded_by: 'ops-evidence-01', verified_by: 'ops-verify-02' }), 'malformed actor fails closed');

console.log(JSON.stringify({ regression: 'Trader Control Plane Role Auth Regression', assertions, status: 'GREEN', mode: 'SHADOW', live_execution_authorized: false }, null, 2));
