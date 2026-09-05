const LAMPORTS_PER_SOL = 1_000_000_000;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, code) => { const v = String(value || '').trim(); if (!v) throw new Error(code); return v; };

function safeInt(value, code, min = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(code);
  return n;
}

function freshIso(value, now, maxAgeMs, code) {
  const raw = text(value, code);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(code);
  const age = now - ms;
  if (age < 0) throw new Error(`${code}_future`);
  if (age > maxAgeMs) throw new Error(`${code}_stale`);
  return new Date(ms).toISOString();
}

function verifiedObject(value, code) {
  if (!value || typeof value !== 'object') throw new Error(code);
  if (value.verified !== true) throw new Error(`${code}_unverified`);
  return value;
}

function computePriorityFeeLamports(computeUnits, microLamportsPerComputeUnit) {
  const units = safeInt(computeUnits, 'pretrade_compute_units_required', 1);
  const micro = safeInt(microLamportsPerComputeUnit, 'pretrade_priority_fee_rate_required', 0);
  const numerator = BigInt(units) * BigInt(micro);
  const lamports = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('pretrade_priority_fee_overflow');
  return lamports;
}

export function createSolanaPretradeNetworkFeeEstimator({
  loadUnsignedMessageEvidence,
  getFeeForMessage,
  simulateUnsignedTransaction,
  loadPriorityFeeEvidence,
  loadCurrentSolUsdEvidence,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (typeof loadUnsignedMessageEvidence !== 'function') throw new Error('pretrade_unsigned_message_loader_required');
  if (typeof getFeeForMessage !== 'function') throw new Error('pretrade_get_fee_for_message_required');
  if (typeof simulateUnsignedTransaction !== 'function') throw new Error('pretrade_simulation_required');
  if (typeof loadPriorityFeeEvidence !== 'function') throw new Error('pretrade_priority_fee_loader_required');
  if (typeof loadCurrentSolUsdEvidence !== 'function') throw new Error('pretrade_sol_usd_loader_required');
  const maxAge = finite(maxEvidenceAgeMs);
  if (!(maxAge > 0)) throw new Error('pretrade_fee_max_age_required');

  return Object.freeze({
    async estimate(context = {}) {
      const timestamp = now();
      const messageEvidence = verifiedObject(
        await loadUnsignedMessageEvidence(Object.freeze({ ...context, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' })),
        'pretrade_unsigned_message_evidence_required'
      );
      if (messageEvidence.signed === true || messageEvidence.transaction_signed === true || messageEvidence.signer_requested === true) {
        throw new Error('pretrade_unsigned_message_boundary_violation');
      }
      const message = text(messageEvidence.message_base64, 'pretrade_message_base64_required');
      const transaction = text(messageEvidence.transaction_base64, 'pretrade_transaction_base64_required');
      const messageReference = text(messageEvidence.source_reference, 'pretrade_message_reference_required');
      const messageObservedAt = freshIso(messageEvidence.observed_at, timestamp, maxAge, 'pretrade_message_observed_at');
      const messageSourceSlot = safeInt(messageEvidence.source_slot, 'pretrade_message_source_slot_required', 0);
      const accountKeys = Array.isArray(messageEvidence.account_keys) ? messageEvidence.account_keys.map(String).filter(Boolean) : [];

      const [baseFeeRaw, simulationRaw, priorityRaw, solUsdRaw] = await Promise.all([
        getFeeForMessage(Object.freeze({ message_base64: message, source_slot: messageSourceSlot, context })),
        simulateUnsignedTransaction(Object.freeze({ transaction_base64: transaction, source_slot: messageSourceSlot, context })),
        loadPriorityFeeEvidence(Object.freeze({ ...context, account_keys: accountKeys, source_slot: messageSourceSlot, message_source_reference: messageReference })),
        loadCurrentSolUsdEvidence(Object.freeze({ ...context, source_slot: messageSourceSlot, message_source_reference: messageReference }))
      ]);

      const baseFee = verifiedObject(baseFeeRaw, 'pretrade_base_fee_evidence_required');
      const simulation = verifiedObject(simulationRaw, 'pretrade_simulation_evidence_required');
      const priority = verifiedObject(priorityRaw, 'pretrade_priority_fee_evidence_required');
      const solUsd = verifiedObject(solUsdRaw, 'pretrade_sol_usd_evidence_required');

      const baseFeeLamports = safeInt(baseFee.base_fee_lamports, 'pretrade_base_fee_lamports_required', 0);
      const computeUnits = safeInt(simulation.compute_units_consumed, 'pretrade_compute_units_required', 1);
      const microLamportsPerComputeUnit = safeInt(priority.micro_lamports_per_compute_unit, 'pretrade_priority_fee_rate_required', 0);
      const priorityFeeLamports = computePriorityFeeLamports(computeUnits, microLamportsPerComputeUnit);
      const totalLamports = baseFeeLamports + priorityFeeLamports;
      if (!Number.isSafeInteger(totalLamports) || totalLamports < 0) throw new Error('pretrade_total_fee_overflow');

      const solUsdPrice = finite(solUsd.sol_usd);
      if (!(solUsdPrice > 0)) throw new Error('pretrade_sol_usd_required');
      const networkFeeUsdc = (totalLamports / LAMPORTS_PER_SOL) * solUsdPrice;
      if (!Number.isFinite(networkFeeUsdc) || networkFeeUsdc < 0) throw new Error('pretrade_network_fee_usdc_invalid');

      const sourceSlot = safeInt(baseFee.source_slot, 'pretrade_source_slot_required', 0);
      if (sourceSlot < messageSourceSlot) throw new Error('pretrade_base_fee_slot_before_message');
      if (safeInt(simulation.source_slot, 'pretrade_simulation_source_slot_required', 0) < messageSourceSlot) throw new Error('pretrade_simulation_slot_before_message');
      if (safeInt(priority.source_slot, 'pretrade_priority_source_slot_required', 0) < messageSourceSlot) throw new Error('pretrade_priority_slot_before_message');
      if (safeInt(solUsd.source_slot, 'pretrade_sol_usd_source_slot_required', 0) < messageSourceSlot) throw new Error('pretrade_sol_usd_slot_before_message');

      const observed = [
        messageObservedAt,
        freshIso(baseFee.observed_at, timestamp, maxAge, 'pretrade_base_fee_observed_at'),
        freshIso(simulation.observed_at, timestamp, maxAge, 'pretrade_simulation_observed_at'),
        freshIso(priority.observed_at, timestamp, maxAge, 'pretrade_priority_observed_at'),
        freshIso(solUsd.observed_at, timestamp, maxAge, 'pretrade_sol_usd_observed_at')
      ];

      return Object.freeze({
        network_fee_usdc: networkFeeUsdc,
        network_fee_verified: true,
        verified: true,
        base_fee_lamports: baseFeeLamports,
        priority_fee_lamports: priorityFeeLamports,
        total_roundtrip_fee_lamports: totalLamports,
        compute_units_consumed: computeUnits,
        micro_lamports_per_compute_unit: microLamportsPerComputeUnit,
        sol_usd: solUsdPrice,
        source_slot: sourceSlot,
        message_source_slot: messageSourceSlot,
        source: 'SOLANA_PRETRADE_RPC_FEE_ESTIMATE',
        source_reference: [
          messageReference,
          text(baseFee.source_reference, 'pretrade_base_fee_reference_required'),
          text(simulation.source_reference, 'pretrade_simulation_reference_required'),
          text(priority.source_reference, 'pretrade_priority_reference_required'),
          text(solUsd.source_reference, 'pretrade_sol_usd_reference_required')
        ].join('|'),
        observed_at: observed.sort().at(-1),
        read_only: true,
        transaction_signed: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const SOLANA_PRETRADE_NETWORK_FEE_ESTIMATOR = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  requires_unsigned_message_evidence: true,
  requires_serialized_unsigned_transaction: true,
  requires_get_fee_for_message: true,
  requires_read_only_simulation: true,
  requires_priority_fee_evidence: true,
  requires_current_sol_usd_evidence: true,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
