import assert from 'node:assert/strict';
import { handleTraderControlPlaneRoute } from '../services/api/src/trader-control-plane-route.mjs';

const env = {
  ADMIN_API_TOKEN: 'TEST_ONLY_ADMIN_TOKEN',
  TRADER_EVIDENCE_RECORDER_API_TOKEN: 'TEST_ONLY_EVIDENCE_TOKEN',
  TRADER_VERIFIER_API_TOKEN: 'TEST_ONLY_VERIFIER_TOKEN',
  TRADER_PUBLISHER_API_TOKEN: 'TEST_ONLY_PUBLISHER_TOKEN',
};

const pool = { async query() { return { rows: [] }; } };
const jsonBody = async req => req.body || {};

async function invoke({ parts, token = env.TRADER_EVIDENCE_RECORDER_API_TOKEN, actor = 'evidence.operator', repos }) {
  const req = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-aether-actor': actor,
    },
    body: { source_type: 'MANUAL', source_reference: 'ref-1', observed_at: '2026-09-05T00:00:00Z' },
  };
  let response;
  const send = (_res, status, payload) => { response = { status, payload }; };
  const handled = await handleTraderControlPlaneRoute({ req, res: {}, parts, pool, repos, jsonBody, send, env });
  return { handled, response };
}

let malformedReachedRepository = false;
const malformedRepos = {
  marketplace: {
    async recordTraderVerificationEvidence() {
      malformedReachedRepository = true;
      return { evidence_id: 'unexpected' };
    },
  },
  auditEvents: { async append() {} },
};

const malformed = await invoke({
  parts: ['api', 'admin', 'traders', 'not-a-uuid', 'evidence'],
  repos: malformedRepos,
});
assert.equal(malformed.handled, true);
assert.equal(malformedReachedRepository, false, 'malformed trader UUID must fail before repository access');
assert.ok([400, 404, 422].includes(malformed.response?.status), 'malformed trader UUID must be rejected as client input');
assert.equal(malformed.response?.payload?.live_execution_authorized, false);
assert.equal(malformed.response?.payload?.execution_dispatched, false);
assert.equal(malformed.response?.payload?.mode, 'SHADOW');

const INTERNAL_SENTINEL = 'postgres://internal-host:5432/aether relation trader_secret missing';
const throwingRepos = {
  marketplace: {
    async recordTraderVerificationEvidence() {
      throw new Error(INTERNAL_SENTINEL);
    },
  },
  auditEvents: { async append() {} },
};

const internalFailure = await invoke({
  parts: ['api', 'admin', 'traders', '11111111-1111-4111-8111-111111111111', 'evidence'],
  repos: throwingRepos,
});
assert.equal(internalFailure.handled, true);
assert.equal(internalFailure.response?.payload?.live_execution_authorized, false);
assert.equal(internalFailure.response?.payload?.execution_dispatched, false);
assert.equal(internalFailure.response?.payload?.mode, 'SHADOW');
assert.notEqual(internalFailure.response?.payload?.error, INTERNAL_SENTINEL, 'unexpected internal error must not be reflected to client');
assert.ok(!JSON.stringify(internalFailure.response?.payload || {}).includes('internal-host'), 'response must not expose internal host detail');
assert.ok(!JSON.stringify(internalFailure.response?.payload || {}).includes('trader_secret'), 'response must not expose internal schema detail');

console.log('Trader Control Plane Input/Error Boundary Regression: PASS');
