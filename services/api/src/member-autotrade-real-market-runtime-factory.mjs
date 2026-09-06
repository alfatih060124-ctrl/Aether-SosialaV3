import { createMarketIntelligenceService } from './market-intelligence.mjs';
import { createOrcaRaydiumShadowRuntime } from './orca-raydium-shadow-runtime.mjs';
import { createOrcaRaydiumShadowNetworkFeeSource } from './orca-raydium-shadow-network-fee-source.mjs';
import { createOrcaRaydiumVerifiedRiskQualificationRuntime } from './orca-raydium-verified-risk-qualification-runtime.mjs';
import { createMemberAutoTradeRealMarketRuntime } from './member-autotrade-real-market-runtime.mjs';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function positiveNumber(value, fallback, code) {
  const number = value === undefined || value === null || String(value).trim() === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(code);
  return number;
}

function boundedInt(value, fallback, min, max, code) {
  const number = value === undefined || value === null || String(value).trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(code);
  return number;
}

export function createConfiguredMemberAutoTradeRealMarketRuntime({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  const executionMode = String(env?.EXECUTION_MODE || 'SHADOW').trim().toUpperCase();
  if (executionMode !== 'SHADOW') throw new Error('autotrade_shadow_execution_mode_required');
  if (String(env?.LIVE_ENABLED || 'false').trim().toLowerCase() === 'true') throw new Error('autotrade_shadow_live_must_be_off');
  const rpcUrl = String(env?.SOLANA_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('solana_rpc_unconfigured');
  if (!rpcUrl.startsWith('https://')) throw new Error('solana_rpc_https_required');
  const notionalUsdc = positiveNumber(env?.AUTOTRADE_SHADOW_NOTIONAL_USDC, 10, 'autotrade_shadow_notional_invalid');
  const maxCandidates = boundedInt(env?.AUTOTRADE_SHADOW_MAX_CANDIDATES, 5, 1, 100, 'autotrade_shadow_max_candidates_invalid');

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
  const runtime = createMemberAutoTradeRealMarketRuntime({
    discoveryService,
    qualificationRuntime,
    quoteMint: USDC_MINT,
    discoveryView: 'trending',
    maxCandidates
  });

  return Object.freeze({
    ...runtime,
    configuration: Object.freeze({
      notional_usdc: notionalUsdc,
      max_candidates: maxCandidates,
      quote_mint: USDC_MINT,
      mode: 'SHADOW'
    })
  });
}

export const MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  min_expected_net_edge_bps: 20,
  default_shadow_notional_usdc: 10,
  default_candidates_per_scan: 5,
  transaction_count_per_day_capped: false,
  signer_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
