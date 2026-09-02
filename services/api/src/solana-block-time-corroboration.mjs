import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOURCE_REFERENCE_RE = /^solana_rpc:([1-9A-HJ-NP-Za-km-z]+)@([0-9]+)$/;
const ENDPOINT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function safeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalTimestamp(value, name) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalEndpointLabel(value) {
  if (value === undefined) return 'solana-rpc';
  if (typeof value !== 'string' || value !== value.trim() || !ENDPOINT_LABEL_RE.test(value)) {
    throw new Error('invalid_rpc_endpoint_label');
  }
  return value;
}

function canonicalSourceReference(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('invalid_source_reference');
  const match = SOURCE_REFERENCE_RE.exec(value);
  if (!match) throw new Error('invalid_source_reference');
  const signature = canonicalSignature(match[1]);
  const slotText = match[2];
  if (slotText.length > 1 && slotText.startsWith('0')) throw new Error('invalid_source_reference');
  const slot = Number(slotText);
  safeInteger(slot, 'source_slot');
  return { sourceReference: `solana_rpc:${signature}@${slot}`, signature, slot };
}

function sha256(payload) {
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

function buildProvenance({
  sourceReference,
  signature,
  slot,
  expectedBlockTime,
  blockTime,
  endpointLabel,
  requestStartedAt,
  observedAt
}) {
  const payload = {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getBlockTime',
    rpc_endpoint_label: endpointLabel,
    source_reference: sourceReference,
    requested_signature_hash: sha256({ signature }),
    requested_slot: slot,
    expected_block_time: expectedBlockTime,
    returned_block_time: blockTime,
    request_started_at: requestStartedAt,
    observed_at: observedAt
  };
  return { ...payload, source_hash: sha256(payload) };
}

export async function collectSolanaBlockTimeCorroboration({
  sourceReference,
  expectedBlockTime,
  rpcCall,
  endpointLabel = 'solana-rpc',
  clock = () => new Date().toISOString()
} = {}) {
  const normalized = canonicalSourceReference(sourceReference);
  const expected = safeInteger(expectedBlockTime, 'expected_block_time', { nullable: true });
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('clock_required');

  const normalizedEndpoint = canonicalEndpointLabel(endpointLabel);
  const requestStartedAt = canonicalTimestamp(clock(), 'request_started_at');
  const blockTime = await rpcCall('getBlockTime', [normalized.slot]);
  const observedAt = canonicalTimestamp(clock(), 'observed_at');
  if (Date.parse(observedAt) < Date.parse(requestStartedAt)) throw new Error('rpc_observed_before_request');

  const returned = safeInteger(blockTime, 'rpc_block_time', { nullable: true });
  const provenance = buildProvenance({
    sourceReference: normalized.sourceReference,
    signature: normalized.signature,
    slot: normalized.slot,
    expectedBlockTime: expected,
    blockTime: returned,
    endpointLabel: normalizedEndpoint,
    requestStartedAt,
    observedAt
  });

  if (returned === null) {
    return pendingBoundary('block_time_not_found', provenance, null);
  }

  if (returned * 1000 > Date.parse(observedAt)) {
    throw new Error('rpc_block_time_after_observation');
  }

  if (expected === null) {
    return pendingBoundary('expected_block_time_required_for_corroboration', provenance, normalized.sourceReference);
  }

  if (returned !== expected) {
    return pendingBoundary('block_time_mismatch', provenance, normalized.sourceReference);
  }

  return pendingBoundary('block_time_corroborated_reconciliation_required', provenance, normalized.sourceReference);
}

export function verifySolanaBlockTimeCorroboration(evidence) {
  try {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    if (evidence.collection_status !== 'PENDING_DATA') return false;
    if (evidence.source_type !== 'SOLANA_RPC') return false;
    if (evidence.metrics_available !== false) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) {
      if (evidence[key] !== null) return false;
    }
    if (evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) return false;

    const p = evidence.provenance;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (p.schema_version !== 1 || p.source_type !== 'SOLANA_RPC' || p.rpc_method !== 'getBlockTime') return false;
    const normalized = canonicalSourceReference(p.source_reference);
    if (normalized.sourceReference !== p.source_reference) return false;
    if (normalized.slot !== safeInteger(p.requested_slot, 'source_slot')) return false;
    const expectedHash = sha256({ signature: normalized.signature });
    if (p.requested_signature_hash !== expectedHash) return false;
    canonicalEndpointLabel(p.rpc_endpoint_label);
    canonicalTimestamp(p.request_started_at, 'request_started_at');
    canonicalTimestamp(p.observed_at, 'observed_at');
    if (Date.parse(p.observed_at) < Date.parse(p.request_started_at)) return false;
    const expected = safeInteger(p.expected_block_time, 'expected_block_time', { nullable: true });
    const returned = safeInteger(p.returned_block_time, 'rpc_block_time', { nullable: true });
    if (returned !== null && returned * 1000 > Date.parse(p.observed_at)) return false;

    const { source_hash: sourceHash, ...payload } = p;
    if (typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceHash)) return false;
    if (sha256(payload) !== sourceHash) return false;

    let expectedReason;
    let expectedReference = normalized.sourceReference;
    if (returned === null) {
      expectedReason = 'block_time_not_found';
      expectedReference = null;
    } else if (expected === null) {
      expectedReason = 'expected_block_time_required_for_corroboration';
    } else if (returned !== expected) {
      expectedReason = 'block_time_mismatch';
    } else {
      expectedReason = 'block_time_corroborated_reconciliation_required';
    }
    if (evidence.reason !== expectedReason) return false;
    if (evidence.source_reference !== expectedReference) return false;
    return true;
  } catch {
    return false;
  }
}
