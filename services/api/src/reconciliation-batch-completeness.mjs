import crypto from 'node:crypto';

const ALLOWED_STATUSES = new Set(['RECONCILED', 'PENDING', 'REJECTED']);

function canonicalText(value, name, min = 1, max = 160) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  if (value.length < min || value.length > max) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalTimestamp(value, name) {
  const raw = canonicalText(value, name, 20, 40);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) throw new Error(`invalid_${name}`);
  return raw;
}

function canonicalRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 10_000) {
    throw new Error('invalid_reconciliation_rows');
  }

  const seen = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`invalid_row_${index}`);
    const tradeId = canonicalText(row.trade_id, `row_${index}_trade_id`, 1, 120);
    if (seen.has(tradeId)) throw new Error('duplicate_reconciliation_trade_id');
    seen.add(tradeId);

    const status = canonicalText(row.reconciliation_status, `row_${index}_status`, 1, 24);
    if (!ALLOWED_STATUSES.has(status)) throw new Error(`invalid_row_${index}_status`);

    return {
      trade_id: tradeId,
      reconciliation_status: status
    };
  }).sort((a, b) => a.trade_id.localeCompare(b.trade_id));
}

function pendingBoundary(reason, provenance) {
  return {
    collection_status: 'PENDING_DATA',
    reason,
    reconciliation_complete: false,
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    source_reference: null,
    provenance
  };
}

export function assessReconciliationBatchCompleteness({ reconciliationBatchId, observedAt, rows } = {}) {
  const batchId = canonicalText(reconciliationBatchId, 'reconciliation_batch_id', 8, 160);
  const observed = canonicalTimestamp(observedAt, 'observed_at');
  const canonical = canonicalRows(rows);

  const counts = canonical.reduce((acc, row) => {
    acc[row.reconciliation_status] += 1;
    return acc;
  }, { RECONCILED: 0, PENDING: 0, REJECTED: 0 });

  const completenessHash = crypto.createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    reconciliation_batch_id: batchId,
    observed_at: observed,
    rows: canonical,
    counts
  })).digest('hex');

  const provenance = {
    schema_version: 1,
    source_type: 'INTERNAL_RECONCILIATION',
    reconciliation_batch_id: batchId,
    observed_at: observed,
    row_count: canonical.length,
    counts,
    completeness_hash: completenessHash
  };

  if (counts.PENDING > 0) return pendingBoundary('reconciliation_rows_pending', provenance);
  if (counts.REJECTED > 0) return pendingBoundary('reconciliation_rows_rejected', provenance);
  if (counts.RECONCILED !== canonical.length) return pendingBoundary('reconciliation_incomplete', provenance);

  return {
    ...pendingBoundary('reconciliation_complete_metrics_not_calculated', provenance),
    reconciliation_complete: true
  };
}

export function verifyReconciliationBatchCompleteness(result, input) {
  if (!result || typeof result !== 'object') return false;
  try {
    const recomputed = assessReconciliationBatchCompleteness(input);
    return JSON.stringify(result) === JSON.stringify(recomputed);
  } catch {
    return false;
  }
}
