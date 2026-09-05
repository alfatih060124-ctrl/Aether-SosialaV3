import { createOrcaWhirlpoolRpcQuotePool } from './orca-whirlpool-rpc-quote-pool.mjs';
import { createOrcaWhirlpoolReadOnlyQuoteLoader } from './orca-whirlpool-readonly-provider.mjs';
import { createRaydiumSdkRpcQuotePool } from './raydium-sdk-rpc-quote-pool.mjs';
import { createRaydiumReadOnlyQuoteLoader } from './raydium-readonly-provider.mjs';
import { createOrcaRaydiumReadOnlyPoolLoader } from './orca-raydium-readonly-provider-adapter.mjs';
import { createOrcaRaydiumArbitrageScanner } from './orca-raydium-arbitrage-scanner.mjs';
import { loadRaydiumRuntimeSdkModule } from './raydium-runtime-sdk-module.mjs';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export async function createOrcaRaydiumShadowRuntime({
  rpcUrl,
  raydium,
  quoteNotionalUsdc,
  orcaQuotePool,
  raydiumQuotePool,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = 5_000,
  maxMarketAgeMs = 5_000
} = {}) {
  const notional = finite(quoteNotionalUsdc);
  if (!(notional > 0)) throw new Error('shadow_runtime_quote_notional_required');

  const resolvedOrcaQuotePool = orcaQuotePool || createOrcaWhirlpoolRpcQuotePool({ rpcUrl });
  let resolvedRaydiumQuotePool = raydiumQuotePool;
  if (!resolvedRaydiumQuotePool) {
    if (!raydium || typeof raydium !== 'object') throw new Error('shadow_runtime_raydium_instance_required');
    const sdkModule = await loadRaydiumRuntimeSdkModule();
    resolvedRaydiumQuotePool = createRaydiumSdkRpcQuotePool({ raydium, sdkModule });
  }

  const loadOrcaQuotes = createOrcaWhirlpoolReadOnlyQuoteLoader({
    quotePool: resolvedOrcaQuotePool,
    fetchImpl,
    quoteNotionalUsdc: notional
  });
  const loadRaydiumQuotes = createRaydiumReadOnlyQuoteLoader({
    quotePool: resolvedRaydiumQuotePool,
    fetchImpl,
    quoteNotionalUsdc: notional
  });
  const loadPools = createOrcaRaydiumReadOnlyPoolLoader({ loadOrcaQuotes, loadRaydiumQuotes });
  const scanner = createOrcaRaydiumArbitrageScanner({ loadPools, now, cacheTtlMs, maxMarketAgeMs });

  return Object.freeze({
    scanPair: scanner.scanPair,
    clearCache: scanner.clearCache,
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
    read_only: true,
    execution_dispatched: false,
    transaction_created: false,
    signer_requested: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  });
}

export const ORCA_RAYDIUM_SHADOW_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  read_only: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
