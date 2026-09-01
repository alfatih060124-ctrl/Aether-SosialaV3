import assert from 'node:assert/strict';
import { buildFifoAccountingCandidates } from '../packages/reconciliation-accounting/fifo.mjs';
import { coordinateReconciliationSources } from '../packages/reconciliation-accounting/coordinator.mjs';

// Synthetic/test-only fixtures. They model source contracts and must never be interpreted
// as real trader performance, real fees, a live wallet balance, or evidence for publication.
const observedBuy = '2026-09-01T00:00:00.000Z';
const observedSell = '2026-09-01T00:01:00.000Z';
const traderWallet = 'TraderWallet1111111111111111111111111111111';
const buySignature = 'B'.repeat(64);
const sellSignature = 'S'.repeat(64);
const quoteMint = 'USDC_MINT';
const baseMint = 'TOKEN_MINT';

const accounting = buildFifoAccountingCandidates({
  quoteMints: [quoteMint],
  events: [
    {
      event_id: 'trade-buy-001',
      tx_hash: buySignature,
      decoder_version: 'decoder-v1',
      chain: 'solana',
      trader_wallet: traderWallet,
      token_in: quoteMint,
      token_out: baseMint,
      amount_in_raw: '100000000',
      amount_out_raw: '1000000',
      amount_usd: '100',
      slot: 100,
      confidence: 0.99,
      observed_at: observedBuy
    },
    {
      event_id: 'trade-sell-001',
      tx_hash: sellSignature,
      decoder_version: 'decoder-v1',
      chain: 'solana',
      trader_wallet: traderWallet,
      token_in: baseMint,
      token_out: quoteMint,
      amount_in_raw: '1000000',
      amount_out_raw: '120000000',
      amount_usd: '120',
      slot: 101,
      confidence: 0.99,
      observed_at: observedSell
    }
  ]
});
assert.equal(accounting.candidates.length, 1);
const candidate = accounting.candidates[0];
assert.equal(candidate.gross_realized_pnl_minor, 20_000_000);

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
  observed_at: observedSell,
  network_fee_minor: 500,
  currency: 'USD_MICRO',
  status: 'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES',
  complete_additional_fee_set: false,
  promoter_ready: false
};

const explicitFeeScan = {
  ...boundary,
  source_type: 'EXPLICIT_FEE_SCAN_V1',
  source_reference: 'scan-reference-0001',
  source_hash: 'b'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: observedSell,
  transaction_signature: sellSignature,
  complete: true,
  scope: 'SOURCE_TRADE_NON_EMBEDDED_FEES',
  covered_fee_classes: ['PLATFORM_EXECUTION_FEE', 'OTHER_EXPLICIT_FEE'],
  performance_fee_handling: 'OUT_OF_SCOPE_PERIODIC_FEE'
};

const explicitFee = {
  ...boundary,
  source_type: 'EXPLICIT_FEE_CHARGE_V1',
  source_reference: 'platform-charge-0001',
  source_hash: 'c'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: observedSell,
  transaction_signature: sellSignature,
  category: 'PLATFORM_EXECUTION_FEE',
  amount_minor: 2_500,
  currency: 'USD_MICRO',
  charged: true
};

const balanceInventory = {
  ...boundary,
  source_type: 'FULL_WALLET_BALANCE_INVENTORY_V1',
  source_reference: 'inventory-reference-0001',
  source_hash: 'd'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: observedSell,
  wallet_address: traderWallet,
  transaction_signature: sellSignature,
  complete: true,
  status: 'COMPLETE',
  phase: 'POST_TRADE',
  assets: [
    { mint: 'SOL_NATIVE', amount_raw: '1000000000', decimals: 9 },
    { mint: quoteMint, amount_raw: '120000000', decimals: 6 },
    { mint: baseMint, amount_raw: '0', decimals: 6 }
  ]
};

const assetValuations = [
  {
    ...boundary,
    source_type: 'ASSET_USD_VALUATION_V1',
    source_reference: 'sol-valuation-reference',
    source_hash: 'e'.repeat(64),
    mint: 'SOL_NATIVE',
    anchor_slot: candidate.source_slot,
    observed_at: observedSell,
    currency: 'USD_MICRO_PER_TOKEN',
    price_usd_micro_per_token: 150_000_000,
    read_only: true
  },
  {
    ...boundary,
    source_type: 'ASSET_USD_VALUATION_V1',
    source_reference: 'usdc-valuation-reference',
    source_hash: 'f'.repeat(64),
    mint: quoteMint,
    anchor_slot: candidate.source_slot,
    observed_at: observedSell,
    currency: 'USD_MICRO_PER_TOKEN',
    price_usd_micro_per_token: 1_000_000,
    read_only: true
  }
];

