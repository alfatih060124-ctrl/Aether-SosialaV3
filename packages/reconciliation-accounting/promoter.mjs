import crypto from 'node:crypto';
import { INVENTORY_SCOPE } from './fifo.mjs';

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TIME_DRIFT_MS = 5 * 60 * 1000;

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

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashText(value, name) {
  const h = text(value, name, 64, 64).toLowerCase();
  if (!HASH_RE.test(h)) throw new Error(`invalid_${name}`);
  return h;
}

function time(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_${name}`);
  return { ms, iso: new Date(ms).toISOString() };
}

function candidateHashPayload(candidate) {
  return {
    schema_version: 1,
    accounting_method: candidate.accounting_method,
    inventory_scope: candidate.inventory_scope,
    event_id: candidate.event_id,
    source_signature: candidate.source_signature,
    source_slot: candidate.source_slot,
    base_mint: candidate.base_mint,
    quote_mint: candidate.quote_mint,
    quantity_raw: candidate.quantity_raw,
    proceeds_minor: candidate.proceeds_minor,
    cost_basis_minor: candidate.cost_basis_minor,
    gross_realized_pnl_minor: candidate.gross_realized_pnl_minor,
    source_lots: candidate.source_lots
  };
}

export function verifyAccountingCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('invalid_accounting_candidate');
  if (candidate.status !== 'PENDING_FEES_AND_EQUITY') throw new Error('accounting_candidate_invalid_state');
  if (candidate.accounting_method !== 'FIFO_COST_BASIS_V1') throw new Error('unsupported_accounting_method');
  if (candidate.inventory_scope !== INVENTORY_SCOPE) throw new Error('accounting_inventory_scope_mismatch');
  if (candidate.reconciliation_ready !== false || candidate.evidence_ready !== false) throw new Error('accounting_candidate_boundary_violation');
  if (candidate.verified !== false || candidate.published !== false || candidate.live_execution_authorized !== false) throw new Error('accounting_candidate_boundary_violation');
  const sourceSlot = safeInt(candidate.source_slot, 'candidate_source_slot', 0);
  const proceeds = safeInt(candidate.proceeds_minor, 'candidate_proceeds_minor', 1);
  const costBasis = safeInt(candidate.cost_basis_minor, 'candidate_cost_basis_minor', 1);
  const gross = safeInt(candidate.gross_realized_pnl_minor, 'candidate_gross_realized_pnl_minor');
  if (gross !== proceeds - costBasis) throw new Error('accounting_candidate_pnl_mismatch');
  text(candidate.event_id, 'candidate_event_id');
  text(candidate.source_signature, 'candidate_source_signature');
  text(candidate.base_mint, 'candidate_base_mint');
  text(candidate.quote_mint, 'candidate_quote_mint');
  text(candidate.quantity_raw, 'candidate_quantity_raw');
  if (!/^\d+$/.test(String(candidate.quantity_raw)) || BigInt(candidate.quantity_raw) <= 0n) throw new Error('invalid_candidate_quantity_raw');
  if (!Array.isArray(candidate.source_lots) || candidate.source_lots.length < 1) throw new Error('invalid_candidate_source_lots');
  const expectedHash = hash(candidateHashPayload(candidate));
  if (hashText(candidate.accounting_hash, 'accounting_hash') !== expectedHash) throw new Error('accounting_hash_mismatch');
  const observed = time(candidate.observed_at, 'candidate_observed_at');
  return { sourceSlot, proceeds, costBasis, gross, observedAt: observed.iso, observedMs: observed.ms, accountingHash: expectedHash };
}

function sourceSnapshot(snapshot, name, candidate, expectedType) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${name}_snapshot_required`);
  if (snapshot.source_type !== expectedType) throw new Error(`${name}_source_type_invalid`);
  const sourceReference = text(snapshot.source_reference, `${name}_source_reference`, 8, 300);
  const sourceHash = hashText(snapshot.source_hash, `${name}_source_hash`);
  const sourceSlot = safeInt(snapshot.source_slot, `${name}_source_slot`, 0);
  if (sourceSlot !== candidate.sourceSlot) throw new Error(`${name}_slot_mismatch`);
  const observed = time(snapshot.observed_at, `${name}_observed_at`);
  if (Math.abs(observed.ms - candidate.observedMs) > MAX_TIME_DRIFT_MS) throw new Error(`${name}_time_mismatch`);
  return { sourceReference, sourceHash, sourceSlot, observedAt: observed.iso };
}

