import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58);
const SCHEMA = 'aether.solana_transaction_signer_evidence.v1';

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

function normalizeParsedAccountKeys(message) {
  assertObject(message, 'transaction_message');
  if (!Array.isArray(message.accountKeys) || message.accountKeys.length === 0) throw new Error('transaction_account_keys_invalid');
  const seen = new Set();
  const rows = message.accountKeys.map((entry) => {
    assertObject(entry, 'account_key');
    const pubkey = canonicalSolanaKey(entry.pubkey, 'account_key_pubkey', 32);
    if (typeof entry.signer !== 'boolean' || typeof entry.writable !== 'boolean') throw new Error('account_key_metadata_invalid');
    if (seen.has(pubkey)) throw new Error('duplicate_account_key');
    seen.add(pubkey);
    return { pubkey, signer: entry.signer, writable: entry.writable };
  });
  return rows;
}

function normalizeSignerKeys(accountKeys) {
  return accountKeys.filter((entry) => entry.signer).map((entry) => entry.pubkey).sort();
}

export async function collectSolanaTransactionSignerEvidence({
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
      schema: SCHEMA,
      requested_signature: requestedSignature,
      requested_wallet: wallet,
      rpc_endpoint_label: endpointLabel,
      commitment,
      request_started_at: started.value,
      observed_at: observed.value,
      found: false,
      slot: null,
      block_time: null,
      signer_keys: [],
      trader_signed: false,
      source_reference: null,
    };
    return { ...basePending(), source_reference: null, source_hash: hashJson(provenance), signer_keys: [], trader_signed: false, reconciliation_required: true, provenance };
  }

  assertObject(payload.result, 'transaction_result');
  const slot = canonicalSafeInteger(payload.result.slot, 'slot');
  const blockTime = canonicalSafeInteger(payload.result.blockTime, 'block_time', { nullable: true });
  if (blockTime !== null && blockTime * 1000 > observed.ms) throw new Error('transaction_block_time_after_observation');
  assertObject(payload.result.transaction, 'transaction');
  if (!Array.isArray(payload.result.transaction.signatures) || payload.result.transaction.signatures.length === 0) throw new Error('transaction_signatures_invalid');
  const primarySignature = canonicalSolanaKey(payload.result.transaction.signatures[0], 'returned_signature', 64);
  if (primarySignature !== requestedSignature) throw new Error('returned_signature_mismatch');

  const accountKeys = normalizeParsedAccountKeys(payload.result.transaction.message);
  if (!accountKeys.some((entry) => entry.pubkey === wallet)) throw new Error('trader_wallet_not_in_transaction');
  const signerKeys = normalizeSignerKeys(accountKeys);
  if (signerKeys.length === 0) throw new Error('transaction_signer_keys_empty');
  const traderSigned = signerKeys.includes(wallet);
  const sourceReference = traderSigned ? `solana_rpc:${requestedSignature}@${slot}` : null;

  const provenance = {
    schema: SCHEMA,
    requested_signature: requestedSignature,
    requested_wallet: wallet,
    rpc_endpoint_label: endpointLabel,
    commitment,
    request_started_at: started.value,
    observed_at: observed.value,
    found: true,
    slot,
    block_time: blockTime,
    signer_keys: signerKeys,
    trader_signed: traderSigned,
    source_reference: sourceReference,
  };
  return {
    ...basePending(),
    source_reference: sourceReference,
    source_hash: hashJson(provenance),
    signer_keys: signerKeys,
    trader_signed: traderSigned,
    reconciliation_required: true,
    provenance,
  };
}

export function verifySolanaTransactionSignerEvidence(evidence) {
  try {
    assertObject(evidence, 'evidence');
    if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) if (evidence[key] !== null) return false;
    if (evidence.reconciliation_required !== true) return false;
    assertObject(evidence.provenance, 'provenance');
    const p = evidence.provenance;
    if (p.schema !== SCHEMA) return false;
    const signature = canonicalSolanaKey(p.requested_signature, 'requested_signature', 64);
    const wallet = canonicalSolanaKey(p.requested_wallet, 'requested_wallet', 32);
    canonicalEndpointLabel(p.rpc_endpoint_label);
    if (!['confirmed', 'finalized'].includes(p.commitment)) return false;
    const started = canonicalIso(p.request_started_at, 'request_started_at');
    const observed = canonicalIso(p.observed_at, 'observed_at');
    if (observed.ms < started.ms || typeof p.found !== 'boolean' || typeof p.trader_signed !== 'boolean') return false;
    if (!Array.isArray(p.signer_keys) || !Array.isArray(evidence.signer_keys)) return false;
    const normalizedSigners = [...new Set(p.signer_keys.map((key) => canonicalSolanaKey(key, 'signer_key', 32)))].sort();
    if (normalizedSigners.length !== p.signer_keys.length || JSON.stringify(normalizedSigners) !== JSON.stringify(p.signer_keys)) return false;
    if (JSON.stringify(evidence.signer_keys) !== JSON.stringify(p.signer_keys) || evidence.trader_signed !== p.trader_signed) return false;

    if (!p.found) {
      if (p.slot !== null || p.block_time !== null || p.signer_keys.length !== 0 || p.trader_signed !== false || p.source_reference !== null || evidence.source_reference !== null) return false;
    } else {
      canonicalSafeInteger(p.slot, 'slot');
      const blockTime = canonicalSafeInteger(p.block_time, 'block_time', { nullable: true });
      if (blockTime !== null && blockTime * 1000 > observed.ms) return false;
      if (p.signer_keys.length === 0) return false;
      const derivedTraderSigned = p.signer_keys.includes(wallet);
      if (derivedTraderSigned !== p.trader_signed) return false;
      const expectedReference = derivedTraderSigned ? `solana_rpc:${signature}@${p.slot}` : null;
      if (p.source_reference !== expectedReference || evidence.source_reference !== expectedReference) return false;
    }
    return /^[0-9a-f]{64}$/.test(evidence.source_hash) && evidence.source_hash === hashJson(p);
  } catch {
    return false;
  }
}
