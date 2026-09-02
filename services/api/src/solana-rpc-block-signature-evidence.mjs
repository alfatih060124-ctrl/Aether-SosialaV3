import crypto from 'node:crypto';

const SCHEMA = 'aether.solana_rpc.block_signature_evidence.v1';
const REF_RE = /^solana_rpc:([1-9A-HJ-NP-Za-km-z]+)@([0-9]+)$/;
const ENDPOINT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('Base58 text required');
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new TypeError('invalid Base58 text');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 255n));
    n >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  while (leading < text.length && text[leading] === '1') leading += 1;
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

function canonicalSignature(value, field = 'signature') {
  if (typeof value !== 'string' || decodeBase58(value).length !== 64) throw new TypeError(`${field} must be a 64-byte Solana Base58 signature`);
  return value;
}

function canonicalHash32(value, field) {
  if (typeof value !== 'string' || decodeBase58(value).length !== 32) throw new TypeError(`${field} must be a 32-byte Solana Base58 hash`);
  return value;
}

function canonicalSlot(value, field = 'slot') {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function canonicalIso(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be an ISO timestamp string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new TypeError(`${field} must be canonical ISO-8601 UTC`);
  return value;
}

function canonicalEndpointLabel(value) {
  if (typeof value !== 'string' || !ENDPOINT_LABEL_RE.test(value)) throw new TypeError('rpc_endpoint_label must be an opaque identifier');
  return value;
}

function parseReference(value) {
  if (typeof value !== 'string') throw new TypeError('source_reference must be canonical Solana RPC reference');
  const match = REF_RE.exec(value);
  if (!match) throw new TypeError('source_reference must be solana_rpc:<signature>@<slot>');
  const signature = canonicalSignature(match[1]);
  const slot = Number(match[2]);
  canonicalSlot(slot);
  if (String(slot) !== match[2]) throw new TypeError('source_reference slot must be canonical decimal');
  return { signature, slot, source_reference: value };
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeSignatures(values) {
  if (!Array.isArray(values) || values.length > 10000) throw new TypeError('block signatures must be a bounded array');
  return values.map((value, index) => canonicalSignature(value, `signatures[${index}]`));
}

export function buildSolanaRpcBlockSignatureEvidence({ source_reference, rpc_endpoint_label, commitment, request_started_at, observed_at, block }) {
  const ref = parseReference(source_reference);
  const endpoint = canonicalEndpointLabel(rpc_endpoint_label);
  if (!['confirmed', 'finalized'].includes(commitment)) throw new TypeError('commitment must be confirmed or finalized');
  const started = canonicalIso(request_started_at, 'request_started_at');
  const observed = canonicalIso(observed_at, 'observed_at');
  if (Date.parse(observed) < Date.parse(started)) throw new RangeError('observed_at cannot precede request_started_at');

  let blockFound = false;
  let signatureFound = false;
  let blockhash = null;
  let previous_blockhash = null;
  let parent_slot = null;
  let block_time = null;
  let block_signatures = [];

  if (block !== null) {
    if (!block || typeof block !== 'object') throw new TypeError('block must be object or null');
    blockhash = canonicalHash32(block.blockhash, 'blockhash');
    previous_blockhash = canonicalHash32(block.previousBlockhash, 'previousBlockhash');
    parent_slot = canonicalSlot(block.parentSlot, 'parentSlot');
    if (parent_slot >= ref.slot) throw new RangeError('parentSlot must precede requested slot');
    if (block.blockTime !== null) {
      if (!Number.isSafeInteger(block.blockTime)) throw new TypeError('blockTime must be integer seconds or null');
      block_time = block.blockTime;
      if (block_time * 1000 > Date.parse(observed)) throw new RangeError('blockTime cannot be after observed_at');
    }
    block_signatures = normalizeSignatures(block.signatures);
    signatureFound = block_signatures.includes(ref.signature);
    blockFound = true;
  }

  const provenance = {
    schema: SCHEMA,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getBlock',
    requested_source_reference: ref.source_reference,
    requested_signature_hash: hashCanonical(ref.signature),
    requested_slot: ref.slot,
    rpc_endpoint_label: endpoint,
    commitment,
    transaction_details: 'signatures',
    rewards: false,
    block_found: blockFound,
    signature_found_in_block: signatureFound,
    blockhash,
    previous_blockhash,
    parent_slot,
    block_time,
    block_signatures,
    signatures_count: block_signatures.length,
    signatures_hash: blockFound ? hashCanonical(block_signatures) : null,
    request_started_at: started,
    observed_at: observed,
  };

  return {
    ...provenance,
    provenance_hash: hashCanonical(provenance),
    collection_status: 'PENDING_DATA',
    status_reason: !blockFound ? 'block_not_found' : signatureFound ? 'block_signature_corroborated_reconciliation_required' : 'signature_not_present_in_claimed_slot',
    source_reference: signatureFound ? ref.source_reference : null,
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

export async function collectSolanaRpcBlockSignatureEvidence({ rpc, source_reference, rpc_endpoint_label, commitment = 'finalized', clock = () => new Date() }) {
  if (!rpc || typeof rpc.call !== 'function') throw new TypeError('rpc.call is required');
  const ref = parseReference(source_reference);
  canonicalEndpointLabel(rpc_endpoint_label);
  if (!['confirmed', 'finalized'].includes(commitment)) throw new TypeError('commitment must be confirmed or finalized');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const started = clock();
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) throw new TypeError('clock must return valid Date');
  const response = await rpc.call('getBlock', [ref.slot, { commitment, transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]);
  const observed = clock();
  if (!(observed instanceof Date) || Number.isNaN(observed.getTime())) throw new TypeError('clock must return valid Date');
  if (!response || typeof response !== 'object' || !Object.prototype.hasOwnProperty.call(response, 'result')) throw new TypeError('getBlock response must contain result');
  return buildSolanaRpcBlockSignatureEvidence({
    source_reference: ref.source_reference,
    rpc_endpoint_label,
    commitment,
    request_started_at: started.toISOString(),
    observed_at: observed.toISOString(),
    block: response.result,
  });
}

export function verifySolanaRpcBlockSignatureEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  try {
    const block = evidence.block_found ? {
      blockhash: evidence.blockhash,
      previousBlockhash: evidence.previous_blockhash,
      parentSlot: evidence.parent_slot,
      blockTime: evidence.block_time,
      signatures: evidence.block_signatures,
    } : null;
    const rebuilt = buildSolanaRpcBlockSignatureEvidence({
      source_reference: evidence.requested_source_reference,
      rpc_endpoint_label: evidence.rpc_endpoint_label,
      commitment: evidence.commitment,
      request_started_at: evidence.request_started_at,
      observed_at: evidence.observed_at,
      block,
    });
    return evidence.provenance_hash === rebuilt.provenance_hash
      && evidence.source_reference === rebuilt.source_reference
      && evidence.status_reason === rebuilt.status_reason
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