export function promoteAccountingCandidate({ candidate, feeSnapshot, valuationSnapshot, equitySnapshot } = {}) {
  const checked = verifyAccountingCandidate(candidate);

  const feeSource = sourceSnapshot(feeSnapshot, 'fee', checked, 'ADDITIONAL_NON_EMBEDDED_FEES_V1');
  const valuationSource = sourceSnapshot(valuationSnapshot, 'valuation', checked, 'TRADE_USD_VALUATION_V1');
  const equitySource = sourceSnapshot(equitySnapshot, 'equity', checked, 'WALLET_EQUITY_SNAPSHOT_V1');

  const additionalFeeMinor = safeInt(feeSnapshot.additional_fee_minor, 'additional_fee_minor', 0);
  const networkFeeMinor = safeInt(feeSnapshot.network_fee_minor ?? 0, 'network_fee_minor', 0);
  const platformFeeMinor = safeInt(feeSnapshot.platform_execution_fee_minor ?? 0, 'platform_execution_fee_minor', 0);
  const otherFeeMinor = safeInt(feeSnapshot.other_explicit_fee_minor ?? 0, 'other_explicit_fee_minor', 0);
  if (additionalFeeMinor !== networkFeeMinor + platformFeeMinor + otherFeeMinor) throw new Error('fee_breakdown_mismatch');
  if (feeSnapshot.embedded_swap_fee_handling !== 'ALREADY_REFLECTED_IN_EXECUTION_VALUE') throw new Error('embedded_swap_fee_handling_required');

  const valuationProceeds = safeInt(valuationSnapshot.proceeds_minor, 'valuation_proceeds_minor', 1);
  const valuationCost = safeInt(valuationSnapshot.cost_basis_minor, 'valuation_cost_basis_minor', 1);
  if (valuationProceeds !== checked.proceeds || valuationCost !== checked.costBasis) throw new Error('valuation_candidate_mismatch');
  if (valuationSnapshot.currency !== 'USD_MICRO') throw new Error('valuation_currency_invalid');

  const equityAfterMinor = safeInt(equitySnapshot.equity_after_minor, 'equity_after_minor', 1);
  if (equitySnapshot.currency !== 'USD_MICRO') throw new Error('equity_currency_invalid');
  if (equitySnapshot.balance_scope !== 'FULL_TRADER_WALLET_MARK_TO_MARKET') throw new Error('equity_balance_scope_invalid');

  const realizedPnlMinor = checked.gross - additionalFeeMinor;
  const capitalMinor = checked.costBasis;
  const provenance = {
    schema_version: 1,
    accounting_hash: checked.accountingHash,
    inventory_scope: INVENTORY_SCOPE,
    fee: {
      source_type: feeSnapshot.source_type,
      source_reference: feeSource.sourceReference,
      source_hash: feeSource.sourceHash,
      source_slot: feeSource.sourceSlot,
      observed_at: feeSource.observedAt,
      additional_fee_minor: additionalFeeMinor,
      network_fee_minor: networkFeeMinor,
      platform_execution_fee_minor: platformFeeMinor,
      other_explicit_fee_minor: otherFeeMinor,
      embedded_swap_fee_handling: feeSnapshot.embedded_swap_fee_handling
    },
    valuation: {
      source_type: valuationSnapshot.source_type,
      source_reference: valuationSource.sourceReference,
      source_hash: valuationSource.sourceHash,
      source_slot: valuationSource.sourceSlot,
      observed_at: valuationSource.observedAt,
      currency: valuationSnapshot.currency
    },
    equity: {
      source_type: equitySnapshot.source_type,
      source_reference: equitySource.sourceReference,
      source_hash: equitySource.sourceHash,
      source_slot: equitySource.sourceSlot,
      observed_at: equitySource.observedAt,
      currency: equitySnapshot.currency,
      balance_scope: equitySnapshot.balance_scope
    }
  };
  const finalizationHash = hash({
    v: 1,
    event_id: candidate.event_id,
    source_signature: candidate.source_signature,
    source_slot: checked.sourceSlot,
    accounting_hash: checked.accountingHash,
    fee_source_hash: feeSource.sourceHash,
    valuation_source_hash: valuationSource.sourceHash,
    equity_source_hash: equitySource.sourceHash,
    realized_pnl_minor: realizedPnlMinor,
    capital_minor: capitalMinor,
    equity_after_minor: equityAfterMinor
  });

  return {
    schema_version: 1,
    status: 'RECONCILIATION_READY',
    trade_event_id: candidate.event_id,
    source_signature: candidate.source_signature,
    source_slot: checked.sourceSlot,
    executed_at: checked.observedAt,
    realized_pnl_minor: realizedPnlMinor,
    capital_minor: capitalMinor,
    equity_after_minor: equityAfterMinor,
    accounting_method: candidate.accounting_method,
    valuation_reference: valuationSource.sourceReference,
    finalization_hash: finalizationHash,
    provenance,
    reconciliation_ready: true,
    evidence_ready: false,
    verification_authorized: false,
    publication_authorized: false,
    verified: false,
    published: false,
    live_execution_authorized: false
  };
}
