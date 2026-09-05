const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, code) => { const v = String(value || '').trim(); if (!v) throw new Error(code); return v; };

function assertFreshObservedAt(value, now, maxAgeMs, code) {
  const observedAt = text(value, code);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) throw new Error(code);
  const age = now - observedMs;
  if (age < 0) throw new Error(`${code}_future`);
  if (age > maxAgeMs) throw new Error(`${code}_stale`);
  return new Date(observedMs).toISOString();
}

export function createOrcaRaydiumShadowEvidenceAdapter({
  loadNetworkFeeSource,
  loadRiskSource,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (typeof loadNetworkFeeSource !== 'function') throw new Error('shadow_network_fee_source_required');
  if (typeof loadRiskSource !== 'function') throw new Error('shadow_risk_source_required');
  const maxAge = finite(maxEvidenceAgeMs);
  if (!(maxAge > 0)) throw new Error('shadow_evidence_max_age_required');

  return Object.freeze({
    async loadNetworkFeeEvidence(context = {}) {
      const raw = await loadNetworkFeeSource(Object.freeze({ ...context, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }));
      if (!raw || typeof raw !== 'object') throw new Error('shadow_network_fee_source_payload_required');
      if (raw.verified !== true) throw new Error('shadow_network_fee_source_unverified');
      const fee = finite(raw.network_fee_usdc);
      if (fee === null || fee < 0) throw new Error('shadow_network_fee_source_usdc_required');
      const observedAt = assertFreshObservedAt(raw.observed_at, now(), maxAge, 'shadow_network_fee_source_observed_at');
      return Object.freeze({
        network_fee_usdc: fee,
        network_fee_verified: true,
        source: text(raw.source, 'shadow_network_fee_source_name_required'),
        source_reference: text(raw.source_reference, 'shadow_network_fee_source_reference_required'),
        observed_at: observedAt,
        read_only: true,
        live_execution_authorized: false
      });
    },

    async loadRiskEvidence(context = {}) {
      const raw = await loadRiskSource(Object.freeze({ ...context, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }));
      if (!raw || typeof raw !== 'object') throw new Error('shadow_risk_source_payload_required');
      if (raw.verified !== true) throw new Error('shadow_risk_source_unverified');
      const observedAt = assertFreshObservedAt(raw.observed_at, now(), maxAge, 'shadow_risk_source_observed_at');
      const data = raw.data && typeof raw.data === 'object' ? raw.data : null;
      if (!data) throw new Error('shadow_risk_source_data_required');
      return Object.freeze({
        verified: true,
        data: Object.freeze({ ...data }),
        source: text(raw.source, 'shadow_risk_source_name_required'),
        source_reference: text(raw.source_reference, 'shadow_risk_source_reference_required'),
        observed_at: observedAt,
        read_only: true,
        live_execution_authorized: false
      });
    }
  });
}

export const ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  requires_verified_sources: true,
  requires_source_reference: true,
  requires_fresh_observed_at: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
