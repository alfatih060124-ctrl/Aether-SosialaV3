import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58);
const SCHEMA = 'aether.solana_transaction_native_balance_evidence.v1';

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}_invalid`);
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

function canonicalIso(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name}_invalid`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${name}_invalid`);
  return { value, ms };
}

function canonicalSafeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_invalid`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('transaction_error_invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  throw new Error('transaction_error_invalid');
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

function normalizedAccountKeys(message) {
  assertObject(message, 'transaction_message');
  if (!Array.isArray(message.accountKeys) || message.accountKeys.length === 0) throw new Error('transaction_account_keys_invalid');
  const seen = new Set();
  return message.accountKeys.map((entry) => {
    const pubkey = typeof entry === 'string' ? entry : entry?.pubkey;
    const key = canonicalSolanaKey(pubkey, 'account_key_pubkey', 32);
    if (seen.has(key)) throw new Error('duplicate_account_key');
    seen.add(key);
    return key;
  });
}

function normalizeBalanceVector(value, expectedLength, name) {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new Error(`${name}_invalid`);
  return value.map((entry) => canonicalSafeInteger(entry, name));
}

function buildProvenance({
  requestedSignature,
  wallet,
  endpointLabel,
  commitment,
  started,
  observed,
  found,
  slot = null,
  blockTime = null,
  accountIndex = null,
  preLamports = null,
  postLamports = null,
  deltaLamports = null,
  transactionSucceeded = null,
  transactionError = null,
  sourceReference = null,
}) {
  return {
    schema: SCHEMA,
    requested_signature: requestedSignature,
    requested_wallet: wallet,
    rpc_endpoint_label: endpointLabel,
    commitment,
    request_started_at: started,
    observed_at: observed,
    found,
    slot,
    block_time: blockTime,
    account_index: accountIndex,
    pre_lamports: preLamports,
    post_lamports: postLamports,
    delta_lamports: deltaLamports,
    transaction_succeeded: transactionSucceeded,
    transaction_error: transactionError,
    source_reference: sourceReference,
  };
}

export async function collectSolanaTransactionNativeBalanceEvidence({
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
    const provenance = buildProvenance({
      requestedSignature, wallet, endpointLabel, commitment,
      started: started.value, observed: observed.value, found: false,
    });
    return {
      ...basePending(), source_reference: null, source_hash: hashJson(provenance),
      pre_lamports: null, post_lamports: null, delta_lamports: null,
      transaction_succeeded: null, reconciliation_required: true, provenance,
    };
  }

  assertObject(payload.result, 'transaction_result');
  const slot = canonicalSafeInteger(payload.result.slot, 'slot');
  const blockTime = canonicalSafeInteger(payload.result.blockTime, 'block_time', { nullable: true });
  if (blockTime !== null && blockTime * 1000 > observed.ms) throw new Error('transaction_block_time_after_observation');
  assertObject(payload.result.transaction, 'transaction');
  if (!Array.isArray(payload.result.transaction.signatures) || payload.result.transaction.signatures.length === 0) throw new Error('transaction_signatures_invalid');
  const primarySignature = canonicalSolanaKey(payload.result.transaction.signatures[0], 'returned_signature', 64);
  if (primarySignature !== requestedSignature) throw new Error('returned_signature_mismatch');

  const accountKeys = normalizedAccountKeys(payload.result.transaction.message);
  const accountIndex = accountKeys.indexOf(wallet);
  if (accountIndex < 0) throw new Error('trader_wallet_not_in_transaction');
  assertObject(payload.result.meta, 'transaction_meta');
  const preBalances = normalizeBalanceVector(payload.result.meta.preBalances, accountKeys.length, 'pre_balances');
  const postBalances = normalizeBalanceVector(payload.result.meta.postBalances, accountKeys.length, 'post_balances');
  const pre = BigInt(preBalances[accountIndex]);
  const post = BigInt(postBalances[accountIndex]);
  const delta = post - pre;
  const transactionError = canonicalJson(payload.result.meta.err);
  const transactionSucceeded = transactionError === null;
  const sourceReference = `solana_rpc:${requestedSignature}@${slot}`;

  const provenance = buildProvenance({
    requestedSignature, wallet, endpointLabel, commitment,
    started: started.value, observed: observed.value, found: true,
    slot, blockTime, accountIndex,
    preLamports: pre.toString(), postLamports: post.toString(), deltaLamports: delta.toString(),
    transactionSucceeded, transactionError, sourceReference,
  });
  return {
    ...basePending(),
    source_reference: sourceReference,
    source_hash: hashJson(provenance),
    pre_lamports: pre.toString(),
    post_lamports: post.toString(),
    delta_lamports: delta.toString(),
    transaction_succeeded: transactionSucceeded,
    reconciliation_required: true,
    provenance,
  };
}

export function verifySolanaTransactionNativeBalanceEvidence(evidence) {
  try {
    assertObject(evidence, 'evidence');
    if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false) return false;
    if (evidence.trades_count !== null || evidence.total_return_bps !== null || evidence.win_rate_bps !== null || evidence.drawdown_bps !== null || evidence.reputation_score !== null) return false;
    if (evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) return false;
    assertObject(evidence.provenance, 'provenance');
    const p = evidence.provenance;
    if (p.schema !== SCHEMA) return false;
    canonicalSolanaKey(p.requested_signature, 'requested_signature', 64);
    canonicalSolanaKey(p.requested_wallet, 'requested_wallet', 32);
    canonicalEndpointLabel(p.rpc_endpoint_label);
    if (!['confirmed', 'finalized'].includes(p.commitment)) return false;
    const started = canonicalIso(p.request_started_at, 'request_started_at');
    const observed = canonicalIso(p.observed_at, 'observed_at');
    if (observed.ms < started.ms || typeof p.found !== 'boolean') return false;

    if (!p.found) {
      if ([p.slot, p.block_time, p.account_index, p.pre_lamports, p.post_lamports, p.delta_lamports, p.transaction_succeeded, p.transaction_error, p.source_reference].some((v) => v !== null)) return false;
      if (evidence.source_reference !== null || evidence.pre_lamports !== null || evidence.post_lamports !== null || evidence.delta_lamports !== null || evidence.transaction_succeeded !== null) return false;
    } else {
      canonicalSafeInteger(p.slot, 'slot');
      const blockTime = canonicalSafeInteger(p.block_time, 'block_time', { nullable: true });
      if (blockTime !== null && blockTime * 1000 > observed.ms) return false;
      canonicalSafeInteger(p.account_index, 'account_index');
      if (!/^(0|[1-9]\d*)$/.test(p.pre_lamports) || !/^(0|[1-9]\d*)$/.test(p.post_lamports) || !/^-?(0|[1-9]\d*)$/.test(p.delta_lamports)) return false;
      if ((BigInt(p.post_lamports) - BigInt(p.pre_lamports)).toString() !== p.delta_lamports) return false;
      const err = canonicalJson(p.transaction_error);
      if (typeof p.transaction_succeeded !== 'boolean' || p.transaction_succeeded !== (err === null)) return false;
      const expectedRef = `solana_rpc:${p.requested_signature}@${p.slot}`;
      if (p.source_reference !== expectedRef || evidence.source_reference !== expectedRef) return false;
      if (evidence.pre_lamports !== p.pre_lamports || evidence.post_lamports !== p.post_lamports || evidence.delta_lamports !== p.delta_lamports || evidence.transaction_succeeded !== p.transaction_succeeded) return false;
    }
    return typeof evidence.source_hash === 'string' && /^[0-9a-f]{64}$/.test(evidence.source_hash) && evidence.source_hash === hashJson(p);
  } catch {
    return false;
  }
}
