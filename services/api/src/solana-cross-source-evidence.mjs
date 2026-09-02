import { createHash } from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function decodeBase58Length(value) {
  if (typeof value !== 'string' || value.length === 0) fail('invalid_solana_signature');
  let bytes = [0];
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) fail('invalid_solana_signature');
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeroes += 1;
  }
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
  return bytes.length + leadingZeroes;
}

function canonicalSignature(value) {
  if (typeof value !== 'string' || value.trim() !== value || decodeBase58Length(value) !== 64) {
    fail('invalid_solana_signature');
  }
  return value;
}

function canonicalSlot(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_solana_slot');
  return value;
}

function canonicalBlockTime(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_solana_block_time');
  return value;
}

function canonicalStatus(value, source) {
  if (source === 'SOLANA_RPC') {
    if (!['processed', 'confirmed', 'finalized'].includes(value)) fail('invalid_rpc_confirmation_status');
    return value;
  }
  if (source === 'SOLSCAN') {
    if (value !== 'Success' && value !== 'Fail') fail('invalid_solscan_status');
    return value;
  }
  fail('unsupported_evidence_source');
}

function canonicalObservedAt(value) {
  if (typeof value !== 'string') fail('invalid_observed_at');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('invalid_observed_at');
  return value;
}

function normalizeRecord(source, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_cross_source_record');
  const record = {
    source,
    signature: canonicalSignature(input.signature),
    slot: canonicalSlot(input.slot),
    block_time: canonicalBlockTime(input.block_time ?? null),
    status: canonicalStatus(input.status, source),
    observed_at: canonicalObservedAt(input.observed_at),
  };

  if (record.block_time !== null && Date.parse(record.observed_at) < record.block_time * 1000) {
    fail('cross_source_observed_before_block_time');
  }

  return record;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildSolanaCrossSourceEvidence({ rpc, solscan, collected_at }) {
  const rpcRecord = normalizeRecord('SOLANA_RPC', rpc);
  const solscanRecord = normalizeRecord('SOLSCAN', solscan);
  const collectedAt = canonicalObservedAt(collected_at);

  if (rpcRecord.signature !== solscanRecord.signature) fail('cross_source_signature_mismatch');
  if (rpcRecord.slot !== solscanRecord.slot) fail('cross_source_slot_mismatch');
  if (rpcRecord.block_time !== null && solscanRecord.block_time !== null && rpcRecord.block_time !== solscanRecord.block_time) {
    fail('cross_source_block_time_mismatch');
  }
  if (solscanRecord.status === 'Fail') fail('cross_source_transaction_failed');
  if (!['confirmed', 'finalized'].includes(rpcRecord.status)) fail('cross_source_rpc_not_confirmed');

  const latestObservedMs = Math.max(Date.parse(rpcRecord.observed_at), Date.parse(solscanRecord.observed_at));
  if (Date.parse(collectedAt) < latestObservedMs) fail('cross_source_collected_before_observation');

  const payload = {
    schema: 'aether.solana_cross_source_evidence.v1',
    signature: rpcRecord.signature,
    slot: rpcRecord.slot,
    block_time: rpcRecord.block_time ?? solscanRecord.block_time,
    rpc: rpcRecord,
    solscan: solscanRecord,
    collected_at: collectedAt,
  };

  return {
    ...payload,
    source_reference: `SOLANA_CROSS_SOURCE:${payload.signature}:${payload.slot}`,
    source_hash: sha256(payload),
    collection_status: 'PENDING_DATA',
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
  };
}

export function verifySolanaCrossSourceEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  try {
    const rebuilt = buildSolanaCrossSourceEvidence({
      rpc: evidence.rpc,
      solscan: evidence.solscan,
      collected_at: evidence.collected_at,
    });
    return evidence.schema === rebuilt.schema
      && evidence.signature === rebuilt.signature
      && evidence.slot === rebuilt.slot
      && evidence.block_time === rebuilt.block_time
      && evidence.source_reference === rebuilt.source_reference
      && evidence.source_hash === rebuilt.source_hash
      && evidence.collection_status === 'PENDING_DATA'
      && evidence.metrics_available === false
      && evidence.trades_count === null
      && evidence.total_return_bps === null
      && evidence.win_rate_bps === null
      && evidence.drawdown_bps === null
      && evidence.reputation_score === null
      && evidence.verified === false
      && evidence.published === false
      && evidence.live_execution_authorized === false;
  } catch {
    return false;
  }
}
