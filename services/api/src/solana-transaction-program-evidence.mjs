import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58);
const PROGRAM_SCHEMA = 'aether.solana_transaction_program_evidence.v1';

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}_invalid`);
}

function canonicalIso(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name}_invalid`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${name}_invalid`);
  return { value, ms };
}

function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0 || [...text].some((ch) => !BASE58_SET.has(ch))) throw new Error('base58_invalid');
  let bytes = [0];
  for (const ch of text) {
    let carry = BASE58.indexOf(ch);
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length - 1 && text[zeros] === '1') zeros += 1;
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes.reverse()]);
}

function canonicalSolanaKey(value, name, bytes) {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error(`${name}_invalid`);
  let decoded;
  try { decoded = decodeBase58(value); } catch { throw new Error(`${name}_invalid`); }
  if (decoded.length !== bytes) throw new Error(`${name}_invalid`);
  return value;
}

function canonicalEndpointLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('rpc_endpoint_label_invalid');
  return value;
}

function canonicalSafeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_invalid`);
  return value;
}

function canonicalProgramIds(message) {
  assertObject(message, 'transaction_message');
  if (!Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) throw new Error('transaction_message_invalid');
  const keys = message.accountKeys.map((entry) => {
    const key = typeof entry === 'string' ? entry : entry?.pubkey;
    return canonicalSolanaKey(key, 'account_key', 32);
  });
  const programIds = message.instructions.map((instruction) => {
    assertObject(instruction, 'instruction');
    if (typeof instruction.programId === 'string') return canonicalSolanaKey(instruction.programId, 'program_id', 32);
    if (Number.isSafeInteger(instruction.programIdIndex) && instruction.programIdIndex >= 0 && instruction.programIdIndex < keys.length) {
      return keys[instruction.programIdIndex];
    }
    throw new Error('instruction_program_id_invalid');
  });
  return [...new Set(programIds)].sort();
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function basePending() {
  return {
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

export async function collectSolanaTransactionProgramEvidence({
  rpc_url,
  rpc_endpoint_label,
  signature,
  trader_wallet,
  commitment = 'confirmed',
  request_started_at,
  observed_at,
  fetch_fn = globalThis.fetch,
} = {}) {
  if (typeof rpc_url !== 'string' || !/^https:\/\//.test(rpc_url)) throw new Error('rpc_url_invalid');
  const endpointLabel = canonicalEndpointLabel(rpc_endpoint_label);
  const requestedSignature = canonicalSolanaKey(signature, 'signature', 64);
  const wallet = canonicalSolanaKey(trader_wallet, 'trader_wallet', 32);
  if (!['confirmed', 'finalized'].includes(commitment)) throw new Error('commitment_invalid');
  const started = canonicalIso(request_started_at, 'request_started_at');
  const observed = canonicalIso(observed_at, 'observed_at');
  if (observed.ms < started.ms) throw new Error('observation_before_request');
  if (typeof fetch_fn !== 'function') throw new Error('fetch_fn_invalid');

  const response = await fetch_fn(rpc_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [requestedSignature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!response?.ok) throw new Error('solana_rpc_http_error');
  const payload = await response.json();
  if (payload?.error) throw new Error('solana_rpc_error');
  if (!Object.prototype.hasOwnProperty.call(payload ?? {}, 'result')) throw new Error('solana_rpc_response_invalid');

  if (payload.result === null) {
    const provenance = {
      schema: PROGRAM_SCHEMA,
      requested_signature: requestedSignature,
      requested_wallet: wallet,
      rpc_endpoint_label: endpointLabel,
      commitment,
      request_started_at: started.value,
      observed_at: observed.value,
      found: false,
      slot: null,
      block_time: null,
      program_ids: [],
      source_reference: null,
    };
    return { ...basePending(), source_reference: null, source_hash: hashJson(provenance), provenance };
  }

  assertObject(payload.result, 'transaction_result');
  const slot = canonicalSafeInteger(payload.result.slot, 'slot');
  const blockTime = canonicalSafeInteger(payload.result.blockTime, 'block_time', { nullable: true });
  if (blockTime !== null && blockTime * 1000 > observed.ms) throw new Error('transaction_block_time_after_observation');
  assertObject(payload.result.transaction, 'transaction');
  const signatures = payload.result.transaction.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) throw new Error('transaction_signatures_invalid');
  const primarySignature = canonicalSolanaKey(signatures[0], 'returned_signature', 64);
  if (primarySignature !== requestedSignature) throw new Error('returned_signature_mismatch');

  const message = payload.result.transaction.message;
  assertObject(message, 'transaction_message');
  if (!Array.isArray(message.accountKeys)) throw new Error('transaction_account_keys_invalid');
  const accountKeys = message.accountKeys.map((entry) => canonicalSolanaKey(typeof entry === 'string' ? entry : entry?.pubkey, 'account_key', 32));
  if (!accountKeys.includes(wallet)) throw new Error('trader_wallet_not_in_transaction');
  const programIds = canonicalProgramIds(message);
  if (programIds.length === 0) throw new Error('transaction_program_ids_empty');

  const sourceReference = `solana_rpc:${requestedSignature}@${slot}`;
  const provenance = {
    schema: PROGRAM_SCHEMA,
    requested_signature: requestedSignature,
    requested_wallet: wallet,
    rpc_endpoint_label: endpointLabel,
    commitment,
    request_started_at: started.value,
    observed_at: observed.value,
    found: true,
    slot,
    block_time: blockTime,
    program_ids: programIds,
    source_reference: sourceReference,
  };
  return {
    ...basePending(),
    source_reference: sourceReference,
    source_hash: hashJson(provenance),
    program_ids: programIds,
    reconciliation_required: true,
    provenance,
  };
}

export function verifySolanaTransactionProgramEvidence(evidence) {
  assertObject(evidence, 'evidence');
  if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) return false;
  for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) if (evidence[key] !== null) return false;
  assertObject(evidence.provenance, 'provenance');
  const p = evidence.provenance;
  if (p.schema !== PROGRAM_SCHEMA) return false;
  canonicalSolanaKey(p.requested_signature, 'requested_signature', 64);
  canonicalSolanaKey(p.requested_wallet, 'requested_wallet', 32);
  canonicalEndpointLabel(p.rpc_endpoint_label);
  if (!['confirmed', 'finalized'].includes(p.commitment)) return false;
  const started = canonicalIso(p.request_started_at, 'request_started_at');
  const observed = canonicalIso(p.observed_at, 'observed_at');
  if (observed.ms < started.ms) return false;
  if (typeof p.found !== 'boolean') return false;
  if (!Array.isArray(p.program_ids)) return false;
  const normalizedPrograms = [...new Set(p.program_ids.map((x) => canonicalSolanaKey(x, 'program_id', 32)))].sort();
  if (JSON.stringify(normalizedPrograms) !== JSON.stringify(p.program_ids)) return false;
  if (!p.found) {
    if (p.slot !== null || p.block_time !== null || p.source_reference !== null || p.program_ids.length !== 0 || evidence.source_reference !== null) return false;
    if (Object.prototype.hasOwnProperty.call(evidence, 'program_ids') || Object.prototype.hasOwnProperty.call(evidence, 'reconciliation_required')) return false;
  } else {
    const slot = canonicalSafeInteger(p.slot, 'slot');
    const blockTime = canonicalSafeInteger(p.block_time, 'block_time', { nullable: true });
    if (blockTime !== null && blockTime * 1000 > observed.ms) return false;
    if (p.program_ids.length === 0) return false;
    const expectedRef = `solana_rpc:${p.requested_signature}@${slot}`;
    if (p.source_reference !== expectedRef || evidence.source_reference !== expectedRef) return false;
    if (!Array.isArray(evidence.program_ids) || JSON.stringify(evidence.program_ids) !== JSON.stringify(p.program_ids)) return false;
    if (evidence.reconciliation_required !== true) return false;
  }
  return evidence.source_hash === hashJson(p);
}
