import crypto from 'node:crypto';
import { buildFifoAccountingCandidates } from '../../../packages/reconciliation-accounting/fifo.mjs';
import { coordinateReconciliationSources } from '../../../packages/reconciliation-accounting/coordinator.mjs';

const MAX_ACCOUNTING_EVENTS = 10_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function text(value, name, min = 1, max = 300) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) throw new Error(`invalid_${name}`);
  return s;
}

function safeInt(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}

function hashText(value, name) {
  const h = text(value, name, 64, 64).toLowerCase();
  if (!HASH_RE.test(h)) throw new Error(`invalid_${name}`);
  return h;
}

function solanaAddress(value, name) {
  const address = text(value, name, 32, 44);
  if (!SOLANA_ADDRESS_RE.test(address)) throw new Error(`invalid_${name}`);
  return address;
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
  const signature = text(value, 'source_signature', 64, 100);
  if (decodedBase58ByteLength(signature) !== 64) throw new Error('invalid_source_signature');
  return signature;
}

function boundary(extra = {}) {
  return {
    reconciliation_ready: false,
    evidence_ready: false,
    verification_authorized: false,
    publication_authorized: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    ...extra
  };
}

export function normalizeReconciliationQuoteMints(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const out = [...new Set(raw.map(v => String(v).trim()).filter(Boolean))];
  for (const mint of out) solanaAddress(mint, 'reconciliation_quote_mint');
  return out.sort();
}

export function deriveRuntimeAccountingCandidate({ events = [], targetEventId, quoteMints = [] } = {}) {
  const targetId = text(targetEventId, 'trade_event_id', 1, 120);
  if (!Array.isArray(events) || events.length > MAX_ACCOUNTING_EVENTS) throw new Error('invalid_accounting_events');
  const target = events.find(event => String(event?.event_id || '') === targetId);
  if (!target) throw new Error('trade_event_not_found');

  const normalizedQuotes = normalizeReconciliationQuoteMints(quoteMints);
  if (normalizedQuotes.length === 0) {
    return boundary({
      status: 'PENDING_CONFIGURATION',
      missing_sources: ['RECONCILIATION_QUOTE_MINTS'],
      blockers: ['quote_mints_unconfigured'],
      candidate: null
    });
  }

  const accounting = buildFifoAccountingCandidates({ events, quoteMints: normalizedQuotes });
  const candidate = accounting.candidates.find(item => item.event_id === targetId) || null;
  if (candidate) {
    return boundary({
      status: 'ACCOUNTING_CANDIDATE_READY',
      candidate,
      missing_sources: [],
      blockers: []
    });
  }

  const issue = accounting.issues.find(item => item.event_id === targetId);
  if (issue) {
    return boundary({
      status: 'PENDING_ACCOUNTING_HISTORY',
      candidate: null,
      missing_sources: ['FIFO_OPENING_INVENTORY'],
      blockers: [issue.reason]
    });
  }

  const skipped = accounting.skipped.find(item => item.event_id === targetId);
  if (skipped) {
    return boundary({
      status: 'BLOCKED_UNSUPPORTED_ACCOUNTING_PAIR',
      candidate: null,
      missing_sources: [],
      blockers: [skipped.reason]
    });
  }

  const quoteSet = new Set(normalizedQuotes);
  const inQuote = quoteSet.has(String(target.token_in || ''));
  const outQuote = quoteSet.has(String(target.token_out || ''));
  if (inQuote && !outQuote) {
    return boundary({
      status: 'NO_REALIZED_PNL',
      candidate: null,
      missing_sources: [],
      blockers: []
    });
  }

  return boundary({
    status: 'PENDING_ACCOUNTING_CANDIDATE',
    candidate: null,
    missing_sources: ['FIFO_ACCOUNTING_CANDIDATE'],
    blockers: ['candidate_not_derivable']
  });
}

