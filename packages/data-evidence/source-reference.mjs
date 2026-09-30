const SOURCE_TYPES = new Set(['SOLANA_RPC', 'SOLSCAN', 'INTERNAL_RECONCILIATION']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${field}`);
  return value;
}

export function normalizeEvidenceSourceReference(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_source_reference');
  const source_type = requireString(input.source_type, 'source_type');
  if (!SOURCE_TYPES.has(source_type)) throw new Error('unsupported_source_type');

  if (source_type === 'SOLANA_RPC' || source_type === 'SOLSCAN') {
    const signature = requireString(input.signature, 'signature');
    const slot = requireSafeInteger(input.slot, 'slot');
    return Object.freeze({ source_type, signature, slot });
  }

  const reconciliation_id = requireString(input.reconciliation_id, 'reconciliation_id');
  return Object.freeze({ source_type, reconciliation_id });
}

export function canonicalEvidenceSourceReference(input) {
  const normalized = normalizeEvidenceSourceReference(input);
  if (normalized.source_type === 'INTERNAL_RECONCILIATION') {
    return `internal-reconciliation:${encodeURIComponent(normalized.reconciliation_id)}`;
  }
  return `${normalized.source_type.toLowerCase()}:${normalized.signature}@${normalized.slot}`;
}

export function pendingEvidenceBoundary(sourceReference) {
  const source_reference = canonicalEvidenceSourceReference(sourceReference);
  return Object.freeze({
    source_reference,
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
  });
}
