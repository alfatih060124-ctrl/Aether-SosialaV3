import { buildAdditionalFeeSnapshot } from './additional-fees.mjs';
import { buildWalletEquitySnapshot } from './wallet-equity.mjs';
import { promoteAccountingCandidate, verifyAccountingCandidate } from './promoter.mjs';

const PENDING_ERROR_CODES = new Set([
  'network_fee_snapshot_required',
  'explicit_fee_scan_required',
  'explicit_fee_scan_incomplete',
  'explicit_fee_scan_coverage_incomplete',
  'balance_inventory_required',
  'balance_inventory_incomplete',
  'trade_valuation_snapshot_required'
]);

function safeErrorCode(error) {
  const code = String(error?.message || 'unknown_source_error').trim();
  return /^[a-z0-9_:-]{1,160}$/i.test(code) ? code : 'invalid_source_error';
}

function isPendingSourceError(code) {
  return PENDING_ERROR_CODES.has(code) || code.startsWith('valuation_required_');
}

function baseBoundary(candidate, checked) {
  return {
    schema_version: 1,
    trade_event_id: candidate.event_id,
    source_signature: candidate.source_signature,
    source_slot: checked.sourceSlot,
    candidate_accounting_hash: checked.accountingHash,
    evidence_ready: false,
    verification_authorized: false,
    publication_authorized: false,
    verified: false,
    published: false,
    live_execution_authorized: false
  };
}

function pending(candidate, checked, missingSources, blockers = []) {
  return {
    ...baseBoundary(candidate, checked),
    status: 'PENDING_SOURCE_COMPLETENESS',
    source_completeness: 'INCOMPLETE',
    missing_sources: [...new Set(missingSources)].sort(),
    blockers: [...new Set(blockers)].sort(),
    reconciliation_ready: false
  };
}

function blocked(candidate, checked, code) {
  return {
    ...baseBoundary(candidate, checked),
    status: 'BLOCKED_INVALID_SOURCE',
    source_completeness: 'INVALID',
    missing_sources: [],
    blockers: [code],
    reconciliation_ready: false
  };
}

/**
 * Coordinate already-collected accounting sources into a reconciliation-ready trade.
 *
 * This module deliberately does not collect chain data, invent fees, infer wallet equity,
 * write to the database, verify trader performance, publish a trader, or dispatch execution.
 * It only composes upstream auditable snapshots and fails closed when any source is missing,
 * incomplete, mismatched, or malformed.
 */
export function coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot = null,
  explicitFees = [],
  explicitFeeScan = null,
  balanceInventory = null,
  assetValuations = [],
  tradeValuationSnapshot = null
} = {}) {
  // Candidate integrity is a hard prerequisite. A tampered accounting candidate is not
  // a recoverable "pending source" condition and must fail immediately.
  const checked = verifyAccountingCandidate(candidate);

  const missingSources = [];
  if (!networkFeeSnapshot) missingSources.push('SOLANA_NETWORK_FEE_USD');
  if (!explicitFeeScan) missingSources.push('EXPLICIT_FEE_SCAN');
  if (!balanceInventory) missingSources.push('FULL_WALLET_BALANCE_INVENTORY');
  if (!tradeValuationSnapshot) missingSources.push('TRADE_USD_VALUATION');
  if (missingSources.length) return pending(candidate, checked, missingSources);

  let feeSnapshot;
  try {
    feeSnapshot = buildAdditionalFeeSnapshot({
      networkFeeSnapshot,
      explicitFees,
      scanEvidence: explicitFeeScan
    });
  } catch (error) {
    const code = safeErrorCode(error);
    if (isPendingSourceError(code)) {
      return pending(candidate, checked, ['ADDITIONAL_NON_EMBEDDED_FEES'], [code]);
    }
    return blocked(candidate, checked, code);
  }

  let equitySnapshot;
  try {
    equitySnapshot = buildWalletEquitySnapshot({
      balanceInventory,
      valuations: assetValuations
    });
  } catch (error) {
    const code = safeErrorCode(error);
    if (isPendingSourceError(code)) {
      return pending(candidate, checked, ['FULL_WALLET_EQUITY'], [code]);
    }
    return blocked(candidate, checked, code);
  }

  let reconciledTrade;
  try {
    reconciledTrade = promoteAccountingCandidate({
      candidate,
      feeSnapshot,
      valuationSnapshot: tradeValuationSnapshot,
      equitySnapshot
    });
  } catch (error) {
    return blocked(candidate, checked, safeErrorCode(error));
  }

  if (
    reconciledTrade.reconciliation_ready !== true ||
    reconciledTrade.evidence_ready !== false ||
    reconciledTrade.verified !== false ||
    reconciledTrade.published !== false ||
    reconciledTrade.live_execution_authorized !== false
  ) {
    throw new Error('reconciliation_coordinator_boundary_violation');
  }

  return {
    ...baseBoundary(candidate, checked),
    status: 'RECONCILIATION_READY',
    source_completeness: 'COMPLETE',
    missing_sources: [],
    blockers: [],
    reconciliation_ready: true,
    fee_snapshot: feeSnapshot,
    equity_snapshot: equitySnapshot,
    reconciled_trade: reconciledTrade
  };
}