export function buildCoordinatedLedgerRecord({ traderId, walletAddress, event, coordinated } = {}) {
  const trader = text(traderId, 'trader_id', 8, 80);
  const wallet = solanaAddress(walletAddress, 'wallet_address');
  if (!event || typeof event !== 'object') throw new Error('trade_event_not_found');
  if (!coordinated || typeof coordinated !== 'object') throw new Error('coordinated_reconciliation_required');
  if (coordinated.status !== 'RECONCILIATION_READY' || coordinated.reconciliation_ready !== true) {
    throw new Error('coordinated_reconciliation_not_ready');
  }
  if (
    coordinated.evidence_ready !== false || coordinated.verification_authorized !== false ||
    coordinated.publication_authorized !== false || coordinated.verified !== false ||
    coordinated.published !== false || coordinated.live_execution_authorized !== false
  ) throw new Error('coordinated_reconciliation_boundary_violation');

  const ready = coordinated.reconciled_trade;
  if (!ready || ready.status !== 'RECONCILIATION_READY' || ready.reconciliation_ready !== true) {
    throw new Error('coordinated_trade_not_ready');
  }
  if (
    ready.evidence_ready !== false || ready.verification_authorized !== false ||
    ready.publication_authorized !== false || ready.verified !== false ||
    ready.published !== false || ready.live_execution_authorized !== false
  ) throw new Error('coordinated_trade_boundary_violation');

  if (String(event.chain || '').toUpperCase() !== 'SOLANA') throw new Error('reconciliation_non_solana_event');
  if (String(event.trader_wallet || '') !== wallet) throw new Error('reconciliation_wallet_mismatch');
  const eventId = text(event.event_id, 'trade_event_id', 1, 120);
  const signature = solanaSignature(event.tx_hash);
  if (/^shadow[_:-]/i.test(eventId) || /shadow/i.test(String(event.decoder_version || ''))) {
    throw new Error('synthetic_trade_event_blocked');
  }
  const slot = safeInt(event.slot, 'source_slot', 0);
  if (ready.trade_event_id !== eventId || coordinated.trade_event_id !== eventId) throw new Error('coordinated_event_mismatch');
  if (ready.source_signature !== signature || coordinated.source_signature !== signature) throw new Error('coordinated_signature_mismatch');
  if (safeInt(ready.source_slot, 'coordinated_source_slot', 0) !== slot) throw new Error('coordinated_slot_mismatch');

  const finalizationHash = hashText(ready.finalization_hash, 'finalization_hash');
  const accountingHash = hashText(coordinated.candidate_accounting_hash, 'candidate_accounting_hash');
  const realizedPnlMinor = safeInt(ready.realized_pnl_minor, 'realized_pnl_minor');
  const capitalMinor = safeInt(ready.capital_minor, 'capital_minor', 1);
  const equityAfterMinor = safeInt(ready.equity_after_minor, 'equity_after_minor', 1);
  if (ready.accounting_method !== 'FIFO_COST_BASIS_V1') throw new Error('unsupported_accounting_method');
  const valuationReference = text(ready.valuation_reference, 'valuation_reference', 8, 300);
  const executedAt = new Date(ready.executed_at || '');
  if (Number.isNaN(executedAt.getTime())) throw new Error('invalid_executed_at');

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
    accounting_method: ready.accounting_method,
    valuation_reference: valuationReference,
    source_hash: finalizationHash,
    reconciliation_status: 'RECONCILED',
    provenance: {
      schema_version: 2,
      source_type: 'AETHER_COORDINATED_RECONCILIATION',
      candidate_accounting_hash: accountingHash,
      finalization_hash: finalizationHash,
      coordinator_status: coordinated.status,
      fee: ready.provenance?.fee || null,
      valuation: ready.provenance?.valuation || null,
      equity: ready.provenance?.equity || null,
      verified: false,
      published: false,
      live_execution_authorized: false
    }
  };
}

function project(row) {
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
    live_execution_authorized: false,
    created_at: row.created_at
  } : null;
}

