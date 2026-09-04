import crypto from 'node:crypto';
import { pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CONFIRMATION_STATUSES = new Set(['processed', 'confirmed', 'finalized']);
const QUERY_COMMITMENTS = new Set(['confirmed', 'finalized']);

function decodedBase58ByteLength(value) {
  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return -1;
    decoded = decoded * 58n + BigInt(digit);
  }
  let significantBytes = 0;
  for (let current = decoded; current > 0n; current >>= 8n) significantBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  return leadingZeroBytes + significantBytes;
}

function assertWallet(value) {
  const wallet = String(value || '').trim();
  if (!BASE58.test(wallet) || decodedBase58ByteLength(wallet) !== 32) throw new Error('invalid_solana_wallet');
  return wallet;
}

function assertSignature(value) {
  const signature = String(value || '').trim();
  if (!SIGNATURE_BASE58.test(signature) || decodedBase58ByteLength(signature) !== 64) {
    throw new Error('invalid_rpc_signature');
  }
  return signature;
}

function normalizeSlot(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_rpc_slot');
  return value;
}

function normalizeBlockTime(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_rpc_block_time');
  return value;
}

function normalizeConfirmationStatus(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('invalid_rpc_confirmation_status');
  const status = value.trim();
  if (!CONFIRMATION_STATUSES.has(status)) throw new Error('invalid_rpc_confirmation_status');
  return status;
}

function normalizeCommitment(value) {
  if (typeof value !== 'string') throw new Error('invalid_rpc_commitment');
  const commitment = value.trim();
  if (!QUERY_COMMITMENTS.has(commitment)) throw new Error('invalid_rpc_commitment');
  return commitment;
}

function normalizeEndpointLabel(value) {
  if (value === null || value === undefined || value === '') return 'solana-rpc';
  if (typeof value !== 'string') throw new Error('invalid_rpc_endpoint_label');
  const label = value.trim();
  if (!label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('invalid_rpc_endpoint_label');
  }
  return label;
}

function normalizeCollectionMetadata({ pagesFetched, pageSize, maxPages, collectionComplete }) {
  if (!Number.isSafeInteger(pagesFetched) || pagesFetched < 0 || pagesFetched > 20) {
    throw new Error('invalid_rpc_pages_fetched');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('invalid_rpc_page_size');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new Error('invalid_rpc_max_pages');
  }
  if (pagesFetched > maxPages) throw new Error('invalid_rpc_pages_fetched');
  if (typeof collectionComplete !== 'boolean') throw new Error('invalid_rpc_collection_complete');
  return {
    pages_fetched: pagesFetched,
    page_size: pageSize,
    max_pages: maxPages,
    complete: collectionComplete
  };
}

function canonicalJsonValue(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_rpc_error_json');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object') throw new Error('invalid_rpc_error_json');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_rpc_error_json');
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) throw new Error('invalid_rpc_error_json');
    normalized[key] = canonicalJsonValue(child);
  }
  return normalized;
}

function canonicalSignatures(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_rpc_signature_response');
  const deduped = new Map();
  for (const row of rows) {
    const signature = assertSignature(row?.signature);
    const rawBlockTime = row?.blockTime ?? row?.block_time;
    const rawConfirmationStatus = row?.confirmationStatus ?? row?.confirmation_status;
    const normalized = {
      signature,
      slot: normalizeSlot(row?.slot),
      block_time: normalizeBlockTime(rawBlockTime),
      err: canonicalJsonValue(row?.err ?? null),
      confirmation_status: normalizeConfirmationStatus(rawConfirmationStatus)
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
    if (a.slot !== b.slot) return b.slot - a.slot;
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
  maxPages = 3,
  collectionComplete = true,
  commitment = 'finalized'
}) {
  const wallet = assertWallet(walletAddress);
  const canonical = canonicalSignatures(signatures);
  const normalizedEndpointLabel = normalizeEndpointLabel(endpointLabel);
  const collection = normalizeCollectionMetadata({ pagesFetched, pageSize, maxPages, collectionComplete });
  const normalizedCommitment = normalizeCommitment(commitment);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    v: 8,
    wallet,
    source: {
      type: 'SOLANA_RPC',
      endpoint_label: normalizedEndpointLabel,
      commitment: normalizedCommitment
    },
    signatures: canonical,
    collection
  })).digest('hex');
  return {
    schema_version: 8,
    source_type: 'SOLANA_RPC',
    wallet_address: wallet,
    rpc_endpoint_label: normalizedEndpointLabel,
    rpc_commitment: normalizedCommitment,
    pages_fetched: collection.pages_fetched,
    page_size: collection.page_size,
    max_pages: collection.max_pages,
    collection_complete: collection.complete,
    signatures_observed: canonical.length,
    successful_signatures_observed: canonical.filter(row => row.err === null).length,
    failed_signatures_observed: canonical.filter(row => row.err !== null).length,
    newest_signature: canonical[0]?.signature || null,
    newest_slot: canonical[0]?.slot ?? null,
    oldest_signature: canonical.at(-1)?.signature || null,
    source_hash: sourceHash
  };
}

export async function collectSolanaRpcEvidence({
  walletAddress,
  rpcCall,
  limit = 100,
  maxPages = 3,
  endpointLabel,
  commitment = 'finalized'
} = {}) {
  const wallet = assertWallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_rpc_page_size');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('invalid_rpc_max_pages');
  const safeLimit = limit;
  const safeMaxPages = maxPages;
  const normalizedCommitment = normalizeCommitment(commitment);
  const rows = [];
  let before;
  let pagesFetched = 0;
  let collectionComplete = false;

  for (let page = 0; page < safeMaxPages; page += 1) {
    const options = { limit: safeLimit, commitment: normalizedCommitment };
    if (before) options.before = before;
    const pageResult = await rpcCall('getSignaturesForAddress', [wallet, options]);
    if (!Array.isArray(pageResult)) throw new Error('invalid_rpc_signature_response');
    if (pageResult.length > safeLimit) throw new Error('rpc_page_exceeds_requested_limit');
    pagesFetched += 1;
    rows.push(...pageResult);

    if (pageResult.length < safeLimit) {
      collectionComplete = true;
      break;
    }

    // Solana's `before` cursor is positional: it must be the signature from the
    // final row returned by the provider, not a signature chosen after canonical sorting.
    // Canonical ordering is only for deterministic provenance hashing after collection.
    const nextBefore = assertSignature(pageResult.at(-1)?.signature);
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
    maxPages: safeMaxPages,
    collectionComplete,
    commitment: normalizedCommitment
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