const tradeValuationSnapshot = {
  source_type: 'TRADE_USD_VALUATION_V1',
  source_reference: 'trade-valuation-reference-001',
  source_hash: '9'.repeat(64),
  source_slot: candidate.source_slot,
  observed_at: observedSell,
  trade_event_id: candidate.event_id,
  accounting_hash: candidate.accounting_hash,
  proceeds_minor: candidate.proceeds_minor,
  cost_basis_minor: candidate.cost_basis_minor,
  currency: 'USD_MICRO'
};

const ready = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFees: [explicitFee],
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(ready.status, 'RECONCILIATION_READY');
assert.equal(ready.source_completeness, 'COMPLETE');
assert.equal(ready.reconciliation_ready, true);
assert.equal(ready.evidence_ready, false);
assert.equal(ready.verification_authorized, false);
assert.equal(ready.publication_authorized, false);
assert.equal(ready.verified, false);
assert.equal(ready.published, false);
assert.equal(ready.live_execution_authorized, false);
assert.equal(ready.fee_snapshot.additional_fee_minor, 3_000);
assert.equal(ready.equity_snapshot.equity_after_minor, 270_000_000);
assert.equal(ready.reconciled_trade.realized_pnl_minor, 19_997_000);
assert.equal(ready.reconciled_trade.capital_minor, 100_000_000);
assert.equal(ready.reconciled_trade.evidence_ready, false);

const missingNetwork = coordinateReconciliationSources({
  candidate,
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(missingNetwork.status, 'PENDING_SOURCE_COMPLETENESS');
assert.equal(missingNetwork.reconciliation_ready, false);
assert.deepEqual(missingNetwork.missing_sources, ['SOLANA_NETWORK_FEE_USD']);

const incompleteScan = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan: { ...explicitFeeScan, complete: false },
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(incompleteScan.status, 'PENDING_SOURCE_COMPLETENESS');
assert.deepEqual(incompleteScan.missing_sources, ['ADDITIONAL_NON_EMBEDDED_FEES']);
assert.ok(incompleteScan.blockers.includes('explicit_fee_scan_incomplete'));

const missingValuation = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan,
  balanceInventory,
  assetValuations: assetValuations.filter(v => v.mint !== quoteMint),
  tradeValuationSnapshot
});
assert.equal(missingValuation.status, 'PENDING_SOURCE_COMPLETENESS');
assert.deepEqual(missingValuation.missing_sources, ['FULL_WALLET_EQUITY']);
assert.ok(missingValuation.blockers.includes(`valuation_required_${quoteMint}`));

const wrongNetworkTransaction = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot: { ...networkFeeSnapshot, source_reference: buySignature },
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(wrongNetworkTransaction.status, 'BLOCKED_INVALID_SOURCE');
assert.deepEqual(wrongNetworkTransaction.blockers, ['network_fee_transaction_mismatch']);

const wrongInventoryTransaction = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan,
  balanceInventory: { ...balanceInventory, transaction_signature: buySignature },
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(wrongInventoryTransaction.status, 'BLOCKED_INVALID_SOURCE');
assert.deepEqual(wrongInventoryTransaction.blockers, ['wallet_inventory_transaction_mismatch']);

const wrongFeeTransaction = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFees: [{ ...explicitFee, transaction_signature: buySignature }],
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
});
assert.equal(wrongFeeTransaction.status, 'BLOCKED_INVALID_SOURCE');
assert.deepEqual(wrongFeeTransaction.blockers, ['explicit_fee_transaction_mismatch']);

const wrongTradeValuation = coordinateReconciliationSources({
  candidate,
  networkFeeSnapshot,
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot: { ...tradeValuationSnapshot, accounting_hash: '0'.repeat(64) }
});
assert.equal(wrongTradeValuation.status, 'BLOCKED_INVALID_SOURCE');
assert.deepEqual(wrongTradeValuation.blockers, ['trade_valuation_accounting_hash_mismatch']);

assert.throws(() => coordinateReconciliationSources({
  candidate: { ...candidate, gross_realized_pnl_minor: candidate.gross_realized_pnl_minor + 1 },
  networkFeeSnapshot,
  explicitFeeScan,
  balanceInventory,
  assetValuations,
  tradeValuationSnapshot
}), /accounting_candidate_pnl_mismatch|accounting_hash_mismatch/, 'tampered FIFO candidate must fail hard');

console.log('reconciliation source coordinator regression passed');
