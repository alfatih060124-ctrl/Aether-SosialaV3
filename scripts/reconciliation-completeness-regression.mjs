import assert from 'node:assert/strict';
import { buildAdditionalFeeSnapshot } from '../packages/reconciliation-accounting/additional-fees.mjs';
import { buildWalletEquitySnapshot } from '../packages/reconciliation-accounting/wallet-equity.mjs';

const slot = 123456789;
const observedAt = '2026-09-01T00:00:00.000Z';
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
  source_reference: '5HueCGU8rMjxEXxiPuD5BDuRaK1JpE8Wb5tF1wJv4h8g8B2y3K4L5M6N7P8Q9R1S2T3U4V5W6X7Y8Z9a1b2c3d4e5f6g7h8',
  source_hash: 'a'.repeat(64),
  source_slot: slot,
  observed_at: observedAt,
  network_fee_minor: 250,
  currency: 'USD_MICRO',
  status: 'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES',
  complete_additional_fee_set: false,
  promoter_ready: false
};
const scanEvidence = {
  ...boundary,
  source_type: 'EXPLICIT_FEE_SCAN_V1',
  source_reference: 'scan-reference-0001',
  source_hash: 'b'.repeat(64),
  source_slot: slot,
  observed_at: observedAt,
  complete: true,
  scope: 'SOURCE_TRADE_NON_EMBEDDED_FEES',
  covered_fee_classes: ['PLATFORM_EXECUTION_FEE', 'OTHER_EXPLICIT_FEE'],
  performance_fee_handling: 'OUT_OF_SCOPE_PERIODIC_FEE'
};
const explicitPlatformFee = {
  ...boundary,
  source_type: 'EXPLICIT_FEE_CHARGE_V1',
  source_reference: 'platform-charge-0001',
  source_hash: 'c'.repeat(64),
  source_slot: slot,
  observed_at: observedAt,
  category: 'PLATFORM_EXECUTION_FEE',
  amount_minor: 100,
  currency: 'USD_MICRO',
  charged: true
};

const feeSet = buildAdditionalFeeSnapshot({
  networkFeeSnapshot,
  scanEvidence,
  explicitFees: [explicitPlatformFee]
});
assert.equal(feeSet.source_type, 'ADDITIONAL_NON_EMBEDDED_FEES_V1');
assert.equal(feeSet.network_fee_minor, 250);
assert.equal(feeSet.platform_execution_fee_minor, 100);
assert.equal(feeSet.other_explicit_fee_minor, 0);
assert.equal(feeSet.additional_fee_minor, 350);
assert.equal(feeSet.promoter_ready, true);
assert.equal(feeSet.verified, false);
assert.equal(feeSet.published, false);
assert.equal(feeSet.live_execution_authorized, false);
assert.equal(feeSet.performance_fee_handling, 'OUT_OF_SCOPE_PERIODIC_FEE');

const networkOnly = buildAdditionalFeeSnapshot({ networkFeeSnapshot, scanEvidence, explicitFees: [] });
assert.equal(networkOnly.additional_fee_minor, 250, 'complete scan with no explicit charges may finalize network-only fee set');

assert.throws(() => buildAdditionalFeeSnapshot({
  networkFeeSnapshot,
  scanEvidence: { ...scanEvidence, complete: false },
  explicitFees: []
}), /explicit_fee_scan_incomplete/);

assert.throws(() => buildAdditionalFeeSnapshot({
  networkFeeSnapshot,
  scanEvidence,
  explicitFees: [{ ...explicitPlatformFee, charged: false }]
}), /explicit_fee_must_be_charged/, 'configured but uncharged fee must never be counted');

assert.throws(() => buildAdditionalFeeSnapshot({
  networkFeeSnapshot,
  scanEvidence,
  explicitFees: [{ ...explicitPlatformFee, category: 'PERFORMANCE_FEE' }]
}), /performance_fee_not_per_trade/, 'performance fee is not a per-trade source fee');

assert.throws(() => buildAdditionalFeeSnapshot({
  networkFeeSnapshot,
  scanEvidence: { ...scanEvidence, source_slot: slot + 1 },
  explicitFees: []
}), /explicit_fee_scan_slot_mismatch/);

const inventory = {
  ...boundary,
  source_type: 'FULL_WALLET_BALANCE_INVENTORY_V1',
  source_reference: 'inventory-reference-0001',
  source_hash: 'd'.repeat(64),
  source_slot: slot,
  observed_at: observedAt,
  wallet_address: 'TraderWallet1111111111111111111111111111111',
  transaction_signature: 'TransactionSignature11111111111111111111111111111111111111111111111111111111',
  complete: true,
  status: 'COMPLETE',
  phase: 'POST_TRADE',
  assets: [
    { mint: 'SOL_NATIVE', amount_raw: '1500000000', decimals: 9 },
    { mint: 'USDC_MINT', amount_raw: '25000000', decimals: 6 },
    { mint: 'ZERO_TOKEN', amount_raw: '0', decimals: 6 }
  ]
};
const valuations = [
  {
    ...boundary,
    source_type: 'ASSET_USD_VALUATION_V1',
    source_reference: 'sol-valuation-reference',
    source_hash: 'e'.repeat(64),
    mint: 'SOL_NATIVE',
    anchor_slot: slot,
    observed_at: observedAt,
    currency: 'USD_MICRO_PER_TOKEN',
    price_usd_micro_per_token: 200_000_000,
    read_only: true
  },
  {
    ...boundary,
    source_type: 'ASSET_USD_VALUATION_V1',
    source_reference: 'usdc-valuation-reference',
    source_hash: 'f'.repeat(64),
    mint: 'USDC_MINT',
    anchor_slot: slot,
    observed_at: observedAt,
    currency: 'USD_MICRO_PER_TOKEN',
    price_usd_micro_per_token: 1_000_000,
    read_only: true
  }
];

const equity = buildWalletEquitySnapshot({ balanceInventory: inventory, valuations });
assert.equal(equity.source_type, 'WALLET_EQUITY_SNAPSHOT_V1');
assert.equal(equity.balance_scope, 'FULL_TRADER_WALLET_MARK_TO_MARKET');
assert.equal(equity.equity_after_minor, 325_000_000);
assert.equal(equity.promoter_ready, true);
assert.equal(equity.verified, false);
assert.equal(equity.published, false);
assert.equal(equity.live_execution_authorized, false);
assert.equal(equity.provenance.asset_values.length, 3);

assert.throws(() => buildWalletEquitySnapshot({
  balanceInventory: inventory,
  valuations: valuations.filter(v => v.mint !== 'USDC_MINT')
}), /valuation_required_USDC_MINT/, 'every nonzero asset requires a valuation');

assert.throws(() => buildWalletEquitySnapshot({
  balanceInventory: { ...inventory, complete: false },
  valuations
}), /balance_inventory_incomplete/);

assert.throws(() => buildWalletEquitySnapshot({
  balanceInventory: { ...inventory, assets: [...inventory.assets, inventory.assets[0]] },
  valuations
}), /duplicate_balance_inventory_asset/);

assert.throws(() => buildWalletEquitySnapshot({
  balanceInventory: inventory,
  valuations: valuations.map(v => v.mint === 'SOL_NATIVE' ? { ...v, anchor_slot: slot + 1 } : v)
}), /valuation_slot_mismatch/);

assert.throws(() => buildWalletEquitySnapshot({
  balanceInventory: inventory,
  valuations: valuations.map(v => v.mint === 'SOL_NATIVE' ? { ...v, read_only: false } : v)
}), /valuation_must_be_read_only/);

console.log('reconciliation completeness regression passed');
