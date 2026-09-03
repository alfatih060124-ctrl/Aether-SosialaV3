import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));
const ENDPOINT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RETURN_BYTES = 65536;
const NULL_METRICS = Object.freeze({ trades_count: null, total_return_bps: null, win_rate_bps: null, drawdown_bps: null, reputation_score: null });

function fail(message) { throw new Error(message); }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function assertSafeInteger(value, name, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be a safe integer >= ${min}`); return value; }
function assertIsoInstant(value, name) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(`${name} must be canonical ISO-8601 UTC`); const ms = Date.parse(value); if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(`${name} must be canonical ISO-8601 UTC`); return ms; }
function decodeBase58(text) { if (typeof text !== 'string' || text.length === 0) fail('Base58 value required'); let bytes = [0]; for (const ch of text) { const digit = B58_MAP.get(ch); if (digit === undefined) fail('invalid Base58 character'); let carry = digit; for (let i = 0; i < bytes.length; i += 1) { const x = bytes[i] * 58 + carry; bytes[i] = x & 255; carry = x >> 8; } while (carry > 0) { bytes.push(carry & 255); carry >>= 8; } } for (let i = 0; i < text.length - 1 && text[i] === '1'; i += 1) bytes.push(0); return Uint8Array.from(bytes.reverse()); }
function assertSolanaId(text, bytes, name) { if (typeof text !== 'string' || text.length > 128 || decodeBase58(text).length !== bytes) fail(`${name} must decode to ${bytes} bytes`); return text; }
function normalizeEndpointLabel(value) { if (typeof value !== 'string' || !ENDPOINT_LABEL.test(value)) fail('rpc_endpoint_label must be opaque and credential-free'); return value; }
function normalizeAccountKeys(raw) { if (!Array.isArray(raw) || raw.length === 0) fail('transaction account keys required'); const seen = new Set(); return raw.map((row, index) => { const pubkey = typeof row === 'string' ? row : row?.pubkey; const key = assertSolanaId(pubkey, 32, `account_keys[${index}]`); if (seen.has(key)) fail('duplicate transaction account key'); seen.add(key); return key; }); }
function canonicalJson(value) { if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value); if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite JSON number'); return JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`; fail('unsupported JSON value'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizeReturnData(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) fail('meta.returnData must be object or null');
  const programId = assertSolanaId(raw.programId, 32, 'returnData.programId');
  if (!Array.isArray(raw.data) || raw.data.length !== 2 || typeof raw.data[0] !== 'string' || raw.data[1] !== 'base64') fail('returnData.data must be [base64, "base64"]');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data[0])) fail('returnData base64 must be canonical');
  const decoded = Buffer.from(raw.data[0], 'base64'); if (decoded.length > MAX_RETURN_BYTES || decoded.toString('base64') !== raw.data[0]) fail('returnData base64 invalid or too large');
  return { program_id: programId, encoding: 'base64', data_base64: raw.data[0], data_sha256: sha256(decoded) };
}
function baseOutput() { return { schema: 'aether.solana.transaction_return_data_evidence.v1', collection_status: 'PENDING_DATA', metrics_available: false, ...NULL_METRICS, verified: false, published: false, live_execution_authorized: false, reconciliation_required: true }; }
function sourceReference(signature, slot, eligible) { return eligible ? `solana_rpc:${signature}@${slot}` : null; }
function finalize(provenance) { return { ...baseOutput(), source_reference: provenance.source_reference, return_data: provenance.return_data, provenance, source_hash: sha256(canonicalJson(provenance)) }; }

