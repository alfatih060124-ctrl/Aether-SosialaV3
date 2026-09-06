import { createHash } from 'node:crypto';

const SUPPORTED_SOURCES = new Set(['SOLANA_RPC', 'SOLSCAN', 'INTERNAL_RECONCILIATION']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonicalIso(value, code) {
  if (typeof value !== 'string') fail(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(code);
  return value;
}

function canonicalSourceType(value) {
  if (!SUPPORTED_SOURCES.has(value)) fail('unsupported_evidence_source');
  return value;
}

function canonicalReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > 512) {
    fail('invalid_source_reference');
  }
  return value;
}

function canonicalHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid_source_hash');
  return value;
}

function canonicalOrigin(value) {
  if (typeof value !== 'string') fail('invalid_source_origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_source_origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('invalid_source_origin');
  }
  if (url.origin !== value) fail('noncanonical_source_origin');
  return value;
}

function canonicalStatus(value) {
  if (!Number.isSafeInteger(value) || value < 200 || value > 299) fail('invalid_source_http_status');
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildEvidenceSourceObservationReceipt({
  source_type,
  source_reference,
  source_hash,
  source_origin,
  request_started_at,
  observed_at,
  collected_at,
  http_status,
}) {
  const payload = {
    schema: 'aether.evidence_source_observation_receipt.v1',
    source_type: canonicalSourceType(source_type),
    source_reference: canonicalReference(source_reference),
    source_hash: canonicalHash(source_hash),
    source_origin: canonicalOrigin(source_origin),
    request_method: 'GET',
    request_started_at: canonicalIso(request_started_at, 'invalid_request_started_at'),
    observed_at: canonicalIso(observed_at, 'invalid_observed_at'),
    collected_at: canonicalIso(collected_at, 'invalid_collected_at'),
    http_status: canonicalStatus(http_status),
  };

  const requestMs = Date.parse(payload.request_started_at);
  const observedMs = Date.parse(payload.observed_at);
  const collectedMs = Date.parse(payload.collected_at);
  if (observedMs < requestMs) fail('observation_before_request');
  if (collectedMs < observedMs) fail('collection_before_observation');

  return {
    ...payload,
    receipt_hash: sha256(payload),
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

export function verifyEvidenceSourceObservationReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  try {
    const rebuilt = buildEvidenceSourceObservationReceipt(receipt);
    return receipt.schema === rebuilt.schema
      && receipt.source_type === rebuilt.source_type
      && receipt.source_reference === rebuilt.source_reference
      && receipt.source_hash === rebuilt.source_hash
      && receipt.source_origin === rebuilt.source_origin
      && receipt.request_method === 'GET'
      && receipt.request_started_at === rebuilt.request_started_at
      && receipt.observed_at === rebuilt.observed_at
      && receipt.collected_at === rebuilt.collected_at
      && receipt.http_status === rebuilt.http_status
      && receipt.receipt_hash === rebuilt.receipt_hash
      && receipt.collection_status === 'PENDING_DATA'
      && receipt.metrics_available === false
      && receipt.trades_count === null
      && receipt.total_return_bps === null
      && receipt.win_rate_bps === null
      && receipt.drawdown_bps === null
      && receipt.reputation_score === null
      && receipt.verified === false
      && receipt.published === false
      && receipt.live_execution_authorized === false;
  } catch {
    return false;
  }
}
