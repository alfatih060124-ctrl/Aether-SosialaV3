import crypto from 'node:crypto';
import { buildRecordedEvidence, pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function text(value, name, min = 1, max = 160) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
}

function solanaBase58(value, name, min, max) {
  const s = text(value, name, min, max);
  if (!BASE58.test(s)) throw new Error(`invalid_${name}`);
  return s;
}

function timestamp(value, name) {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) throw new Error(`invalid_${name}`);
  return d.toISOString();
}

function canonicalReconciledTrades(rows = []) {
  if (!Array.isArray(rows)) throw new Error('invalid_reconciliation_rows');
  return rows
    .filter(row => String(row?.reconciliation_status || '').toUpperCase() === 'RECONCILED')
    .map((row, i) => ({
      trade_id: text(row.trade_id, `trade_${i}_id`, 1, 120),
      executed_at: timestamp(row.executed_at, `trade_${i}_executed_at`),
      realized_pnl_minor: row.realized_pnl_minor,
      capital_minor: row.capital_minor,
      equity_after_minor: row.equity_after_minor,
      source_signature: solanaBase58(row.source_signature, `trade_${i}_source_signature`, 32, 100)
    }))
    .sort((a, b) => a.executed_at.localeCompare(b.executed_at) || a.trade_id.localeCompare(b.trade_id));
}

export function buildInternalReconciliationProvenance({ walletAddress, reconciliationBatchId, trades }) {
  const wallet = solanaBase58(walletAddress, 'wallet_address', 32, 44);
  const batch = text(reconciliationBatchId, 'reconciliation_batch_id', 8, 160);
  const canonical = canonicalReconciledTrades(trades);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    v: 2,
    wallet_address: wallet,
    reconciliation_batch_id: batch,
    trades: canonical.map(row => ({
      trade_id: row.trade_id,
      executed_at: row.executed_at,
      source_signature: row.source_signature,
      realized_pnl_minor: row.realized_pnl_minor,
      capital_minor: row.capital_minor,
      equity_after_minor: row.equity_after_minor
    }))
  })).digest('hex');
  return {
    schema_version: 2,
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

  return {
    ...buildRecordedEvidence({
      sourceType: 'INTERNAL_RECONCILIATION',
      reference: reconciliationBatchId,
      observedAt,
      trades: canonical,
      provenance: {
        reconciliation_batch_id: reconciliationBatchId,
        source_hash: provenance.source_hash
      }
    }),
    verification_status: 'PENDING_REVIEW',
    verified: false,
    published: false
  };
}
