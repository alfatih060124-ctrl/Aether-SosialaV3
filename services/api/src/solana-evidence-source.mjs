import crypto from 'node:crypto';
import { pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;

function assertWallet(value) {
  const wallet = String(value || '').trim();
  if (!BASE58.test(wallet)) throw new Error('invalid_solana_wallet');
  return wallet;
}

function canonicalSignatures(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_rpc_signature_response');
  const deduped = new Map();
  for (const row of rows) {
    const signature = String(row?.signature || '').trim();
    if (!SIGNATURE_BASE58.test(signature)) continue;
    const normalized = {
      signature,
      slot: Number.isSafeInteger(row?.slot) && row.slot >= 0 ? row.slot : null,
      block_time: Number.isSafeInteger(row?.blockTime) ? row.blockTime : null,
      err: row?.err ?? null,
      confirmation_status: typeof row?.confirmationStatus === 'string' ? row.confirmationStatus.trim() || null : null
    };
    const existing = deduped.get(signature);
    if (!existing) {
      deduped.set(signature, normalized);
      continue;
    }
    const conflict = JSON.stringify(existing) !== JSON.stringify(normalized);
    if (conflict) throw new Error('conflicting_duplicate_signature');
  }
  return [...deduped.values()].sort((a, b) => {
    const slotA = a.slot ?? -1;
    const slotB = b.slot ?? -1;
    if (slotA !== slotB) return slotB - slotA;
    const timeA = a.block_time ?? -1;
    const timeB = b.block_time ?? -1;
    if (timeA !== timeB) return timeB - timeA;
    return a.signature.localeCompare(b.signature);
  });
}

export function buildSolanaRpcProvenance({ walletAddress, signatures, endpointLabel = 'solana-rpc' }) {
  const wallet = assertWallet(walletAddress);
  const canonical = canonicalSignatures(signatures);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({ v: 2, wallet, signatures: canonical })).digest('hex');
  return {
    schema_version: 2,
    source_type: 'SOLANA_RPC',
    wallet_address: wallet,
    rpc_endpoint_label: String(endpointLabel || '').trim() || 'solana-rpc',
    signatures_observed: canonical.length,
    successful_signatures_observed: canonical.filter(row => row.err === null).length,
    failed_signatures_observed: canonical.filter(row => row.err !== null).length,
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
  const provenance = buildSolanaRpcProvenance({ walletAddress: wallet, signatures: result, endpointLabel });

  // Signatures prove observable chain activity, not realized trading performance.
  // Never derive return/win-rate/drawdown from transaction count or token balance deltas.
  return {
    ...pendingData(signatures.length ? 'reconciled_trade_performance_required' : 'no_verifiable_chain_activity'),
    source_type: 'SOLANA_RPC',
    source_reference: signatures[0]?.signature || null,
    provenance
  };
}
