import assert from 'node:assert/strict';
import {
  TRADER_CONTROL_PLANE_SOD_CONTRACT,
  authorizeEvidenceRecording,
  authorizeVerification,
  authorizePublication,
  assertDistinctTraderControlCredentials
} from '../services/api/src/trader-control-plane-sod.mjs';

assert.equal(TRADER_CONTROL_PLANE_SOD_CONTRACT.mode, 'SHADOW');
assert.equal(TRADER_CONTROL_PLANE_SOD_CONTRACT.live_execution_authorized, false);
assert.equal(TRADER_CONTROL_PLANE_SOD_CONTRACT.evidence_recording_does_not_verify, true);
assert.equal(TRADER_CONTROL_PLANE_SOD_CONTRACT.verification_does_not_publish, true);

const evidence = authorizeEvidenceRecording({ actor: 'ops:evidence-01', role: 'TRADER_EVIDENCE_RECORDER' });
assert.equal(evidence.verification_authorized, false);
assert.equal(evidence.publication_authorized, false);
assert.equal(evidence.live_execution_authorized, false);

assert.throws(
  () => authorizeEvidenceRecording({ actor: 'ops:verifier-01', role: 'TRADER_VERIFIER' }),
  /trader_evidence_recorder_role_required/
);

const verification = authorizeVerification(
  { actor: 'ops:verifier-01', role: 'TRADER_VERIFIER' },
  { evidence_recorded_by: 'ops:evidence-01' }
);
assert.equal(verification.publication_authorized, false);
assert.equal(verification.live_execution_authorized, false);

assert.throws(
  () => authorizeVerification(
    { actor: 'ops:evidence-01', role: 'TRADER_VERIFIER' },
    { evidence_recorded_by: 'ops:evidence-01' }
  ),
  /trader_verifier_must_differ_from_evidence_recorder/
);

assert.throws(
  () => authorizePublication(
    { actor: 'ops:publisher-01', role: 'TRADER_PUBLISHER' },
    { verified: false, verification_actor: 'ops:verifier-01' }
  ),
  /trader_publication_requires_prior_verification/
);

const publication = authorizePublication(
  { actor: 'ops:publisher-01', role: 'TRADER_PUBLISHER' },
  { verified: true, verification_actor: 'ops:verifier-01' }
);
assert.equal(publication.live_execution_authorized, false);

assert.throws(
  () => authorizePublication(
    { actor: 'ops:verifier-01', role: 'TRADER_PUBLISHER' },
    { verified: true, verification_actor: 'ops:verifier-01' }
  ),
  /trader_publisher_must_differ_from_verifier/
);

assert.equal(assertDistinctTraderControlCredentials({
  evidence_token_id: 'cred-evidence-v1',
  verifier_token_id: 'cred-verifier-v1',
  publisher_token_id: 'cred-publisher-v1'
}), true);
assert.throws(
  () => assertDistinctTraderControlCredentials({
    evidence_token_id: 'same-token-id',
    verifier_token_id: 'same-token-id',
    publisher_token_id: 'publisher-token-id'
  }),
  /trader_control_role_credentials_must_be_distinct/
);

console.log(JSON.stringify({ ok: true, contract: TRADER_CONTROL_PLANE_SOD_CONTRACT.schema, tests: 12, posture: 'SHADOW_FAIL_CLOSED' }));
