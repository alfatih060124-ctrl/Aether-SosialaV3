import { createSolanaJsonRpcCaller } from './automatic-evidence-service.mjs';
import {
  collectSolanaNetworkFeeObservation,
  valueSolanaNetworkFeeObservation
} from '../../../packages/reconciliation-accounting/solana-network-fee.mjs';
import { collectHistoricalSolUsdSnapshot } from '../../../packages/reconciliation-accounting/geckoterminal-sol-usd.mjs';

const TRANSIENT_SOURCE_ERRORS = new Set([
  'solana_rpc_http_error',
  'solana_rpc_error',
  'solana_rpc_timeout',
  'solana_transaction_not_found',
  'geckoterminal_rate_limited',
  'geckoterminal_unavailable',
  'geckoterminal_timeout',
  'geckoterminal_pool_or_candle_not_found',
  'geckoterminal_candle_not_found'
]);

function safeCode(error) {
  const code = String(error?.message || 'unknown_network_fee_source_error').trim();
  return /^[a-z0-9_:-]{1,160}$/i.test(code) ? code : 'invalid_network_fee_source_error';
}

function boundary(extra = {}) {
  return {
    network_fee_ready: false,
    reconciliation_ready: false,
    evidence_ready: false,
    verification_authorized: false,
    publication_authorized: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    ...extra
  };
}

function pendingConfiguration(missing, blocker) {
  return boundary({
    status: 'PENDING_CONFIGURATION',
    source_completeness: 'INCOMPLETE',
    missing_sources: [missing],
    blockers: [blocker]
  });
}

function pendingSource(code) {
  return boundary({
    status: 'PENDING_SOURCE_COMPLETENESS',
    source_completeness: 'INCOMPLETE',
    missing_sources: ['SOLANA_NETWORK_FEE_USD'],
    blockers: [code]
  });
}

function blocked(code) {
  return boundary({
    status: 'BLOCKED_INVALID_SOURCE',
    source_completeness: 'INVALID',
    missing_sources: [],
    blockers: [code]
  });
}

/**
 * Collect and value the Solana network fee for one source transaction.
 *
 * The transaction fee is collected directly from Solana RPC and the historical SOL/USD
 * price is selected from an explicit, configured GeckoTerminal pool at transaction time.
 * No caller-supplied fee value is trusted. The result is still only one component of the
 * complete fee/equity reconciliation set and never verifies, publishes, signs or executes.
 */
export async function collectAutomaticNetworkFeeSnapshot({
  sourceSignature,
  expectedSlot,
  rpcUrl = process.env.SOLANA_RPC_URL,
  endpointLabel = process.env.SOLANA_RPC_ENDPOINT_LABEL || 'solana-rpc',
  solUsdPoolAddress = process.env.RECONCILIATION_SOL_USD_POOL_ADDRESS,
  rpcCall = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  clock = () => new Date()
} = {}) {
  if (!rpcCall && !String(rpcUrl || '').trim()) {
    return pendingConfiguration('SOLANA_RPC_URL', 'solana_rpc_unconfigured');
  }
  if (!String(solUsdPoolAddress || '').trim()) {
    return pendingConfiguration('RECONCILIATION_SOL_USD_POOL_ADDRESS', 'sol_usd_pool_unconfigured');
  }

  try {
    const call = rpcCall || createSolanaJsonRpcCaller({ rpcUrl, fetchImpl, timeoutMs });
    const observation = await collectSolanaNetworkFeeObservation({
      signature: sourceSignature,
      rpcCall: call,
      expectedSlot,
      endpointLabel,
      clock
    });

    if (observation.block_time_unix === null || observation.block_time_unix === undefined) {
      return pendingSource('solana_fee_block_time_required_for_valuation');
    }

    const solUsdSnapshot = await collectHistoricalSolUsdSnapshot({
      poolAddress: solUsdPoolAddress,
      anchorSlot: observation.source_slot,
      transactionBlockTimeUnix: observation.block_time_unix,
      fetchImpl,
      timeoutMs,
      clock
    });
    const networkFeeSnapshot = valueSolanaNetworkFeeObservation({ observation, solUsdSnapshot });

    if (
      networkFeeSnapshot.reconciliation_ready !== false ||
      networkFeeSnapshot.evidence_ready !== false ||
      networkFeeSnapshot.verified !== false ||
      networkFeeSnapshot.published !== false ||
      networkFeeSnapshot.live_execution_authorized !== false
    ) throw new Error('automatic_network_fee_boundary_violation');

    return {
      ...boundary(),
      status: 'NETWORK_FEE_READY',
      source_completeness: 'COMPLETE',
      missing_sources: [],
      blockers: [],
      network_fee_ready: true,
      network_fee_snapshot: networkFeeSnapshot
    };
  } catch (error) {
    const code = safeCode(error);
    if (TRANSIENT_SOURCE_ERRORS.has(code)) return pendingSource(code);
    return blocked(code);
  }
}
