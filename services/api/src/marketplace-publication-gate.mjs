const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireCanonicalId(value, field) {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function requireExact(value, expected, field) {
  if (value !== expected) throw new Error(`${field}_required`);
  return value;
}

export const MARKETPLACE_PUBLICATION_GATE_CONTRACT = Object.freeze({
  schema: 'aether.marketplace_publication_gate.v1',
  mode: 'SHADOW',
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false,
  evidence_recording_does_not_verify: true,
  verification_does_not_publish: true,
  publication_requires_prior_verification: true
});

export function evaluateMarketplacePublicationGate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('marketplace_gate_input_required');
  }

  const traderId = requireCanonicalId(input.trader_id, 'trader_id');
  requireExact(input.mode, 'SHADOW', 'shadow_mode');
  requireExact(input.live_execution_authorized, false, 'live_execution_authorized_false');
  requireExact(input.network_submission_authorized, false, 'network_submission_authorized_false');
  requireExact(input.signer_required, false, 'signer_required_false');

  if (input.evidence_recorded !== true) {
    return Object.freeze({
      allowed: false,
      reason: 'evidence_recording_required',
      trader_id: traderId,
      marketplace_visible: false,
      ...MARKETPLACE_PUBLICATION_GATE_CONTRACT
    });
  }

  if (input.verification_status !== 'VERIFIED') {
    return Object.freeze({
      allowed: false,
      reason: 'trader_verification_required',
      trader_id: traderId,
      marketplace_visible: false,
      ...MARKETPLACE_PUBLICATION_GATE_CONTRACT
    });
  }

  if (input.publication_status !== 'PUBLISHED') {
    return Object.freeze({
      allowed: false,
      reason: 'trader_publication_required',
      trader_id: traderId,
      marketplace_visible: false,
      ...MARKETPLACE_PUBLICATION_GATE_CONTRACT
    });
  }

  return Object.freeze({
    allowed: true,
    reason: 'marketplace_publication_allowed',
    trader_id: traderId,
    marketplace_visible: true,
    ...MARKETPLACE_PUBLICATION_GATE_CONTRACT
  });
}
