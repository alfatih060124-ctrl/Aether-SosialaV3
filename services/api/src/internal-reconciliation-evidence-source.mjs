import crypto from 'node:crypto';
import { buildRecordedEvidence, pendingData } from './trader-evidence-collector.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function text(value, name, min = 1, max = 160) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
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

function solanaBase58(value, name, min, max, expectedBytes) {
  const s = text(value, name, min, max);
  if (!BASE58.test(s) || decodedBase58ByteLength(s) !== expectedBytes) throw new Error(`invalid_${name}`);
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
      source_signature: solanaBase58(row.source_signature, `trade_${i}_source_signature`, 32, 100, 64)
    }))
    .sort((a, b) => a.executed_at.localeCompare(b.executed_at) || a.trade_id.localeCompare(b.trade_id));
}

export function buildInternalReconciliationProvenance({ walletAddress, reconciliationBatchId, trades }) {
  const wallet = solanaBase58(walletAddress, 'wallet_address', 32, 44, 32);
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
