import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { coordinateReconciliationSources } from '../packages/reconciliation-accounting/coordinator.mjs';
import {
  buildCoordinatedLedgerRecord,
  deriveRuntimeAccountingCandidate,
  normalizeReconciliationQuoteMints
} from '../services/api/src/reconciliation-runtime-service.mjs';
import { createReconciledPerformanceService } from '../services/api/src/reconciled-performance-service.mjs';

// Synthetic/test-only source contracts. Nothing in this file is real trader performance,
// a production wallet balance, a verification decision, publication approval, or LIVE data.
const wallet = '3'.repeat(32);
const quoteMint = '1'.repeat(32);
const baseMint = '2'.repeat(32);
const buySignature = `${'1'.repeat(63)}2`;
const sellSignature = `${'1'.repeat(63)}3`;
const buyObserved = '2026-09-01T00:00:00.000Z';
const sellObserved = '2026-09-01T00:01:00.000Z';

const buy = {
  event_id: 'runtime-buy-001',
  tx_hash: buySignature,
  decoder_version: 'decoder-v1',
  chain: 'SOLANA',
  trader_wallet: wallet,
  token_in: quoteMint,
  token_out: baseMint,
  amount_in_raw: '100000000',
  amount_out_raw: '1000000',
  amount_usd: '100',
  slot: 200,
  confidence: 0.99,
  observed_at: buyObserved
};
const sell = {
  event_id: 'runtime-sell-001',
  tx_hash: sellSignature,
  decoder_version: 'decoder-v1',
  chain: 'SOLANA',
  trader_wallet: wallet,
  token_in: baseMint,
  token_out: quoteMint,
  amount_in_raw: '1000000',
  amount_out_raw: '120000000',
  amount_usd: '120',
  slot: 201,
  confidence: 0.99,
  observed_at: sellObserved
};

assert.deepEqual(normalizeReconciliationQuoteMints(`${quoteMint},${quoteMint}`), [quoteMint]);
assert.throws(() => normalizeReconciliationQuoteMints('not-a-solana-mint'), /invalid_reconciliation_quote_mint/);

const noConfig = deriveRuntimeAccountingCandidate({
  events: [buy, sell], targetEventId: sell.event_id, quoteMints: []
});
assert.equal(noConfig.status, 'PENDING_CONFIGURATION');
assert.equal(noConfig.reconciliation_ready, false);
assert.deepEqual(noConfig.missing_sources, ['RECONCILIATION_QUOTE_MINTS']);
assert.equal(noConfig.verified, false);
assert.equal(noConfig.published, false);
assert.equal(noConfig.live_execution_authorized, false);

const buyOnly = deriveRuntimeAccountingCandidate({
  events: [buy], targetEventId: buy.event_id, quoteMints: [quoteMint]
});
assert.equal(buyOnly.status, 'NO_REALIZED_PNL');
assert.equal(buyOnly.candidate, null);

const missingHistory = deriveRuntimeAccountingCandidate({
  events: [sell], targetEventId: sell.event_id, quoteMints: [quoteMint]
});
assert.equal(missingHistory.status, 'PENDING_ACCOUNTING_HISTORY');
assert.ok(missingHistory.blockers.includes('INSUFFICIENT_FIFO_INVENTORY'));
assert.equal(missingHistory.reconciliation_ready, false);

const derived = deriveRuntimeAccountingCandidate({
  events: [buy, sell], targetEventId: sell.event_id, quoteMints: [quoteMint]
});
assert.equal(derived.status, 'ACCOUNTING_CANDIDATE_READY');
assert.ok(derived.candidate);
assert.equal(derived.candidate.gross_realized_pnl_minor, 20_000_000);
const candidate = derived.candidate;

