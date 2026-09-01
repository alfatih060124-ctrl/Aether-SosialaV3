import crypto from 'node:crypto';

const SOURCES = new Set(['SOLANA_RPC','SOLSCAN','INDEXER','INTERNAL_RECONCILIATION']);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function int(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}

function text(value, name, min, max) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
}

function safeMetricNumber(value, name) {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) throw new Error(`invalid_${name}_range`);
  return Number(value);
}

function roundRatio(numerator, denominator) {
  if (denominator <= 0n) throw new Error('invalid_metric_denominator');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const twiceAbsRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  if (numerator >= 0n) return twiceAbsRemainder >= denominator ? quotient + 1n : quotient;
  return twiceAbsRemainder > denominator ? quotient - 1n : quotient;
}

export function normalizeEvidenceReference({ sourceType, reference }) {
  const source = String(sourceType || '').trim().toUpperCase();
  if (!SOURCES.has(source)) throw new Error('invalid_verification_source');
  const ref = text(reference, 'verification_reference', 8, 300);
  if (source === 'SOLANA_RPC' && !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(ref)) throw new Error('invalid_solana_signature');
  return { source_type: source, source_reference: ref };
}

export function calculateReconciledMetrics(trades = []) {
  if (!Array.isArray(trades) || trades.length === 0) throw new Error('insufficient_reconciled_trades');
  const rows = trades.map((trade, i) => ({
    trade_id: text(trade.trade_id, `trade_${i}_id`, 1, 120),
    realized_pnl_minor: int(trade.realized_pnl_minor, `trade_${i}_realized_pnl_minor`, -9_000_000_000_000_000, 9_000_000_000_000_000),
    capital_minor: int(trade.capital_minor, `trade_${i}_capital_minor`, 1, 9_000_000_000_000_000),
    equity_after_minor: int(trade.equity_after_minor, `trade_${i}_equity_after_minor`, 1, 9_000_000_000_000_000)
  }));

  const capital = rows.reduce((sum, row) => sum + BigInt(row.capital_minor), 0n);
  const pnl = rows.reduce((sum, row) => sum + BigInt(row.realized_pnl_minor), 0n);
  const wins = rows.filter(row => row.realized_pnl_minor > 0).length;
  let peak = BigInt(rows[0].equity_after_minor);
  let maxDrawdownBps = 0n;
  for (const row of rows) {
    const equity = BigInt(row.equity_after_minor);
    if (equity > peak) peak = equity;
    const dd = roundRatio((peak - equity) * 10_000n, peak);
    if (dd > maxDrawdownBps) maxDrawdownBps = dd;
  }

  return {
    trades_count: rows.length,
    total_return_bps: safeMetricNumber(roundRatio(pnl * 10_000n, capital), 'total_return_bps'),
    win_rate_bps: safeMetricNumber(roundRatio(BigInt(wins) * 10_000n, BigInt(rows.length)), 'win_rate_bps'),
    drawdown_bps: safeMetricNumber(maxDrawdownBps, 'drawdown_bps')
  };
}

export function buildRecordedEvidence({ sourceType, reference, observedAt, trades, provenance = {} }) {
  const normalized = normalizeEvidenceReference({ sourceType, reference });
  const observed = new Date(observedAt || '');
  if (Number.isNaN(observed.getTime()) || observed.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('invalid_verification_observed_at');
  const metrics = calculateReconciledMetrics(trades);
  const canonicalCalculationRows = trades.map(t => ({
    trade_id: String(t.trade_id),
    realized_pnl_minor: int(t.realized_pnl_minor, 'calculation_realized_pnl_minor', -9_000_000_000_000_000, 9_000_000_000_000_000),
    capital_minor: int(t.capital_minor, 'calculation_capital_minor', 1, 9_000_000_000_000_000),
    equity_after_minor: int(t.equity_after_minor, 'calculation_equity_after_minor', 1, 9_000_000_000_000_000)
  }));
  const calculationHash = crypto.createHash('sha256').update(JSON.stringify({
    v: 3,
    arithmetic: 'BIGINT_INTEGER_BPS_HALF_TOWARD_POSITIVE_INFINITY',
    rows: canonicalCalculationRows,
    metrics
  })).digest('hex');
  const sourceHash = String(provenance.source_hash || '').trim();
  if (sourceHash && !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('invalid_source_hash');
  return {
    ...normalized,
    observed_at: observed.toISOString(),
    ...metrics,
    evidence_status: 'RECORDED',
    provenance: {
      schema_version: 3,
      collector: 'AETHER_TRADER_EVIDENCE',
      calculation_method: 'BIGINT_INTEGER_BPS_HALF_TOWARD_POSITIVE_INFINITY',
      calculation_hash: calculationHash,
      source_hash: sourceHash || null,
      rpc_endpoint_label: String(provenance.rpc_endpoint_label || '').trim() || null,
      indexer_batch_id: String(provenance.indexer_batch_id || '').trim() || null,
      reconciliation_batch_id: String(provenance.reconciliation_batch_id || '').trim() || null
    }
  };
}

export function pendingData(reason = 'insufficient_verifiable_data') {
  return {
    verification_status: 'PENDING_DATA',
    verified: false,
    published: false,
    evidence_status: 'NOT_RECORDED',
    reason: String(reason)
  };
}
