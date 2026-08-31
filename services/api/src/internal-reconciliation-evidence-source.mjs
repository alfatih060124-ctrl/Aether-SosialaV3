import crypto from 'node:crypto';
import { buildRecordedEvidence, pendingData } from './trader-evidence-collector.mjs';

function text(value, name, min = 1, max = 160) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
}

function canonicalReconciledTrades(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_reconciliation_rows');
  return rows
    .filter(row => String(row?.reconciliation_status || '').toUpperCase() === 'RECONCILED')
    .map((row, i) => ({
      trade_id: text(row.trade_id, `trade_${i}_id`, 1, 120),
      realized_pnl_minor: row.realized_pnl_minor,
      capital_minor: row.capital_minor,
      equity_after_minor: row.equity_after_minor,
      source_signature: text(row.source_signature, `trade_${i}_source_signature`, 32, 100)
    }))
    .sort((a, b) => a.trade_id.localeCompare(b.trade_id));
}

export function buildInternalReconciliationProvenance({ walletAddress, reconciliationBatchId, trades }) {
  const wallet = text(walletAddress, 'wallet_address', 32, 44);
  const batch = text(reconciliationBatchId, 'reconciliation_batch_id', 1, 160);
  const canonical = canonicalReconciledTrades(trades);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    v: 1,
    wallet_address: wallet,
    reconciliation_batch_id: batch,
    trades: canonical.map(row => ({ trade_id: row.trade_id, source_signature: row.source_signature }))
  })).digest('hex');
  return {
    schema_version: 1,
    source_type: 'INTERNAL_RECONCILIATION',
    wallet_address: wallet,
    reconciliation_batch_id: batch,
    reconciled_trades: canonical.length,
    source_hash: sourceHash
  };
}

export function collectInternalReconciliationEvidence({ walletAddress, reconciliationBatchId, observedAt, trades } = {}) {
  const canonical = canonicalReconciledTrades(trades);
  const provenance = buildInternalReconciliationProvenance({ walletAddress, reconciliationBatchId, trades });

  if (canonical.length === 0) {
    return {
      ...pendingData('no_reconciled_trades'),
      source_type: 'INTERNAL_RECONCILIATION',
      source_reference: null,
      provenance
    };
  }

  // Every metric is delegated to the deterministic reconciled-trade calculator.
  // Missing/invalid PnL, capital, or equity fails closed via buildRecordedEvidence.
  return {
    ...buildRecordedEvidence({
      sourceType: 'INTERNAL_RECONCILIATION',
      reference: reconciliationBatchId,
      observedAt,
      trades: canonical,
      provenance: { reconciliation_batch_id: reconciliationBatchId }
    }),
    verification_status: 'PENDING_REVIEW',
    verified: false,
    published: false
  };
}