export function createReconciliationRuntimeService(pool, { quoteMints = [] } = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const configuredQuoteMints = normalizeReconciliationQuoteMints(quoteMints);

  return {
    configuredQuoteMints: [...configuredQuoteMints],

    async coordinateAndRecord(traderId, input = {}) {
      const targetEventId = text(input.trade_event_id, 'trade_event_id', 1, 120);
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const trader = (await client.query(
          `SELECT trader_id,wallet_address,onboarding_status,mode,owner_user_id
           FROM traders WHERE trader_id=$1 FOR UPDATE`,
          [traderId]
        )).rows[0];
        if (!trader || !trader.owner_user_id) throw new Error('trader_application_not_found');
        if (trader.onboarding_status !== 'APPROVED') throw new Error('trader_verification_invalid_state');
        if (trader.mode !== 'SHADOW') throw new Error('trader_not_shadow');

        const target = (await client.query('SELECT * FROM trade_events WHERE event_id=$1', [targetEventId])).rows[0];
        if (!target) throw new Error('trade_event_not_found');
        if (String(target.trader_wallet || '') !== String(trader.wallet_address || '')) throw new Error('reconciliation_wallet_mismatch');
        if (String(target.chain || '').toUpperCase() !== 'SOLANA') throw new Error('reconciliation_non_solana_event');

        const events = (await client.query(
          `SELECT * FROM trade_events
           WHERE trader_wallet=$1 AND LOWER(chain)='solana'
             AND (slot < $2 OR (slot=$2 AND (observed_at < $3 OR (observed_at=$3 AND event_id <= $4))))
           ORDER BY slot ASC, observed_at ASC, event_id ASC
           LIMIT $5`,
          [trader.wallet_address, target.slot, target.observed_at, target.event_id, MAX_ACCOUNTING_EVENTS + 1]
        )).rows;

        if (events.length > MAX_ACCOUNTING_EVENTS) {
          await client.query('ROLLBACK');
          return boundary({
            status: 'PENDING_ACCOUNTING_HISTORY',
            missing_sources: ['BOUNDED_FIFO_HISTORY'],
            blockers: ['accounting_history_limit_exceeded'],
            ledger_recorded: false
          });
        }

        const derived = deriveRuntimeAccountingCandidate({
          events,
          targetEventId,
          quoteMints: configuredQuoteMints
        });
        if (!derived.candidate) {
          await client.query('ROLLBACK');
          return { ...derived, ledger_recorded: false };
        }

        const coordinated = coordinateReconciliationSources({
          candidate: derived.candidate,
          networkFeeSnapshot: input.network_fee_snapshot || null,
          explicitFees: Array.isArray(input.explicit_fees) ? input.explicit_fees : [],
          explicitFeeScan: input.explicit_fee_scan || null,
          balanceInventory: input.balance_inventory || null,
          assetValuations: Array.isArray(input.asset_valuations) ? input.asset_valuations : [],
          tradeValuationSnapshot: input.trade_valuation_snapshot || null
        });

        if (coordinated.status !== 'RECONCILIATION_READY') {
          await client.query('ROLLBACK');
          return { ...coordinated, ledger_recorded: false };
        }

        const record = buildCoordinatedLedgerRecord({
          traderId: trader.trader_id,
          walletAddress: trader.wallet_address,
          event: target,
          coordinated
        });
        const existing = (await client.query(
          'SELECT * FROM trader_reconciled_trades WHERE trader_id=$1 AND trade_event_id=$2',
          [trader.trader_id, record.trade_event_id]
        )).rows[0];
        if (existing) {
          if (existing.source_hash !== record.source_hash) throw new Error('reconciliation_conflict');
          await client.query('COMMIT');
          return {
            status: 'RECONCILIATION_RECORDED',
            ledger_recorded: true,
            reused: true,
            record: project(existing),
            evidence_ready: false,
            verification_authorized: false,
            publication_authorized: false,
            verified: false,
            published: false,
            live_execution_authorized: false
          };
        }

        const stored = (await client.query(
          `INSERT INTO trader_reconciled_trades(
             reconciliation_trade_id,trader_id,trade_event_id,source_signature,source_slot,executed_at,
             realized_pnl_minor,capital_minor,equity_after_minor,accounting_method,valuation_reference,
             source_hash,reconciliation_status,provenance
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RECONCILED',$13::jsonb)
           RETURNING *`,
          [record.reconciliation_trade_id,record.trader_id,record.trade_event_id,record.source_signature,
           record.source_slot,record.executed_at,record.realized_pnl_minor,record.capital_minor,
           record.equity_after_minor,record.accounting_method,record.valuation_reference,record.source_hash,
           JSON.stringify(record.provenance)]
        )).rows[0];
        await client.query('COMMIT');
        return {
          status: 'RECONCILIATION_RECORDED',
          ledger_recorded: true,
          reused: false,
          record: project(stored),
          evidence_ready: false,
          verification_authorized: false,
          publication_authorized: false,
          verified: false,
          published: false,
          live_execution_authorized: false
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
