import { createOrcaRaydiumShadowEvidenceAdapter } from './orca-raydium-shadow-evidence-adapter.mjs';
import { createOrcaRaydiumShadowQualificationRuntime } from './orca-raydium-shadow-qualification-runtime.mjs';

export function createOrcaRaydiumShadowQualifiedPretradeRuntime({
  scannerRuntime,
  pretradeFeePipeline,
  loadRiskSource,
  notionalUsdc,
  performanceFeeBps = 1000,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (!pretradeFeePipeline || typeof pretradeFeePipeline.estimate !== 'function') {
    throw new Error('shadow_pretrade_fee_pipeline_required');
  }
  if (typeof loadRiskSource !== 'function') throw new Error('shadow_pretrade_risk_source_required');

  const evidenceAdapter = createOrcaRaydiumShadowEvidenceAdapter({
    now,
    maxEvidenceAgeMs,
    loadNetworkFeeSource: context => pretradeFeePipeline.estimate(Object.freeze({
      ...context,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE',
      live_execution_authorized: false
    })),
    loadRiskSource
  });

  const qualificationRuntime = createOrcaRaydiumShadowQualificationRuntime({
    scannerRuntime,
    loadNetworkFeeEvidence: context => evidenceAdapter.loadNetworkFeeEvidence(context),
    loadRiskEvidence: context => evidenceAdapter.loadRiskEvidence(context),
    notionalUsdc,
    performanceFeeBps,
    now
  });

  return Object.freeze({
    async scanAndQualifyPair(input = {}) {
      if (input?.live_execution_authorized === true) throw new Error('shadow_pretrade_live_boundary_violation');
      return qualificationRuntime.scanAndQualifyPair(input);
    }
  });
}

export const ORCA_RAYDIUM_SHADOW_QUALIFIED_PRETRADE_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  min_expected_net_edge_bps: 20,
  requires_verified_serialized_pretrade_fee: true,
  requires_verified_risk_evidence: true,
  simulation_transaction_construction_authorized: true,
  transaction_signing_authorized: false,
  private_key_allowed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
