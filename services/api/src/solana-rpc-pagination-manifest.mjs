import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const COMMITMENTS = new Set(['confirmed', 'finalized']);
const CONFIRMATION_STATUSES = new Set(['processed', 'confirmed', 'finalized']);

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

function canonicalWallet(value) {
  if (typeof value !== 'string' || value !== value.trim() || decodedBase58ByteLength(value) !== 32) {
    throw new Error('invalid_solana_wallet');
  }
  return value;
}

function canonicalSignature(value) {
  if (typeof value !== 'string' || value !== value.trim() || decodedBase58ByteLength(value) !== 64) {
    throw new Error('invalid_rpc_signature');
  }
  return value;
}

function safeInteger(value, reason, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(reason);
  return value;
}

function canonicalEndpointLabel(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid_rpc_endpoint_label');
  }
  return value;
}

function canonicalCommitment(value) {
  if (typeof value !== 'string' || value !== value.trim() || !COMMITMENTS.has(value)) throw new Error('invalid_rpc_commitment');
  return value;
}

function canonicalJson(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_rpc_error_json');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object') throw new Error('invalid_rpc_error_json');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_rpc_error_json');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error('invalid_rpc_error_json');
    result[key] = canonicalJson(value[key]);
  }
  return result;
}

function canonicalRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid_rpc_signature_response');
  const confirmationStatus = row.confirmationStatus ?? row.confirmation_status ?? null;
  if (confirmationStatus !== null && (!CONFIRMATION_STATUSES.has(confirmationStatus) || confirmationStatus !== String(confirmationStatus).trim())) {
    throw new Error('invalid_rpc_confirmation_status');
  }
  const blockTime = row.blockTime ?? row.block_time ?? null;
  if (blockTime !== null) safeInteger(blockTime, 'invalid_rpc_block_time');
  return {
    signature: canonicalSignature(row.signature),
    slot: safeInteger(row.slot, 'invalid_rpc_slot'),
    block_time: blockTime,
    err: canonicalJson(row.err ?? null),
    confirmation_status: confirmationStatus
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildSolanaRpcPaginationManifest({
  walletAddress,
  endpointLabel = 'solana-rpc',
  commitment = 'finalized',
  pageSize = 100,
  maxPages = 3,
  pages,
  collectedAt
} = {}) {
  const wallet = canonicalWallet(walletAddress);
  const endpoint = canonicalEndpointLabel(endpointLabel);
  const normalizedCommitment = canonicalCommitment(commitment);
  const normalizedPageSize = safeInteger(pageSize, 'invalid_rpc_page_size', 1);
  const normalizedMaxPages = safeInteger(maxPages, 'invalid_rpc_max_pages', 1);
  if (normalizedPageSize > 1000) throw new Error('invalid_rpc_page_size');
  if (normalizedMaxPages > 20) throw new Error('invalid_rpc_max_pages');
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > normalizedMaxPages) throw new Error('invalid_rpc_pages');

  const observed = new Date(collectedAt);
  if (!(observed instanceof Date) || Number.isNaN(observed.getTime())) throw new Error('invalid_collected_at');
  const canonicalCollectedAt = observed.toISOString();

  const seen = new Map();
  const canonicalPages = [];
  let expectedBefore = null;

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.rows)) throw new Error('invalid_rpc_page');
    if (page.rows.length > normalizedPageSize) throw new Error('rpc_page_exceeds_requested_limit');
    const requestBefore = page.request_before ?? null;
    if (requestBefore !== expectedBefore) throw new Error('rpc_pagination_cursor_mismatch');

    const rows = page.rows.map(canonicalRow);
    for (const row of rows) {
      const prior = seen.get(row.signature);
      const encoded = JSON.stringify(row);
      if (prior !== undefined && prior !== encoded) throw new Error('conflicting_duplicate_signature');
      seen.set(row.signature, encoded);
    }

    const pagePayload = {
      page_index: index,
      request_before: requestBefore,
      rows
    };
    canonicalPages.push({ ...pagePayload, page_hash: sha256({ v: 1, ...pagePayload }) });
    expectedBefore = rows.length ? rows.at(-1).signature : null;

    if (rows.length < normalizedPageSize && index !== pages.length - 1) throw new Error('rpc_pages_after_terminal_page');
    if (rows.length === 0 && index !== pages.length - 1) throw new Error('rpc_pages_after_terminal_page');
  }

  const lastRows = canonicalPages.at(-1).rows;
  const collectionComplete = lastRows.length < normalizedPageSize;
  const manifestPayload = {
    v: 1,
    wallet_address: wallet,
    rpc_endpoint_label: endpoint,
    rpc_method: 'getSignaturesForAddress',
    rpc_commitment: normalizedCommitment,
    page_size: normalizedPageSize,
    max_pages: normalizedMaxPages,
    pages_fetched: canonicalPages.length,
    collection_complete: collectionComplete,
    collected_at: canonicalCollectedAt,
    pages: canonicalPages
  };
  const manifestHash = sha256(manifestPayload);
  const sourceReference = canonicalPages[0].rows[0]?.signature || null;

  return {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    source_reference: sourceReference,
    collection_status: 'PENDING_DATA',
    reason: sourceReference ? 'reconciled_trade_performance_required' : 'no_verifiable_chain_activity',
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    manifest_hash: manifestHash,
    provenance: manifestPayload
  };
}

export function verifySolanaRpcPaginationManifest(record) {
  if (!record || typeof record !== 'object') throw new Error('invalid_rpc_pagination_manifest');
  if (record.collection_status !== 'PENDING_DATA' || record.metrics_available !== false || record.verified !== false || record.published !== false || record.live_execution_authorized !== false) {
    throw new Error('unsafe_rpc_evidence_boundary');
  }
  for (const field of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) {
    if (record[field] !== null) throw new Error('unexpected_rpc_performance_metric');
  }
  const p = record.provenance;
  const rebuilt = buildSolanaRpcPaginationManifest({
    walletAddress: p?.wallet_address,
    endpointLabel: p?.rpc_endpoint_label,
    commitment: p?.rpc_commitment,
    pageSize: p?.page_size,
    maxPages: p?.max_pages,
    pages: p?.pages?.map(page => ({ request_before: page.request_before, rows: page.rows })),
    collectedAt: p?.collected_at
  });
  if (record.schema_version !== rebuilt.schema_version || record.source_type !== rebuilt.source_type || record.source_reference !== rebuilt.source_reference || record.manifest_hash !== rebuilt.manifest_hash) {
    throw new Error('rpc_pagination_manifest_mismatch');
  }
  return true;
}
