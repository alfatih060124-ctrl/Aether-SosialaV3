import { createHash } from 'node:crypto';

const SCHEMA = 'aether.evidence_batch_manifest.v1';
const SOURCE_TYPES = new Set(['SOLANA_RPC', 'SOLSCAN', 'INTERNAL_RECONCILIATION']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CANONICAL_SLOT_RE = /^(0|[1-9][0-9]*)$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

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

function requireCanonicalSourceReference(sourceType, sourceReference) {
  if (typeof sourceReference !== 'string' || sourceReference.trim() !== sourceReference || sourceReference.length === 0) {
    fail('invalid_evidence_source_reference');
  }

  if (sourceType !== 'SOLANA_RPC' && sourceType !== 'SOLSCAN') return sourceReference;

  const prefix = `${sourceType.toLowerCase()}:`;
  if (!sourceReference.startsWith(prefix)) fail('invalid_evidence_source_reference');
  const remainder = sourceReference.slice(prefix.length);
  const separator = remainder.lastIndexOf('@');
  if (separator <= 0 || remainder.indexOf('@') !== separator) fail('invalid_evidence_source_reference');

  const signature = remainder.slice(0, separator);
  const slotText = remainder.slice(separator + 1);
  if (!SIGNATURE_BASE58_RE.test(signature) || decodedBase58ByteLength(signature) !== 64) {
    fail('invalid_evidence_source_reference');
  }
  if (!CANONICAL_SLOT_RE.test(slotText)) fail('invalid_evidence_source_reference');
  const slot = Number(slotText);
  if (!Number.isSafeInteger(slot) || slot < 0 || String(slot) !== slotText) {
    fail('invalid_evidence_source_reference');
  }
  return sourceReference;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail('invalid_evidence_observed_at');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('invalid_evidence_observed_at');
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) fail('noncanonical_evidence_observed_at');
  return canonical;
}

function canonicalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('invalid_evidence_record');
  }

  const sourceType = record.source_type;
  if (!SOURCE_TYPES.has(sourceType)) fail('unsupported_evidence_source_type');

  const sourceReference = requireCanonicalSourceReference(sourceType, record.source_reference);

  const sourceHash = record.source_hash;
  if (typeof sourceHash !== 'string' || !SHA256_RE.test(sourceHash)) {
    fail('invalid_evidence_source_hash');
  }

  return Object.freeze({
    source_type: sourceType,
    source_reference: sourceReference,
    source_hash: sourceHash,
    observed_at: canonicalTimestamp(record.observed_at),
  });
}

function stableLine(record) {
  return JSON.stringify([
    record.source_type,
    record.source_reference,
    record.source_hash,
    record.observed_at,
  ]);
}

export function buildEvidenceBatchManifest(records, { collected_at } = {}) {
  if (!Array.isArray(records) || records.length === 0) fail('evidence_batch_empty');
  if (records.length > 10_000) fail('evidence_batch_too_large');

  const canonical = records.map(canonicalRecord);
  canonical.sort((a, b) => stableLine(a).localeCompare(stableLine(b), 'en'));

  const seen = new Set();
  for (const record of canonical) {
    const identity = `${record.source_type}\u0000${record.source_reference}`;
    if (seen.has(identity)) fail('duplicate_evidence_source_reference');
    seen.add(identity);
  }

  const canonicalCollectedAt = canonicalTimestamp(collected_at);
  const payload = `${SCHEMA}\n${canonical.map(stableLine).join('\n')}\ncollected_at=${canonicalCollectedAt}`;
  const manifestHash = createHash('sha256').update(payload, 'utf8').digest('hex');

  return Object.freeze({
    schema: SCHEMA,
    manifest_hash: manifestHash,
    evidence_count: canonical.length,
    collected_at: canonicalCollectedAt,
    records: Object.freeze(canonical),
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
    audit: Object.freeze({
      ordering: 'LEXICOGRAPHIC_CANONICAL_RECORD_V1',
      digest: 'SHA256',
      source_references_supplied_only: true,
      performance_metrics_derived: false,
    }),
  });
}

export function verifyEvidenceBatchManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid_evidence_manifest');
  if (manifest.schema !== SCHEMA) fail('invalid_evidence_manifest_schema');
  if (manifest.collection_status !== 'PENDING_DATA' || manifest.metrics_available !== false) fail('evidence_manifest_status_violation');
  if (manifest.verified !== false || manifest.published !== false || manifest.live_execution_authorized !== false) {
    fail('evidence_manifest_boundary_violation');
  }
  for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) {
    if (manifest[key] !== null) fail('evidence_manifest_metric_fabrication');
  }

  const rebuilt = buildEvidenceBatchManifest(manifest.records, { collected_at: manifest.collected_at });
  if (rebuilt.manifest_hash !== manifest.manifest_hash) fail('evidence_manifest_hash_mismatch');
  if (rebuilt.evidence_count !== manifest.evidence_count) fail('evidence_manifest_count_mismatch');
  return true;
}
