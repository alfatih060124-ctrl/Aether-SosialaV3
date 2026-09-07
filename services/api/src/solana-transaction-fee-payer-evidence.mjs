import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));
const ENDPOINT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_NULL_METRICS = Object.freeze({
  trades_count: null,
  total_return_bps: null,
  win_rate_bps: null,
  drawdown_bps: null,
  reputation_score: null,
});

function fail(message) { throw new Error(message); }
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function assertSafeInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be a safe integer >= ${min}`);
  return value;
}
function assertIsoInstant(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(`${name} must be canonical ISO-8601 UTC`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(`${name} must be canonical ISO-8601 UTC`);
  return ms;
}
function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0) fail('Base58 value required');
  let bytes = [0];
  for (const ch of text) {
    const digit = B58_MAP.get(ch);
    if (digit === undefined) fail('invalid Base58 character');
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 255;
      carry = x >> 8;
    }
    while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (let i = 0; i < text.length - 1 && text[i] === '1'; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
function assertSolanaId(text, bytes, name) {
  if (typeof text !== 'string' || text.length < 1 || text.length > 128) fail(`${name} malformed`);
  if (decodeBase58(text).length !== bytes) fail(`${name} must decode to ${bytes} bytes`);
  return text;
}
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  fail('unsupported JSON value');
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizeEndpointLabel(value) {
  if (typeof value !== 'string' || !ENDPOINT_LABEL.test(value)) fail('rpc_endpoint_label must be opaque and credential-free');
  return value;
}
function normalizeAccountKeys(raw) {
  if (!Array.isArray(raw) || raw.length === 0) fail('transaction account keys required');
  const seen = new Set();
  return raw.map((row, index) => {
    if (!isPlainObject(row)) fail('parsed account key object required');
    const pubkey = assertSolanaId(row.pubkey, 32, `account_keys[${index}].pubkey`);
    if (seen.has(pubkey)) fail('duplicate transaction account key');
    seen.add(pubkey);
    if (typeof row.signer !== 'boolean' || typeof row.writable !== 'boolean') fail('canonical signer/writable metadata required');
    if (row.source !== 'transaction' && row.source !== 'lookupTable') fail('account key source must be transaction or lookupTable');
    return { pubkey, signer: row.signer, writable: row.writable, source: row.source };
  });
}
function baseOutput() {
  return {
    schema: 'aether.solana.transaction_fee_payer_evidence.v1',
    collection_status: 'PENDING_DATA',
    metrics_available: false,
    ...SAFE_NULL_METRICS,
    verified: false,
    published: false,
    live_execution_authorized: false,
    reconciliation_required: true,
  };
}
function buildSourceReference(signature, slot, eligible) {
  return eligible ? `solana_rpc:${signature}@${slot}` : null;
}
function buildProvenance({ requestedSignature, requestedWallet, endpointLabel, commitment, requestStartedAt, observedAt, found, slot, blockTime, transactionErr, accountKeys, feePayer, traderIsFeePayer, sourceReference }) {
  return {
    schema: 'aether.solana.transaction_fee_payer_provenance.v1',
    rpc_method: 'getTransaction',
    encoding: 'jsonParsed',
    commitment,
    rpc_endpoint_label: endpointLabel,
    request_started_at: requestStartedAt,
    observed_at: observedAt,
    requested_signature: requestedSignature,
    requested_wallet: requestedWallet,
    found,
    slot,
    block_time: blockTime,
    transaction_err: transactionErr,
    account_keys: accountKeys,
    fee_payer: feePayer,
    trader_is_fee_payer: traderIsFeePayer,
    source_reference: sourceReference,
  };
}
function finalize(provenance) {
  return {
    ...baseOutput(),
    source_reference: provenance.source_reference,
    fee_payer: provenance.fee_payer,
    trader_is_fee_payer: provenance.trader_is_fee_payer,
    provenance,
    source_hash: sha256(canonicalJson(provenance)),
  };
}

export async function collectSolanaTransactionFeePayerEvidence({
  rpcRequest,
  signature,
  traderWallet,
  rpcEndpointLabel,
  commitment = 'confirmed',
  requestStartedAt,
  observedAt,
}) {
  if (typeof rpcRequest !== 'function') fail('rpcRequest function required');
  const requestedSignature = assertSolanaId(signature, 64, 'signature');
  const requestedWallet = assertSolanaId(traderWallet, 32, 'traderWallet');
  const endpointLabel = normalizeEndpointLabel(rpcEndpointLabel);
  if (commitment !== 'confirmed' && commitment !== 'finalized') fail('commitment must be confirmed or finalized');
  const startedMs = assertIsoInstant(requestStartedAt, 'requestStartedAt');
  const observedMs = assertIsoInstant(observedAt, 'observedAt');
  if (observedMs < startedMs) fail('observedAt must not precede requestStartedAt');

  const response = await rpcRequest('getTransaction', [requestedSignature, {
    encoding: 'jsonParsed',
    commitment,
    maxSupportedTransactionVersion: 0,
  }]);
  if (!isPlainObject(response) || response.jsonrpc !== '2.0' || !Object.hasOwn(response, 'result')) fail('malformed RPC response');

  if (response.result === null) {
    return finalize(buildProvenance({
      requestedSignature,
      requestedWallet,
      endpointLabel,
      commitment,
      requestStartedAt,
      observedAt,
      found: false,
      slot: null,
      blockTime: null,
      transactionErr: null,
      accountKeys: [],
      feePayer: null,
      traderIsFeePayer: false,
      sourceReference: null,
    }));
  }

  const result = response.result;
  if (!isPlainObject(result) || !isPlainObject(result.transaction) || !isPlainObject(result.transaction.message) || !isPlainObject(result.meta)) fail('malformed transaction result');
  const slot = assertSafeInteger(result.slot, 'slot');
  const blockTime = result.blockTime === null ? null : assertSafeInteger(result.blockTime, 'blockTime');
  if (blockTime !== null && blockTime * 1000 > observedMs) fail('blockTime cannot be after observedAt');
  if (!Array.isArray(result.transaction.signatures) || result.transaction.signatures.length < 1) fail('transaction signatures required');
  const returnedPrimarySignature = assertSolanaId(result.transaction.signatures[0], 64, 'returned primary signature');
  if (returnedPrimarySignature !== requestedSignature) fail('returned primary signature does not match request');

  const accountKeys = normalizeAccountKeys(result.transaction.message.accountKeys);
  const feePayerRow = accountKeys[0];
  if (feePayerRow.source !== 'transaction' || feePayerRow.signer !== true || feePayerRow.writable !== true) fail('fee payer must be first static writable signer');
  const feePayer = feePayerRow.pubkey;
  const traderIsFeePayer = feePayer === requestedWallet;
  const sourceReference = buildSourceReference(requestedSignature, slot, traderIsFeePayer);
  const transactionErr = result.meta.err ?? null;
  if (transactionErr !== null && !isPlainObject(transactionErr)) fail('transaction err must be object or null');

  return finalize(buildProvenance({
    requestedSignature,
    requestedWallet,
    endpointLabel,
    commitment,
    requestStartedAt,
    observedAt,
    found: true,
    slot,
    blockTime,
    transactionErr,
    accountKeys,
    feePayer,
    traderIsFeePayer,
    sourceReference,
  }));
}

export function verifySolanaTransactionFeePayerEvidence(evidence) {
  if (!isPlainObject(evidence) || evidence.schema !== 'aether.solana.transaction_fee_payer_evidence.v1') fail('invalid evidence schema');
  if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) fail('unsafe evidence state');
  for (const key of Object.keys(SAFE_NULL_METRICS)) if (evidence[key] !== null) fail(`${key} must remain null`);
  if (!isPlainObject(evidence.provenance) || evidence.provenance.schema !== 'aether.solana.transaction_fee_payer_provenance.v1') fail('invalid provenance');
  const p = evidence.provenance;
  const requestedSignature = assertSolanaId(p.requested_signature, 64, 'provenance requested signature');
  const requestedWallet = assertSolanaId(p.requested_wallet, 32, 'provenance requested wallet');
  normalizeEndpointLabel(p.rpc_endpoint_label);
  if (p.commitment !== 'confirmed' && p.commitment !== 'finalized') fail('invalid provenance commitment');
  if (p.rpc_method !== 'getTransaction' || p.encoding !== 'jsonParsed') fail('invalid RPC provenance contract');
  const startedMs = assertIsoInstant(p.request_started_at, 'provenance request_started_at');
  const observedMs = assertIsoInstant(p.observed_at, 'provenance observed_at');
  if (observedMs < startedMs) fail('invalid provenance chronology');

  if (p.found === false) {
    if (p.slot !== null || p.block_time !== null || p.fee_payer !== null || p.trader_is_fee_payer !== false || p.source_reference !== null) fail('not-found evidence must remain empty');
    if (!Array.isArray(p.account_keys) || p.account_keys.length !== 0) fail('not-found account keys must be empty');
  } else if (p.found === true) {
    const slot = assertSafeInteger(p.slot, 'provenance slot');
    if (p.block_time !== null) {
      const bt = assertSafeInteger(p.block_time, 'provenance block_time');
      if (bt * 1000 > observedMs) fail('provenance block_time cannot be after observed_at');
    }
    const accountKeys = normalizeAccountKeys(p.account_keys);
    const first = accountKeys[0];
    if (first.source !== 'transaction' || first.signer !== true || first.writable !== true) fail('invalid fee payer topology');
    if (p.fee_payer !== first.pubkey) fail('fee payer not bound to first account key');
    const expectedTraderIsFeePayer = first.pubkey === requestedWallet;
    if (p.trader_is_fee_payer !== expectedTraderIsFeePayer) fail('fee payer attribution mismatch');
    const expectedReference = buildSourceReference(requestedSignature, slot, expectedTraderIsFeePayer);
    if (p.source_reference !== expectedReference) fail('source reference eligibility mismatch');
  } else fail('found must be boolean');

  if (evidence.source_reference !== p.source_reference || evidence.fee_payer !== p.fee_payer || evidence.trader_is_fee_payer !== p.trader_is_fee_payer) fail('public evidence/provenance mismatch');
  const expectedHash = sha256(canonicalJson(p));
  if (evidence.source_hash !== expectedHash) fail('provenance hash mismatch');
  return true;
}
