import assert from 'node:assert/strict';
import { evaluateMarketplacePublicationGate } from './marketplace-publication-gate.mjs';

const base = Object.freeze({
  trader_id: 'trader_001',
  mode: 'SHADOW',
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false,
  evidence_recorded: true,
  verification_status: 'VERIFIED',
  publication_status: 'PUBLISHED'
});

const allowed = evaluateMarketplacePublicationGate(base);
assert.equal(allowed.allowed, true);
assert.equal(allowed.marketplace_visible, true);
assert.equal(allowed.live_execution_authorized, false);
assert.equal(allowed.network_submission_authorized, false);
assert.equal(allowed.signer_required, false);

const evidenceOnly = evaluateMarketplacePublicationGate({
  ...base,
  verification_status: 'PENDING',
  publication_status: 'UNPUBLISHED'
});
assert.equal(evidenceOnly.allowed, false);
assert.equal(evidenceOnly.reason, 'trader_verification_required');
assert.equal(evidenceOnly.marketplace_visible, false);

const verifiedNotPublished = evaluateMarketplacePublicationGate({
  ...base,
  publication_status: 'UNPUBLISHED'
});
assert.equal(verifiedNotPublished.allowed, false);
assert.equal(verifiedNotPublished.reason, 'trader_publication_required');
assert.equal(verifiedNotPublished.marketplace_visible, false);

const publishedWithoutVerification = evaluateMarketplacePublicationGate({
  ...base,
  verification_status: 'REJECTED'
});
assert.equal(publishedWithoutVerification.allowed, false);
assert.equal(publishedWithoutVerification.reason, 'trader_verification_required');

const missingEvidence = evaluateMarketplacePublicationGate({
  ...base,
  evidence_recorded: false
});
assert.equal(missingEvidence.allowed, false);
assert.equal(missingEvidence.reason, 'evidence_recording_required');

for (const [field, value] of [
  ['mode', 'LIVE'],
  ['live_execution_authorized', true],
  ['network_submission_authorized', true],
  ['signer_required', true]
]) {
  assert.throws(
    () => evaluateMarketplacePublicationGate({ ...base, [field]: value }),
    /required/
  );
}

for (const trader_id of ['', ' trader_001', 'trader 001']) {
  assert.throws(
    () => evaluateMarketplacePublicationGate({ ...base, trader_id }),
    /trader_id_invalid/
  );
}

console.log('marketplace publication gate regression: ok');
