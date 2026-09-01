import crypto from 'node:crypto';
import { pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;

function assertWallet(value) {
  const wallet = String(value || '').trim();
  if (!BASE58.test(wallet)) throw new Error('invalid_solana_wallet');
  return wallet;
}

function canonicalJsonValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const normalized = {};
  for (const key of Object.keys(value).sort()) normalized[key] = canonicalJsonValue(value[key]);
  return normalized;
}

function canonicalSignatures(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_rpc_signature_response');
  const deduped = new Map();
  for (const row of rows) {
    const signature = String(row?.signature || '').trim();
    if (!SIGNATURE_BASE58.test(signature)) throw new Error('invalid_rpc_signature');
    const rawBlockTime = row?.blockTime ?? row?.block_time;
    const rawConfirmationStatus = row?.confirmationStatus ?? row?.confirmation_status;
    const normalized = {
      signature,
      slot: Number.isSafeInteger(row?.slot) && row.slot >= 0 ? row.slot : null,
      block_time: Number.isSafeInteger(rawBlockTime) ? rawBlockTime : null,
      err: canonicalJsonValue(row?.err ?? null),
      confirmation_status: typeof rawConfirmationStatus === 'string' ? rawConfirmationStatus.trim() || null : null
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

export function buildSolanaRpcProvenance({
  walletAddress,
  signatures,
  endpointLabel = 'solana-rpc',
  pagesFetched = 1,
  pageSize = 100,
  collectionComplete = true
}) {
  const wallet = assertWallet(walletAddress);
  const canonical = canonicalSignatures(signatures);
  const normalizedPagesFetched = Number.isInteger(pagesFetched) && pagesFetched >= 0 ? pagesFetched : 0;
  const normalizedPageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 100;
  const complete = collectionComplete === true;
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    v: 3,
    wallet,
    signatures: canonical,
    collection: {
      pages_fetched: normalizedPagesFetched,
      page_size: normalizedPageSize,
      complete
    }
  })).digest('hex');
  return {
    schema_version: 3,
    source_type: 'SOLANA_RPC',
    wallet_address: wallet,
    rpc_endpoint_label: String(endpointLabel || '').trim() || 'solana-rpc',
    pages_fetched: normalizedPagesFetched,
    page_size: normalizedPageSize,
    collection_complete: complete,
    signatures_observed: canonical.length,
    successful_signatures_observed: canonical.filter(row => row.err === null).length,
    failed_signatures_observed: canonical.filter(row => row.err !== null).length,
    newest_signature: canonical[0]?.signature || null,
    oldest_signature: canonical.at(-1)?.signature || null,
    source_hash: sourceHash
  };
}

export async function collectSolanaRpcEvidence({
  walletAddress,
  rpcCall,
  limit = 100,
  maxPages = 3,
  endpointLabel
} = {}) {
  const wallet = assertWallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  const safeLimit = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 100));
  const safeMaxPages = Math.max(1, Math.min(20, Number.isInteger(maxPages) ? maxPages : 3));
  const rows = [];
  let before;
  let pagesFetched = 0;
  let collectionComplete = false;

  for (let page = 0; page < safeMaxPages; page += 1) {
    const options = { limit: safeLimit };
    if (before) options.before = before;
    const pageResult = await rpcCall('getSignaturesForAddress', [wallet, options]);
    if (!Array.isArray(pageResult)) throw new Error('invalid_rpc_signature_response');
    pagesFetched += 1;
    rows.push(...pageResult);

    if (pageResult.length < safeLimit) {
      collectionComplete = true;
      break;
    }

    const canonicalPage = canonicalSignatures(pageResult);
    const nextBefore = canonicalPage.at(-1)?.signature || null;
    if (!nextBefore) throw new Error('rpc_pagination_cursor_missing');
    if (nextBefore === before) throw new Error('rpc_pagination_stalled');
    before = nextBefore;
  }

  const signatures = canonicalSignatures(rows);
  const provenance = buildSolanaRpcProvenance({
    walletAddress: wallet,
    signatures,
    endpointLabel,
    pagesFetched,
    pageSize: safeLimit,
    collectionComplete
  });

  // Signatures prove observable chain activity, not realized trading performance.
  // Never derive return/win-rate/drawdown from transaction count or token balance deltas.
  return {
    ...pendingData(signatures.length ? 'reconciled_trade_performance_required' : 'no_verifiable_chain_activity'),
    source_type: 'SOLANA_RPC',
    source_reference: signatures[0]?.signature || null,
    provenance
  };
}
