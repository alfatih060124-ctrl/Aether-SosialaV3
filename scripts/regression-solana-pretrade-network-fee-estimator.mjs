import assert from 'node:assert/strict';
import { createSolanaPretradeNetworkFeeEstimator } from '../services/api/src/solana-pretrade-network-fee-estimator.mjs';

const NOW = Date.parse('2026-09-05T16:45:00.000Z');
const observed = '2026-09-05T16:44:55.000Z';

function build(overrides = {}) {
  return createSolanaPretradeNetworkFeeEstimator({
    now: () => NOW,
    maxEvidenceAgeMs: 15_000,
    loadUnsignedMessageEvidence: async () => ({ verified: true, message_base64: 'dW5zaWduZWQ=', source_reference: 'message:two-leg', observed_at: observed, signed: false, signer_requested: false }),
    getFeeForMessage: async () => ({ verified: true, base_fee_lamports: 5000, source_slot: 123, source_reference: 'rpc:getFeeForMessage@123', observed_at: observed }),
    simulateUnsignedTransaction: async () => ({ verified: true, compute_units_consumed: 300000, source_slot: 123, source_reference: 'rpc:simulateTransaction@123', observed_at: observed }),
    loadPriorityFeeEvidence: async () => ({ verified: true, micro_lamports_per_compute_unit: 1000, source_slot: 123, source_reference: 'rpc:getRecentPrioritizationFees@123', observed_at: observed }),
    loadCurrentSolUsdEvidence: async () => ({ verified: true, sol_usd: 200, source_slot: 123, source_reference: 'price:SOLUSD@123', observed_at: observed }),
    ...overrides
  });
}

const estimator = build();
const result = await estimator.estimate({ opportunity_id: 'opp-1' });
assert.equal(result.verified, true);
assert.equal(result.network_fee_verified, true);
assert.equal(result.base_fee_lamports, 5000);
assert.equal(result.priority_fee_lamports, 300);
assert.equal(result.total_roundtrip_fee_lamports, 5300);
assert.equal(result.network_fee_usdc, 0.00106);
assert.equal(result.source_slot, 123);
assert.equal(result.transaction_signed, false);
assert.equal(result.signer_requested, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.live_execution_authorized, false);

await assert.rejects(
  build({ getFeeForMessage: async () => ({ verified: false }) }).estimate(),
  /pretrade_base_fee_evidence_required_unverified/
);

await assert.rejects(
  build({ simulateUnsignedTransaction: async () => ({ verified: true, compute_units_consumed: 300000, source_slot: 124, source_reference: 'sim@124', observed_at: observed }) }).estimate(),
  /pretrade_simulation_slot_mismatch/
);

await assert.rejects(
  build({ loadPriorityFeeEvidence: async () => ({ verified: true, micro_lamports_per_compute_unit: 1000, source_slot: 123, source_reference: 'priority@123', observed_at: '2026-09-05T16:44:00.000Z' }) }).estimate(),
  /pretrade_priority_observed_at_stale/
);

await assert.rejects(
  build({ loadUnsignedMessageEvidence: async () => ({ verified: true, message_base64: 'dW5zaWduZWQ=', source_reference: 'message:bad', observed_at: observed, signed: true }) }).estimate(),
  /pretrade_unsigned_message_boundary_violation/
);

console.log('solana pretrade network fee estimator regression ok');