export async function collectSolanaTransactionReturnDataEvidence({ rpcRequest, signature, traderWallet, rpcEndpointLabel, commitment = 'confirmed', requestStartedAt, observedAt }) {
  if (typeof rpcRequest !== 'function') fail('rpcRequest function required');
  const requestedSignature = assertSolanaId(signature, 64, 'signature');
  const requestedWallet = assertSolanaId(traderWallet, 32, 'traderWallet');
  const endpointLabel = normalizeEndpointLabel(rpcEndpointLabel);
  if (commitment !== 'confirmed' && commitment !== 'finalized') fail('commitment must be confirmed or finalized');
  const startedMs = assertIsoInstant(requestStartedAt, 'requestStartedAt'); const observedMs = assertIsoInstant(observedAt, 'observedAt'); if (observedMs < startedMs) fail('observedAt must not precede requestStartedAt');
  const response = await rpcRequest('getTransaction', [requestedSignature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
  if (!isPlainObject(response) || response.jsonrpc !== '2.0' || !Object.hasOwn(response, 'result')) fail('malformed RPC response');
  if (response.result === null) return finalize({ schema: 'aether.solana.transaction_return_data_provenance.v1', rpc_method: 'getTransaction', encoding: 'jsonParsed', commitment, rpc_endpoint_label: endpointLabel, request_started_at: requestStartedAt, observed_at: observedAt, requested_signature: requestedSignature, requested_wallet: requestedWallet, found: false, slot: null, block_time: null, transaction_err: null, account_keys: [], return_data: null, source_reference: null });
  const result = response.result;
  if (!isPlainObject(result) || !isPlainObject(result.transaction) || !isPlainObject(result.transaction.message) || !isPlainObject(result.meta)) fail('malformed transaction result');
  if (!Object.hasOwn(result.meta, 'err')) fail('meta.err is required');
  const slot = assertSafeInteger(result.slot, 'slot'); const blockTime = result.blockTime === null ? null : assertSafeInteger(result.blockTime, 'blockTime'); if (blockTime !== null && blockTime * 1000 > observedMs) fail('blockTime cannot be after observedAt');
  if (!Array.isArray(result.transaction.signatures) || result.transaction.signatures.length < 1) fail('transaction signatures required'); const returnedSignature = assertSolanaId(result.transaction.signatures[0], 64, 'returned primary signature'); if (returnedSignature !== requestedSignature) fail('returned primary signature does not match request');
  const accountKeys = normalizeAccountKeys(result.transaction.message.accountKeys); if (!accountKeys.includes(requestedWallet)) fail('requested trader wallet must participate in transaction');
  const transactionErr = result.meta.err; if (transactionErr !== null && !isPlainObject(transactionErr)) fail('transaction err must be object or null');
  const returnData = normalizeReturnData(Object.hasOwn(result.meta, 'returnData') ? result.meta.returnData : null);
  const ref = sourceReference(requestedSignature, slot, returnData !== null);
  return finalize({ schema: 'aether.solana.transaction_return_data_provenance.v1', rpc_method: 'getTransaction', encoding: 'jsonParsed', commitment, rpc_endpoint_label: endpointLabel, request_started_at: requestStartedAt, observed_at: observedAt, requested_signature: requestedSignature, requested_wallet: requestedWallet, found: true, slot, block_time: blockTime, transaction_err: transactionErr, account_keys: accountKeys, return_data: returnData, source_reference: ref });
}

export function verifySolanaTransactionReturnDataEvidence(evidence) {
  if (!isPlainObject(evidence) || evidence.schema !== 'aether.solana.transaction_return_data_evidence.v1') fail('invalid evidence schema');
  if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) fail('unsafe evidence state');
  for (const key of Object.keys(NULL_METRICS)) if (evidence[key] !== null) fail(`${key} must remain null`);
  const p = evidence.provenance; if (!isPlainObject(p) || p.schema !== 'aether.solana.transaction_return_data_provenance.v1') fail('invalid provenance');
  const sig = assertSolanaId(p.requested_signature, 64, 'provenance requested signature'); const wallet = assertSolanaId(p.requested_wallet, 32, 'provenance requested wallet'); normalizeEndpointLabel(p.rpc_endpoint_label);
  if (p.rpc_method !== 'getTransaction' || p.encoding !== 'jsonParsed' || (p.commitment !== 'confirmed' && p.commitment !== 'finalized')) fail('invalid RPC provenance contract');
  const startedMs = assertIsoInstant(p.request_started_at, 'provenance request_started_at'); const observedMs = assertIsoInstant(p.observed_at, 'provenance observed_at'); if (observedMs < startedMs) fail('invalid provenance chronology');
  if (p.found === false) { if (p.slot !== null || p.block_time !== null || p.transaction_err !== null || p.return_data !== null || p.source_reference !== null || !Array.isArray(p.account_keys) || p.account_keys.length !== 0) fail('not-found evidence must remain empty'); }
  else if (p.found === true) { const slot = assertSafeInteger(p.slot, 'provenance slot'); if (p.block_time !== null && assertSafeInteger(p.block_time, 'provenance block_time') * 1000 > observedMs) fail('provenance block_time cannot be after observed_at'); if (p.transaction_err !== null && !isPlainObject(p.transaction_err)) fail('provenance transaction_err must be object or null'); const keys = normalizeAccountKeys(p.account_keys); if (!keys.includes(wallet)) fail('requested wallet missing from provenance account keys'); const normalized = normalizeReturnData(p.return_data === null ? null : { programId: p.return_data.program_id, data: [p.return_data.data_base64, p.return_data.encoding] }); if (canonicalJson(normalized) !== canonicalJson(p.return_data)) fail('return data mismatch'); const expectedRef = sourceReference(sig, slot, normalized !== null); if (p.source_reference !== expectedRef) fail('source reference mismatch'); }
  else fail('found must be boolean');
  if (evidence.source_reference !== p.source_reference || canonicalJson(evidence.return_data) !== canonicalJson(p.return_data)) fail('public evidence/provenance mismatch');
  if (evidence.source_hash !== sha256(canonicalJson(p))) fail('provenance hash mismatch');
  return true;
}
