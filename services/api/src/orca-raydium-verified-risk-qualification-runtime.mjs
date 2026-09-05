import { createOrcaRaydiumMarketRiskSource } from './orca-raydium-market-risk-source.mjs';
import { createSolanaTokenRiskSource } from './solana-token-risk-source.mjs';
import { createOrcaRaydiumShadowRiskEvidenceCollector } from './orca-raydium-shadow-risk-evidence-collector.mjs';
import { createOrcaRaydiumShadowQualificationRuntime } from './orca-raydium-shadow-qualification-runtime.mjs';

export function createOrcaRaydiumVerifiedRiskQualificationRuntime({
  scannerRuntime,
  loadNetworkFeeEvidence,
  rpcUrl,
  notionalUsdc,
  performanceFeeBps = 1000,
  marketFetchImpl = globalThis.fetch,
  tokenFetchImpl = globalThis.fetch,
  now = () => Date.now(),
  maxRiskEvidenceAgeMs = 15_000,
  marketTimeoutMs = 5_000,
  tokenTimeoutMs = 4_000,
  maxSignaturePages = 8
} = {}) {
  const loadMarketRiskSource = createOrcaRaydiumMarketRiskSource({
    fetchImpl: marketFetchImpl,
    now,
    timeoutMs: marketTimeoutMs
  });
  const loadTokenRiskSource = createSolanaTokenRiskSource({
    rpcUrl,
    fetchImpl: tokenFetchImpl,
    now,
    timeoutMs: tokenTimeoutMs,
    maxSignaturePages
  });
  const riskCollector = createOrcaRaydiumShadowRiskEvidenceCollector({
    loadMarketRiskSource,
    loadTokenRiskSource,
    now,
    maxEvidenceAgeMs: maxRiskEvidenceAgeMs
  });
  const qualification = createOrcaRaydiumShadowQualificationRuntime({
    scannerRuntime,
    loadNetworkFeeEvidence,
    loadRiskEvidence: riskCollector.loadRiskEvidence,
    notionalUsdc,
    performanceFeeBps,
    now
  });

  return Object.freeze({
    scanAndQualifyPair: qualification.scanAndQualifyPair,
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
    risk_source: 'VERIFIED_EXACT_ROUTE_MARKET_ANALYTICS_PLUS_SOLANA_RPC_TOKEN_RISK',
    transaction_building_authorized: false,
    signer_requested: false,
    funds_moved: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  });
}

export const ORCA_RAYDIUM_VERIFIED_RISK_QUALIFICATION_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  min_expected_net_edge_bps: 20,
  verified_market_risk_required: true,
  verified_token_risk_required: true,
  verified_network_fee_required: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
