import assert from 'node:assert/strict';
import { API_CONTRACT } from './api-contract.mjs';

const boundaries = API_CONTRACT.authority_boundaries;
assert(boundaries && typeof boundaries === 'object','authority_boundaries_required');

assert.deepEqual(boundaries.trader_evidence_recording, {
  route: 'POST /api/admin/traders/:traderId/evidence',
  may_record_evidence: true,
  may_verify_trader: false,
  may_publish_trader: false,
  live_execution_authorized: false
});
assert.equal(boundaries.trader_verification.requires_recorded_evidence,true);
assert.equal(boundaries.trader_verification.may_record_evidence,false);
assert.equal(boundaries.trader_verification.may_verify_trader,true);
assert.equal(boundaries.trader_verification.may_publish_trader,false);
assert.equal(boundaries.trader_publication.requires_prior_verification,true);
assert.equal(boundaries.trader_publication.may_record_evidence,false);
assert.equal(boundaries.trader_publication.may_verify_trader,false);
assert.equal(boundaries.trader_publication.may_publish_trader,true);

assert.equal(boundaries.copy_mandate.identity_authority,'WALLET_SESSION');
assert.equal(boundaries.copy_mandate.policy_authority,'BACKEND_PERSISTED');
assert.equal(boundaries.copy_mandate.caller_policy_authority,false);
assert.equal(boundaries.copy_mandate.requires_verified_trader,true);
assert.equal(boundaries.copy_mandate.requires_published_trader,true);

assert.equal(boundaries.auto_trade.identity_authority,'AUTHENTICATED_FOLLOWER_SESSION');
assert.equal(boundaries.auto_trade.mandate_authority,'BACKEND_PERSISTED');
assert.equal(boundaries.auto_trade.runtime_risk_authority,'BACKEND_PERSISTED');
assert.equal(boundaries.auto_trade.caller_identity_authority,false);
assert.equal(boundaries.auto_trade.caller_mandate_authority,false);
assert.equal(boundaries.auto_trade.caller_runtime_risk_authority,false);
assert.equal(boundaries.auto_trade.output_authority,'INTENT_ONLY');
assert.equal(boundaries.auto_trade.execution_dispatched,false);
assert.equal(boundaries.auto_trade.live_execution_authorized,false);
assert.equal(boundaries.auto_trade.network_submission_authorized,false);
assert.equal(boundaries.auto_trade.signer_required,false);

assert.equal(boundaries.fee_control.requester_role,'FEE_CONFIG_OPERATOR');
assert.equal(boundaries.fee_control.approver_role,'FEE_CONFIG_APPROVER');
assert.equal(boundaries.fee_control.applier_role,'FEE_CONFIG_APPLIER');
assert.equal(boundaries.fee_control.requester_must_differ_from_approver,true);
assert.equal(boundaries.fee_control.requester_must_differ_from_applier,true);
assert.equal(boundaries.fee_control.approver_must_differ_from_applier,true);

for (const [name,boundary] of Object.entries(boundaries)) {
  if ('live_execution_authorized' in boundary) {
    assert.equal(boundary.live_execution_authorized,false,`${name}_must_not_authorize_live`);
  }
}

assert.equal(API_CONTRACT.invariants.evidence_recording_does_not_verify,true);
assert.equal(API_CONTRACT.invariants.verification_does_not_publish,true);
assert.equal(API_CONTRACT.invariants.publication_requires_prior_verification,true);
assert.equal(API_CONTRACT.invariants.copy_mandate_requires_published_verified_trader,true);
assert.equal(API_CONTRACT.invariants.auto_trade_is_intent_only,true);
assert.equal(API_CONTRACT.invariants.caller_cannot_authorize_copy_mandate,true);
assert.equal(API_CONTRACT.invariants.caller_cannot_authorize_runtime_risk,true);
assert.equal(API_CONTRACT.invariants.fee_control_requires_three_party_separation,true);
assert.equal(API_CONTRACT.invariants.live_execution_authorized,false);
assert.equal(API_CONTRACT.invariants.auto_trade_execution_dispatched,false);

console.log('API separation-of-duties regression: PASS');
