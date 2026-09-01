import crypto from 'node:crypto';
import { collectInternalReconciliationEvidence } from './internal-reconciliation-evidence-source.mjs';
import { createReconciliationRuntimeService } from './reconciliation-runtime-service.mjs';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ACCOUNTING_METHODS = new Set(['FIFO_COST_BASIS_V1','WEIGHTED_AVERAGE_COST_BASIS_V1']);
const MAX_BATCH_ROWS = 100;
const MAX_EVIDENCE_ROWS = 5000;
const MAX_MINOR_ABS = 1_000_000_000_000;
export const MIN_REPUTATION_TRADES = 20;

function text(value, name, min = 1, max = 300) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  if(/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`invalid_${name}`);
  return s;
}

function boundedInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
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

function solanaSignature(value) {
  const signature = text(value, 'source_signature', 32, 100);
  if (decodedBase58ByteLength(signature) !== 64) throw new Error('invalid_source_signature');
  return signature;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function calculateDeterministicReputation(metrics = {}) {
  const tradesCount = boundedInt(metrics.trades_count, 'reputation_trades_count', 1, MAX_EVIDENCE_ROWS);
  const totalReturnBps = boundedInt(metrics.total_return_bps, 'reputation_total_return_bps', -10_000_000, 10_000_000);
  const winRateBps = boundedInt(metrics.win_rate_bps, 'reputation_win_rate_bps', 0, 10_000);
  const drawdownBps = boundedInt(metrics.drawdown_bps, 'reputation_drawdown_bps', 0, 10_000);
  if (tradesCount < MIN_REPUTATION_TRADES) {
    return {
      available: false,
      reason: 'insufficient_reconciled_trade_sample',
      minimum_trades: MIN_REPUTATION_TRADES,
      trades_count: tradesCount,
      formula_version: 'AETHER_REPUTATION_V1'
    };
  }

  // Transparent platform score, not a promise of future performance.
  // +/-100% aggregate return maps to 0..100, risk rewards lower drawdown,
  // win-rate contributes consistency, and samples below 100 trades shrink toward 50.
  const returnScore = clamp(50 + totalReturnBps / 200, 0, 100);
  const drawdownScore = clamp(100 - drawdownBps / 100, 0, 100);
  const winScore = clamp(winRateBps / 100, 0, 100);
  const baseScore = (0.40 * returnScore) + (0.35 * drawdownScore) + (0.25 * winScore);
  const sampleConfidence = Math.min(1, tradesCount / 100);
  const score = 50 + ((baseScore - 50) * sampleConfidence);

  return {
    available: true,
    score: Number(score.toFixed(4)),
    formula_version: 'AETHER_REPUTATION_V1',
    sample_confidence: Number(sampleConfidence.toFixed(4)),
    components: {
      return_score: Number(returnScore.toFixed(4)),
      drawdown_score: Number(drawdownScore.toFixed(4)),
      win_score: Number(winScore.toFixed(4))
    },
    weights: { return: 0.40, drawdown: 0.35, win_rate: 0.25 }
  };
}

// Legacy pure validator retained for historical regression coverage only. Runtime ledger
// ingestion no longer accepts these caller-supplied metrics; recordTrades delegates to the
// coordinated FIFO/fee/valuation/equity path below.
export function buildReconciledLedgerRecord({ traderId, walletAddress, event, input = {} } = {}) {
  const trader = text(traderId, 'trader_id', 8, 80);
  const wallet = text(walletAddress, 'wallet_address', 32, 44);
  if (!event || typeof event !== 'object') throw new Error('trade_event_not_found');
  if (String(event.chain || '').toUpperCase() !== 'SOLANA') throw new Error('reconciliation_non_solana_event');
  if (String(event.trader_wallet || '') !== wallet) throw new Error('reconciliation_wallet_mismatch');
  const eventId = text(event.event_id, 'trade_event_id', 1, 120);
  const signature = solanaSignature(event.tx_hash);
  if (/^shadow[_:-]/i.test(eventId) || /^shadow[_:-]/i.test(String(event.tx_hash || '')) || /shadow/i.test(String(event.decoder_version || ''))) {
    throw new Error('synthetic_trade_event_blocked');
  }
  const confidence = Number(event.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.90 || confidence > 1) throw new Error('reconciliation_event_confidence_too_low');
  const slot = boundedInt(event.slot, 'source_slot', 0, Number.MAX_SAFE_INTEGER);
  const executedAt = new Date(event.observed_at || '');
  if (Number.isNaN(executedAt.getTime()) || executedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('invalid_executed_at');

  const realizedPnlMinor = boundedInt(input.realized_pnl_minor, 'realized_pnl_minor', -MAX_MINOR_ABS, MAX_MINOR_ABS);
  const capitalMinor = boundedInt(input.capital_minor, 'capital_minor', 1, MAX_MINOR_ABS);
  const equityAfterMinor = boundedInt(input.equity_after_minor, 'equity_after_minor', 1, MAX_MINOR_ABS);
  const accountingMethod = String(input.accounting_method || '').trim().toUpperCase();
  if (!ACCOUNTING_METHODS.has(accountingMethod)) throw new Error('invalid_accounting_method');
  const valuationReference = text(input.valuation_reference, 'valuation_reference', 8, 300);

  const provenance = {
    schema_version: 1,
    source_type: 'SOLANA_TRADE_EVENT',
    trader_id: trader,
    wallet_address: wallet,
    trade_event_id: eventId,
    source_signature: signature,
    source_slot: slot,
    decoder_version: text(event.decoder_version, 'decoder_version', 1, 120),
    decoder_confidence: Number(confidence.toFixed(4)),
    accounting_method: accountingMethod,
    valuation_reference: valuationReference
  };
  const sourceHash = canonicalHash({
    v: 1,
    provenance,
    realized_pnl_minor: realizedPnlMinor,
    capital_minor: capitalMinor,
    equity_after_minor: equityAfterMinor,
    executed_at: executedAt.toISOString()
  });

  return {
    reconciliation_trade_id: crypto.randomUUID(),
    trader_id: trader,
    trade_event_id: eventId,
    source_signature: signature,
    source_slot: slot,
    executed_at: executedAt.toISOString(),
    realized_pnl_minor: realizedPnlMinor,
    capital_minor: capitalMinor,
    equity_after_minor: equityAfterMinor,
    accounting_method: accountingMethod,
    valuation_reference: valuationReference,
    source_hash: sourceHash,
    reconciliation_status: 'RECONCILED',
    provenance
  };
}

function tradeProjection(row) {
  return row ? {
    reconciliation_trade_id: row.reconciliation_trade_id,
    trader_id: row.trader_id,
    trade_event_id: row.trade_event_id,
    source_signature: row.source_signature,
    source_slot: Number(row.source_slot),
    executed_at: row.executed_at,
    realized_pnl_minor: Number(row.realized_pnl_minor),
    capital_minor: Number(row.capital_minor),
    equity_after_minor: Number(row.equity_after_minor),
    accounting_method: row.accounting_method,
    valuation_reference: row.valuation_reference,
    source_hash: row.source_hash,
    reconciliation_status: row.reconciliation_status,
    provenance: row.provenance || {},
    created_at: row.created_at,
    live_execution_authorized: false
  } : null;
}

function collectionProjection(row) {
  return row ? {
    collection_id: row.collection_id,
    trader_id: row.trader_id,
    source_type: row.source_type,
    source_reference: row.source_reference,
    observed_at: row.observed_at,
    collection_status: row.collection_status,
    reason: row.reason,
    provenance: row.provenance || {},
    metrics_available: row.metrics_available === true,
    trades_count: row.trades_count === null ? null : Number(row.trades_count),
    total_return_bps: row.total_return_bps === null ? null : Number(row.total_return_bps),
    win_rate_bps: row.win_rate_bps === null ? null : Number(row.win_rate_bps),
    drawdown_bps: row.drawdown_bps === null ? null : Number(row.drawdown_bps),
    reputation_score: row.reputation_score === null ? null : Number(row.reputation_score),
    calculation_hash: row.calculation_hash,
    verified: false,
    published: false,
    live_execution_authorized: false,
    created_at: row.created_at
  } : null;
}

export function createReconciledPerformanceService(pool) {
  if (!pool) throw new Error('database_unconfigured');
  const reconciliationRuntime = createReconciliationRuntimeService(pool, {
    quoteMints: process.env.RECONCILIATION_QUOTE_MINTS || ''
  });

  async function loadApprovedTrader(traderId, client = pool) {
    const trader = (await client.query(
      `SELECT trader_id,wallet_address,onboarding_status,verification_status,published,verified,mode,status
       FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`,
      [traderId]
    )).rows[0];
    if (!trader) throw new Error('trader_application_not_found');
    if (trader.onboarding_status !== 'APPROVED') throw new Error('trader_verification_invalid_state');
    if (trader.mode !== 'SHADOW') throw new Error('trader_not_shadow');
    return trader;
  }

  return {
    async recordTrades(traderId, input = {}) {
      const rows = input.rows;
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('reconciliation_coordinated_single_trade_required');
      const item = rows[0] || {};
      for (const forbidden of ['realized_pnl_minor','capital_minor','equity_after_minor','accounting_method','valuation_reference']) {
        if (Object.prototype.hasOwnProperty.call(item, forbidden)) throw new Error('reconciliation_manual_metrics_blocked');
      }
      const result = await reconciliationRuntime.coordinateAndRecord(traderId, item);
      if (!result.ledger_recorded) {
        const status = String(result.status || 'PENDING').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        const blocker = String(result.blockers?.[0] || result.missing_sources?.[0] || 'source_completeness_required')
          .toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        throw new Error(`reconciliation_sources_incomplete:${status}:${blocker}`);
      }
      return [result.record];
    },

    async listTrades(traderId, limit = 100) {
      await loadApprovedTrader(traderId);
      const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const rows = (await pool.query(
        `SELECT * FROM trader_reconciled_trades WHERE trader_id=$1
         ORDER BY executed_at DESC, trade_event_id DESC LIMIT $2`,
        [traderId,n]
      )).rows;
      return rows.map(tradeProjection);
    },

    async buildPerformanceEvidence(traderId) {
      const trader = await loadApprovedTrader(traderId);
      const ledgerRows = (await pool.query(
        `SELECT * FROM trader_reconciled_trades WHERE trader_id=$1 AND reconciliation_status='RECONCILED'
         ORDER BY executed_at ASC, trade_event_id ASC LIMIT $2`,
        [traderId,MAX_EVIDENCE_ROWS]
      )).rows;

      const ledgerSnapshotHash = canonicalHash({
        v: 1,
        trader_id: trader.trader_id,
        rows: ledgerRows.map(row => ({ trade_event_id: row.trade_event_id, source_hash: row.source_hash }))
      });
      const existingCollection = (await pool.query(
        `SELECT * FROM trader_evidence_collection_runs
         WHERE trader_id=$1 AND source_type='INTERNAL_RECONCILIATION'
           AND provenance->>'ledger_snapshot_hash'=$2
         ORDER BY created_at DESC LIMIT 1`,
        [trader.trader_id,ledgerSnapshotHash]
      )).rows[0];
      if (existingCollection) return {
        collection: collectionProjection(existingCollection),
        evidence: existingCollection.collection_status === 'RECORDED'
          ? (await pool.query('SELECT * FROM trader_verification_evidence WHERE collection_id=$1', [existingCollection.collection_id])).rows[0] || null
          : null,
        reused: true,
        verification_authorized: false,
        publication_authorized: false,
        live_execution_authorized: false
      };

      const collectionId = crypto.randomUUID();
      const batchReference = `recon-${ledgerSnapshotHash.slice(0,48)}`;
      const observedAt = new Date().toISOString();
      const trades = ledgerRows.map(row => ({
        trade_id: row.trade_event_id,
        executed_at: row.executed_at,
        realized_pnl_minor: Number(row.realized_pnl_minor),
        capital_minor: Number(row.capital_minor),
        equity_after_minor: Number(row.equity_after_minor),
        source_signature: row.source_signature,
        reconciliation_status: row.reconciliation_status
      }));

      if (trades.length === 0) {
        const collection = (await pool.query(
          `INSERT INTO trader_evidence_collection_runs(
             collection_id,trader_id,source_type,source_reference,observed_at,collection_status,reason,
             provenance,metrics_available,verified,published,live_execution_authorized
           ) VALUES($1,$2,'INTERNAL_RECONCILIATION',NULL,$3,'PENDING_DATA','no_reconciled_trades',$4::jsonb,false,false,false,false)
           RETURNING *`,
          [collectionId,trader.trader_id,observedAt,JSON.stringify({schema_version:1,ledger_snapshot_hash:ledgerSnapshotHash,reconciled_trades:0})]
        )).rows[0];
        return { collection: collectionProjection(collection), evidence: null, reused: false, verification_authorized:false, publication_authorized:false, live_execution_authorized:false };
      }

      const calculated = collectInternalReconciliationEvidence({
        walletAddress: trader.wallet_address,
        reconciliationBatchId: batchReference,
        observedAt,
        trades
      });
      const reputation = calculateDeterministicReputation(calculated);
      const provenance = {
        ...(calculated.provenance || {}),
        schema_version: 3,
        ledger_snapshot_hash: ledgerSnapshotHash,
        reconciled_trades: trades.length,
        reputation
      };
      const calculationHash = calculated.provenance?.calculation_hash || null;

      if (!reputation.available) {
        const collection = (await pool.query(
          `INSERT INTO trader_evidence_collection_runs(
             collection_id,trader_id,source_type,source_reference,observed_at,collection_status,reason,provenance,
             metrics_available,trades_count,total_return_bps,win_rate_bps,drawdown_bps,reputation_score,calculation_hash,
             verified,published,live_execution_authorized
           ) VALUES($1,$2,'INTERNAL_RECONCILIATION',$3,$4,'PENDING_DATA',$5,$6::jsonb,true,$7,$8,$9,$10,NULL,$11,false,false,false)
           RETURNING *`,
          [collectionId,trader.trader_id,batchReference,observedAt,reputation.reason,JSON.stringify(provenance),
           calculated.trades_count,calculated.total_return_bps,calculated.win_rate_bps,calculated.drawdown_bps,calculationHash]
        )).rows[0];
        return { collection: collectionProjection(collection), evidence: null, reused:false, verification_authorized:false, publication_authorized:false, live_execution_authorized:false };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const collection = (await client.query(
          `INSERT INTO trader_evidence_collection_runs(
             collection_id,trader_id,source_type,source_reference,observed_at,collection_status,reason,provenance,
             metrics_available,trades_count,total_return_bps,win_rate_bps,drawdown_bps,reputation_score,calculation_hash,
             verified,published,live_execution_authorized
           ) VALUES($1,$2,'INTERNAL_RECONCILIATION',$3,$4,'RECORDED','awaiting_explicit_admin_verification',$5::jsonb,true,$6,$7,$8,$9,$10,$11,false,false,false)
           RETURNING *`,
          [collectionId,trader.trader_id,batchReference,observedAt,JSON.stringify(provenance),calculated.trades_count,
           calculated.total_return_bps,calculated.win_rate_bps,calculated.drawdown_bps,reputation.score,calculationHash]
        )).rows[0];
        const evidenceId = crypto.randomUUID();
        const evidence = (await client.query(
          `INSERT INTO trader_verification_evidence(
             evidence_id,trader_id,source_type,source_reference,observed_at,trades_count,total_return_bps,
             win_rate_bps,drawdown_bps,reputation_score,evidence_status,review_note,evidence_origin,collection_id,provenance
           ) VALUES($1,$2,'INTERNAL_RECONCILIATION',$3,$4,$5,$6,$7,$8,$9,'RECORDED','',
                    'AUTOMATIC_RECONCILIATION',$10,$11::jsonb)
           RETURNING *`,
          [evidenceId,trader.trader_id,batchReference,observedAt,calculated.trades_count,calculated.total_return_bps,
           calculated.win_rate_bps,calculated.drawdown_bps,reputation.score,collectionId,JSON.stringify(provenance)]
        )).rows[0];
        await client.query('COMMIT');
        return {
          collection: collectionProjection(collection),
          evidence,
          reused:false,
          verification_authorized:false,
          publication_authorized:false,
          live_execution_authorized:false
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
