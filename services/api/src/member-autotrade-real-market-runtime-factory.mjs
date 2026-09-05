import { createMarketIntelligenceService } from './market-intelligence.mjs';
import { createOrcaRaydiumShadowRuntime } from './orca-raydium-shadow-runtime.mjs';
import { createOrcaRaydiumShadowNetworkFeeSource } from './orca-raydium-shadow-network-fee-source.mjs';
import { createOrcaRaydiumVerifiedRiskQualificationRuntime } from './orca-raydium-verified-risk-qualification-runtime.mjs';
import { createMemberAutoTradeRealMarketRuntime } from './member-autotrade-real-market-runtime.mjs';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function createConfiguredMemberAutoTradeRealMarketRuntime({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  const rpcUrl = String(env?.SOLANA_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('solana_rpc_unconfigured');
  const notionalUsdc = Number(env?.AUTOTRADE_SHADOW_NOTIONAL_USDC || 10);
  if (!Number.isFinite(notionalUsdc) || notionalUsdc <= 0) throw new Error('autotrade_shadow_notional_invalid');

  const scannerRuntime = createOrcaRaydiumShadowRuntime({
    rpcUrl,
    quoteNotionalUsdc: notionalUsdc,
    fetchImpl,
    now
  });
  const loadNetworkFeeEvidence = createOrcaRaydiumShadowNetworkFeeSource({
    rpcUrl,
    scannerRuntime,
    fetchImpl
  });
  const qualificationRuntime = createOrcaRaydiumVerifiedRiskQualificationRuntime({
    scannerRuntime,
    loadNetworkFeeEvidence,
    rpcUrl,
    notionalUsdc,
    marketFetchImpl: fetchImpl,
    tokenFetchImpl: fetchImpl,
    now
  });
  const discoveryService = createMarketIntelligenceService({ fetchImpl, now });
  return createMemberAutoTradeRealMarketRuntime({
    discoveryService,
    qualificationRuntime,
    quoteMint: USDC_MINT,
    discoveryView: 'trending',
    maxCandidates: 20
  });
}

export const MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  min_expected_net_edge_bps: 20,
  default_shadow_notional_usdc: 10,
  live_execution_authorized: false
});
