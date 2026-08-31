import crypto from 'node:crypto';
import { pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function assertWallet(value) {
  const wallet = String(value || '').trim();
  if (!BASE58.test(wallet)) throw new Error('invalid_solana_wallet');
  return wallet;
}

function canonicalSignatures(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_rpc_signature_response');
  return rows.map(row => ({
    signature: String(row?.signature || '').trim(),
    slot: Number.isSafeInteger(row?.slot) ? row.slot : null,
    block_time: Number.isSafeInteger(row?.blockTime) ? row.blockTime : null,
    err: row?.err ?? null
  })).filter(row => /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(row.signature));
}

export function buildSolanaRpcProvenance({ walletAddress, signatures, endpointLabel = 'solana-rpc' }) {
  const wallet = assertWallet(walletAddress);
  const canonical = canonicalSignatures(signatures);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({ v: 1, wallet, signatures: canonical })).digest('hex');
  return {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    wallet_address: wallet,
    rpc_endpoint_label: String(endpointLabel || '').trim() || 'solana-rpc',
    signatures_observed: canonical.length,
    newest_signature: canonical[0]?.signature || null,
    oldest_signature: canonical.at(-1)?.signature || null,
    source_hash: sourceHash
  };
}

export async function collectSolanaRpcEvidence({ walletAddress, rpcCall, limit = 100, endpointLabel } = {}) {
  const wallet = assertWallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  const safeLimit = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 100));
  const result = await rpcCall('getSignaturesForAddress', [wallet, { limit: safeLimit }]);
  const signatures = canonicalSignatures(result);
  const provenance = buildSolanaRpcProvenance({ walletAddress: wallet, signatures, endpointLabel });

  // Signatures prove observable chain activity, not realized trading performance.
  // Never derive return/win-rate/drawdown from transaction count or token balance deltas.
  return {
    ...pendingData(signatures.length ? 'reconciled_trade_performance_required' : 'no_verifiable_chain_activity'),
    source_type: 'SOLANA_RPC',
    source_reference: signatures[0]?.signature || null,
    provenance
  };
}
