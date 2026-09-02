import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const CONFIRMATION_RANK = Object.freeze({ processed: 0, confirmed: 1, finalized: 2 });

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

function canonicalSignature(value) {
  if (typeof value !== 'string' || value !== value.trim() || !BASE58_RE.test(value)) {
    throw new Error('invalid_solana_signature');
  }
  if (decodedBase58ByteLength(value) !== 64) throw new Error('invalid_solana_signature');
  return value;
}

function canonicalTimestamp(value, name) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid_${name}`);
  return value;
}

function safeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalConfirmationStatus(value) {
  if (typeof value !== 'string' || !(value in CONFIRMATION_RANK)) throw new Error('invalid_confirmation_status');
  return value;
}

function canonicalEndpointLabel(value) {
  if (value === undefined) return 'solana-rpc';
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 128) {
    throw new Error('invalid_rpc_endpoint_label');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_rpc_endpoint_label');
  return value;
}

function canonicalJson(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error('invalid_rpc_json_number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') throw new Error('invalid_rpc_json');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_rpc_json');
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error('invalid_rpc_json');
    out[key] = canonicalJson(value[key]);
  }
  return out;
}

function hash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function pendingBoundary(reason, provenance, sourceReference = null) {
  return {
    collection_status: 'PENDING_DATA',
    reason,
    source_type: 'SOLANA_RPC',
    source_reference: sourceReference,
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance
  };
}

export async function collectSolanaSignatureStatusEvidence({
  signature,
  rpcCall,
  minimumConfirmationStatus = 'finalized',
  endpointLabel = 'solana-rpc',
  searchTransactionHistory = true,
  clock = () => new Date().toISOString()
} = {}) {
  const requestedSignature = canonicalSignature(signature);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('clock_required');
  const minimumStatus = canonicalConfirmationStatus(minimumConfirmationStatus);
  if (typeof searchTransactionHistory !== 'boolean') throw new Error('invalid_search_transaction_history');
  const normalizedEndpoint = canonicalEndpointLabel(endpointLabel);
  const requestStartedAt = canonicalTimestamp(clock(), 'request_started_at');

  const response = await rpcCall('getSignatureStatuses', [
    [requestedSignature],
    { searchTransactionHistory }
  ]);
  const observedAt = canonicalTimestamp(clock(), 'observed_at');
  if (Date.parse(observedAt) < Date.parse(requestStartedAt)) throw new Error('rpc_observed_before_request');

  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('invalid_signature_status_response');
  }
  const contextSlot = safeInteger(response.context?.slot, 'rpc_context_slot');
  if (!Array.isArray(response.value) || response.value.length !== 1) {
    throw new Error('invalid_signature_status_value');
  }

  const common = {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getSignatureStatuses',
    rpc_endpoint_label: normalizedEndpoint,
    search_transaction_history: searchTransactionHistory,
    minimum_confirmation_status: minimumStatus,
    request_started_at: requestStartedAt,
    observed_at: observedAt,
    requested_signature: requestedSignature,
    request_signature_hash: hash({ signature: requestedSignature }),
    context_slot: contextSlot
  };

  const status = response.value[0];
  if (status === null) {
    const provenance = { ...common, status_found: false };
    provenance.source_hash = hash(provenance);
    return pendingBoundary('signature_status_not_found', provenance, null);
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('invalid_signature_status_record');
  }

  const slot = safeInteger(status.slot, 'rpc_status_slot');
  if (slot > contextSlot) throw new Error('rpc_status_slot_after_context');
  const confirmations = safeInteger(status.confirmations, 'rpc_confirmations', { nullable: true });
  const confirmationStatus = canonicalConfirmationStatus(status.confirmationStatus);
  const err = canonicalJson(status.err ?? null);
  const legacyStatus = canonicalJson(status.status ?? null);
  const sourceReference = `solana_rpc:${requestedSignature}@${slot}`;
  const provenancePayload = {
    ...common,
    status_found: true,
    source_reference: sourceReference,
    status: {
      slot,
      confirmations,
      confirmation_status: confirmationStatus,
      err,
      legacy_status: legacyStatus
    }
  };
  const provenance = { ...provenancePayload, source_hash: hash(provenancePayload) };

  let reason = 'reconciliation_required_for_performance';
  if (CONFIRMATION_RANK[confirmationStatus] < CONFIRMATION_RANK[minimumStatus]) {
    reason = 'confirmation_below_required';
  } else if (err !== null) {
    reason = 'failed_transaction_not_performance_evidence';
  }
  return pendingBoundary(reason, provenance, sourceReference);
}

export function verifySolanaSignatureStatusEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  try {
    if (result.collection_status !== 'PENDING_DATA' || result.source_type !== 'SOLANA_RPC') return false;
    if (result.metrics_available !== false || result.verified !== false || result.published !== false) return false;
    if (result.live_execution_authorized !== false) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) {
      if (result[key] !== null) return false;
    }
    const provenance = result.provenance;
    if (!provenance || typeof provenance !== 'object') return false;
    const { source_hash: suppliedHash, ...payload } = provenance;
    if (!/^[0-9a-f]{64}$/.test(suppliedHash || '') || hash(payload) !== suppliedHash) return false;
    if (provenance.schema_version !== 1 || provenance.source_type !== 'SOLANA_RPC') return false;
    if (provenance.rpc_method !== 'getSignatureStatuses') return false;
    canonicalEndpointLabel(provenance.rpc_endpoint_label);
    canonicalConfirmationStatus(provenance.minimum_confirmation_status);
    if (typeof provenance.search_transaction_history !== 'boolean') return false;
    canonicalTimestamp(provenance.request_started_at, 'request_started_at');
    canonicalTimestamp(provenance.observed_at, 'observed_at');
    if (Date.parse(provenance.observed_at) < Date.parse(provenance.request_started_at)) return false;
    safeInteger(provenance.context_slot, 'rpc_context_slot');
    const requestedSignature = canonicalSignature(provenance.requested_signature);
    if (provenance.request_signature_hash !== hash({ signature: requestedSignature })) return false;

    if (provenance.status_found === false) {
      return result.source_reference === null && result.reason === 'signature_status_not_found';
    }
    if (provenance.status_found !== true) return false;
    const parsed = /^solana_rpc:([^@]+)@(\d+)$/.exec(result.source_reference || '');
    if (!parsed) return false;
    const signature = canonicalSignature(parsed[1]);
    if (signature !== requestedSignature) return false;
    const slot = safeInteger(provenance.status?.slot, 'rpc_status_slot');
    if (String(slot) !== parsed[2] || slot > provenance.context_slot) return false;
    safeInteger(provenance.status?.confirmations, 'rpc_confirmations', { nullable: true });
    const confirmationStatus = canonicalConfirmationStatus(provenance.status?.confirmation_status);
    canonicalJson(provenance.status?.err ?? null);
    canonicalJson(provenance.status?.legacy_status ?? null);
    if (provenance.source_reference !== `solana_rpc:${signature}@${slot}`) return false;

    const minimumStatus = canonicalConfirmationStatus(provenance.minimum_confirmation_status);
    const expectedReason = CONFIRMATION_RANK[confirmationStatus] < CONFIRMATION_RANK[minimumStatus]
      ? 'confirmation_below_required'
      : provenance.status.err !== null
        ? 'failed_transaction_not_performance_evidence'
        : 'reconciliation_required_for_performance';
    return result.reason === expectedReason;
  } catch {
    return false;
  }
}
