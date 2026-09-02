import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const COMMITMENTS = new Set(['confirmed', 'finalized']);

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

function canonicalBase58(value, name, bytes) {
  if (typeof value !== 'string' || value !== value.trim() || !BASE58_RE.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  if (decodedBase58ByteLength(value) !== bytes) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalSignature(value) {
  return canonicalBase58(value, 'solana_signature', 64);
}

function canonicalWallet(value) {
  return canonicalBase58(value, 'solana_wallet', 32);
}

function canonicalCommitment(value) {
  if (typeof value !== 'string' || !COMMITMENTS.has(value)) throw new Error('invalid_rpc_commitment');
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

function canonicalTimestamp(value, name) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid_${name}`);
  return value;
}

function safeInteger(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
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

function canonicalAccountKeys(transaction) {
  const keys = transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 256) throw new Error('invalid_rpc_account_keys');
  return keys.map((entry, index) => {
    const raw = typeof entry === 'string' ? entry : entry?.pubkey;
    try {
      return canonicalWallet(raw);
    } catch {
      throw new Error(`invalid_rpc_account_key_${index}`);
    }
  });
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

function buildHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function collectSolanaTransactionEvidence({
  signature,
  walletAddress,
  rpcCall,
  commitment = 'finalized',
  endpointLabel = 'solana-rpc',
  clock = () => new Date().toISOString()
} = {}) {
  const requestedSignature = canonicalSignature(signature);
  const wallet = canonicalWallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('clock_required');
  const normalizedCommitment = canonicalCommitment(commitment);
  const normalizedEndpoint = canonicalEndpointLabel(endpointLabel);
  const requestStartedAt = canonicalTimestamp(clock(), 'request_started_at');

  const response = await rpcCall('getTransaction', [requestedSignature, {
    commitment: normalizedCommitment,
    encoding: 'json',
    maxSupportedTransactionVersion: 0
  }]);
  const observedAt = canonicalTimestamp(clock(), 'observed_at');
  if (Date.parse(observedAt) < Date.parse(requestStartedAt)) throw new Error('rpc_observed_before_request');

  if (response === null) {
    const provenance = {
      schema_version: 1,
      source_type: 'SOLANA_RPC',
      rpc_method: 'getTransaction',
      rpc_endpoint_label: normalizedEndpoint,
      rpc_commitment: normalizedCommitment,
      request_started_at: requestStartedAt,
      observed_at: observedAt,
      requested_wallet: wallet,
      request_signature_hash: buildHash({ signature: requestedSignature }),
      transaction_found: false
    };
    provenance.source_hash = buildHash(provenance);
    return pendingBoundary('transaction_not_found_at_requested_commitment', provenance, null);
  }

  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_rpc_transaction_response');
  const slot = safeInteger(response.slot, 'rpc_slot');
  const blockTime = safeInteger(response.blockTime, 'rpc_block_time', { nullable: true });
  const feeLamports = safeInteger(response.meta?.fee, 'rpc_fee_lamports');
  const txSignatures = response.transaction?.signatures;
  if (!Array.isArray(txSignatures) || txSignatures.length < 1) throw new Error('invalid_rpc_transaction_signatures');
  const returnedSignature = canonicalSignature(txSignatures[0]);
  if (returnedSignature !== requestedSignature) throw new Error('rpc_transaction_signature_mismatch');

  const accountKeys = canonicalAccountKeys(response.transaction);
  if (!accountKeys.includes(wallet)) throw new Error('rpc_transaction_wallet_not_participant');
  const err = canonicalJson(response.meta?.err ?? null);
  const sourceReference = `solana_rpc:${returnedSignature}@${slot}`;
  const transactionRecord = {
    signature: returnedSignature,
    slot,
    block_time: blockTime,
    fee_lamports: feeLamports,
    err,
    wallet_participant: true,
    account_keys_hash: buildHash(accountKeys)
  };

  const provenancePayload = {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getTransaction',
    rpc_endpoint_label: normalizedEndpoint,
    rpc_commitment: normalizedCommitment,
    request_started_at: requestStartedAt,
    observed_at: observedAt,
    requested_wallet: wallet,
    source_reference: sourceReference,
    transaction: transactionRecord
  };
  const provenance = {
    ...provenancePayload,
    source_hash: buildHash(provenancePayload)
  };

  return pendingBoundary(
    err === null ? 'reconciliation_required_for_performance' : 'failed_transaction_not_performance_evidence',
    provenance,
    sourceReference
  );
}

export function verifySolanaTransactionEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  try {
    if (result.collection_status !== 'PENDING_DATA') return false;
    if (result.metrics_available !== false || result.verified !== false || result.published !== false) return false;
    if (result.live_execution_authorized !== false) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) {
      if (result[key] !== null) return false;
    }
    const provenance = result.provenance;
    if (!provenance || typeof provenance !== 'object') return false;
    canonicalWallet(provenance.requested_wallet);
    const { source_hash: suppliedHash, ...payload } = provenance;
    if (!/^[0-9a-f]{64}$/.test(suppliedHash || '')) return false;
    if (buildHash(payload) !== suppliedHash) return false;
    if (provenance.transaction_found === false) return result.source_reference === null;
    const signature = canonicalSignature(provenance.transaction?.signature);
    const slot = safeInteger(provenance.transaction?.slot, 'rpc_slot');
    if (result.source_reference !== `solana_rpc:${signature}@${slot}`) return false;
    return true;
  } catch {
    return false;
  }
}