const boundary = {
  reconciliation_ready: false,
  evidence_ready: false,
  verified: false,
  published: false,
  live_execution_authorized: false
};
const networkFeeSnapshot = {
  ...boundary,
  source_type: 'SOLANA_NETWORK_FEE_USD_V1',
  source_reference: sellSignature,
  source_hash: 'a'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: sellObserved,
  network_fee_minor: 500,
  currency: 'USD_MICRO',
  status: 'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES',
  complete_additional_fee_set: false,
  promoter_ready: false
};
const explicitFeeScan = {
  ...boundary,
  source_type: 'EXPLICIT_FEE_SCAN_V1',
  source_reference: 'scan-runtime-0001',
  source_hash: 'b'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: sellObserved,
  transaction_signature: sellSignature,
  complete: true,
  scope: 'SOURCE_TRADE_NON_EMBEDDED_FEES',
  covered_fee_classes: ['PLATFORM_EXECUTION_FEE', 'OTHER_EXPLICIT_FEE'],
  performance_fee_handling: 'OUT_OF_SCOPE_PERIODIC_FEE'
};
const balanceInventory = {
  ...boundary,
  source_type: 'FULL_WALLET_BALANCE_INVENTORY_V1',
  source_reference: 'inventory-runtime-0001',
  source_hash: 'd'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: sellObserved,
  wallet_address: wallet,
  transaction_signature: sellSignature,
  complete: true,
  status: 'COMPLETE',
  phase: 'POST_TRADE',
  assets: [
    { mint: quoteMint, amount_raw: '120000000', decimals: 6 },
    { mint: baseMint, amount_raw: '0', decimals: 6 }
  ]
};
const assetValuations = [{
  ...boundary,
  source_type: 'ASSET_USD_VALUATION_V1',
  source_reference: 'quote-valuation-runtime-0001',
  source_hash: 'f'.repeat(64),
  mint: quoteMint,
  anchor_slot: candidate.source_slot,
  observed_at: sellObserved,
  currency: 'USD_MICRO_PER_TOKEN',
  price_usd_micro_per_token: 1_000_000,
  read_only: true
}];
const tradeValuationSnapshot = {
  source_type: 'TRADE_USD_VALUATION_V1',
  source_reference: 'trade-valuation-runtime-0001',
  source_hash: '9'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: sellObserved,
  trade_event_id: candidate.event_id,
  accounting_hash: candidate.accounting_hash,
  proceeds_minor: candidate.proceeds_minor,
  cost_basis_minor: candidate.cost_basis_minor,
  currency: 'USD_MICRO'
};

const pending = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan,
  balanceInventory,
  assetValuations: [],
  tradeValuationSnapshot
});
assert.equal(pending.status, 'PENDING_SOURCE_COMPLETENESS');
assert.equal(pending.reconciliation_ready, false);

const ready = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan,
  explicitFees: [],
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(ready.status, 'RECONCILIATION_READY');
assert.equal(ready.reconciliation_ready, true);
assert.equal(ready.evidence_ready, false);
assert.equal(ready.verification_authorized, false);
assert.equal(ready.publication_authorized, false);
assert.equal(ready.verified, false);
assert.equal(ready.published, false);
assert.equal(ready.live_execution_authorized, false);

const record = buildCoordinatedLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001',
  walletAddress: wallet,
  event: sell,
  coordinated: ready
});
assert.equal(record.trade_event_id, sell.event_id);
assert.equal(record.source_signature, sellSignature);
assert.equal(record.source_hash, ready.reconciled_trade.finalization_hash);
assert.equal(record.realized_pnl_minor, 19_999_500);
assert.equal(record.capital_minor, 100_000_000);
assert.equal(record.equity_after_minor, 120_000_000);
assert.equal(record.accounting_method, 'FIFO_COST_BASIS_V1');
assert.equal(record.provenance.source_type, 'AETHER_COORDINATED_RECONCILIATION');
assert.equal(record.provenance.verified, false);
assert.equal(record.provenance.published, false);
assert.equal(record.provenance.live_execution_authorized, false);

assert.throws(() => buildCoordinatedLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001',
  walletAddress: wallet,
  event: sell,
  coordinated: { ...ready, verified: true }
}), /coordinated_reconciliation_boundary_violation/);

assert.throws(() => buildCoordinatedLedgerRecord({
  traderId: '00000000-0000-0000-0000-000000000001',
  walletAddress: wallet,
  event: { ...sell, tx_hash: 'not-a-signature' },
  coordinated: ready
}), /invalid_source_signature/);

// Runtime service must reject the historical caller-supplied PnL/equity path before any DB
// access. A dummy truthy pool is sufficient because this request must fail first.
const service = createReconciledPerformanceService({});
await assert.rejects(
  service.recordTrades('00000000-0000-0000-0000-000000000001', {
    rows: [{
      trade_event_id: sell.event_id,
      realized_pnl_minor: 1,
      capital_minor: 1,
      equity_after_minor: 2,
      accounting_method: 'FIFO_COST_BASIS_V1',
      valuation_reference: 'manual-value'
    }]
  }),
  /reconciliation_manual_metrics_blocked/
);

const serviceSource = await fs.readFile(new URL('../services/api/src/reconciled-performance-service.mjs', import.meta.url), 'utf8');
assert.ok(serviceSource.includes('createReconciliationRuntimeService'));
assert.ok(serviceSource.includes('coordinateAndRecord'));
assert.ok(serviceSource.includes('reconciliation_manual_metrics_blocked'));

console.log('reconciliation runtime regression: PASS');
