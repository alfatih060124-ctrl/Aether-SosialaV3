import crypto from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TIME_DRIFT_MS = 5 * 60 * 1000;
const MAX_DECIMALS = 18;

function text(value, name, min = 1, max = 300) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) throw new Error(`invalid_${name}`);
  return s;
}

function safeInt(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}

function rawAmount(value, name) {
  const s = text(value, name, 1, 100);
  if (!/^\d+$/.test(s)) throw new Error(`invalid_${name}`);
  return BigInt(s);
}

function hashText(value, name) {
  const h = text(value, name, 64, 64).toLowerCase();
  if (!HASH_RE.test(h)) throw new Error(`invalid_${name}`);
  return h;
}

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function time(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_${name}`);
  return { ms, iso: new Date(ms).toISOString() };
}

function assertBoundary(snapshot, name) {
  if (snapshot.reconciliation_ready !== false || snapshot.evidence_ready !== false) throw new Error(`${name}_boundary_violation`);
  if (snapshot.verified !== false || snapshot.published !== false || snapshot.live_execution_authorized !== false) throw new Error(`${name}_boundary_violation`);
}

function checkedValuation(snapshot, mint, sourceSlot, observedMs) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`valuation_required_${mint}`);
  if (snapshot.source_type !== 'ASSET_USD_VALUATION_V1') throw new Error('valuation_source_type_invalid');
  if (text(snapshot.mint, 'valuation_mint', 1, 120) !== mint) throw new Error('valuation_mint_mismatch');
  if (safeInt(snapshot.anchor_slot, 'valuation_anchor_slot') !== sourceSlot) throw new Error('valuation_slot_mismatch');
  if (snapshot.currency !== 'USD_MICRO_PER_TOKEN') throw new Error('valuation_currency_invalid');
  if (snapshot.read_only !== true) throw new Error('valuation_must_be_read_only');
  assertBoundary(snapshot, 'valuation');
  const observed = time(snapshot.observed_at, 'valuation_observed_at');
  if (Math.abs(observed.ms - observedMs) > MAX_TIME_DRIFT_MS) throw new Error('valuation_time_mismatch');
  return {
    sourceReference: text(snapshot.source_reference, 'valuation_source_reference', 8, 300),
    sourceHash: hashText(snapshot.source_hash, 'valuation_source_hash'),
    priceUsdMicroPerToken: safeInt(snapshot.price_usd_micro_per_token, 'price_usd_micro_per_token', 1),
    observedAt: observed.iso
  };
}

function valueAssetMinor(amountRaw, decimals, priceUsdMicroPerToken) {
  const scale = 10n ** BigInt(decimals);
  const numerator = amountRaw * BigInt(priceUsdMicroPerToken);
  const value = (numerator + scale / 2n) / scale;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('wallet_equity_value_overflow');
  return Number(value);
}

export function buildWalletEquitySnapshot({ balanceInventory, valuations = [] } = {}) {
  if (!balanceInventory || typeof balanceInventory !== 'object') throw new Error('balance_inventory_required');
  if (balanceInventory.source_type !== 'FULL_WALLET_BALANCE_INVENTORY_V1') throw new Error('balance_inventory_source_type_invalid');
  if (balanceInventory.complete !== true || balanceInventory.status !== 'COMPLETE') throw new Error('balance_inventory_incomplete');
  if (balanceInventory.phase !== 'POST_TRADE') throw new Error('balance_inventory_phase_invalid');
  assertBoundary(balanceInventory, 'balance_inventory');

  const walletAddress = text(balanceInventory.wallet_address, 'wallet_address', 8, 120);
  const transactionSignature = text(balanceInventory.transaction_signature, 'transaction_signature', 32, 120);
  const sourceSlot = safeInt(balanceInventory.source_slot, 'balance_inventory_source_slot');
  const observed = time(balanceInventory.observed_at, 'balance_inventory_observed_at');
  const inventoryReference = text(balanceInventory.source_reference, 'balance_inventory_source_reference', 8, 300);
  const inventorySourceHash = hashText(balanceInventory.source_hash, 'balance_inventory_source_hash');
  if (!Array.isArray(balanceInventory.assets)) throw new Error('balance_inventory_assets_required');
  if (!Array.isArray(valuations)) throw new Error('valuations_must_be_array');

  const valuationByMint = new Map();
  for (const valuation of valuations) {
    const mint = text(valuation?.mint, 'valuation_mint', 1, 120);
    if (valuationByMint.has(mint)) throw new Error('duplicate_asset_valuation');
    valuationByMint.set(mint, valuation);
  }

  const seenAssets = new Set();
  const assetValues = [];
  let total = 0;

  for (const asset of balanceInventory.assets) {
    if (!asset || typeof asset !== 'object') throw new Error('invalid_balance_inventory_asset');
    const mint = text(asset.mint, 'asset_mint', 1, 120);
    if (seenAssets.has(mint)) throw new Error('duplicate_balance_inventory_asset');
    seenAssets.add(mint);
    const decimals = safeInt(asset.decimals, 'asset_decimals', 0, MAX_DECIMALS);
    const amount = rawAmount(asset.amount_raw, 'asset_amount_raw');
    if (amount === 0n) {
      assetValues.push({ mint, amount_raw: '0', decimals, value_minor: 0, valuation_source_hash: null });
      continue;
    }
    const valuation = checkedValuation(valuationByMint.get(mint), mint, sourceSlot, observed.ms);
    const valueMinor = valueAssetMinor(amount, decimals, valuation.priceUsdMicroPerToken);
    total = safeInt(total + valueMinor, 'equity_after_minor', 0);
    assetValues.push({
      mint,
      amount_raw: amount.toString(),
      decimals,
      value_minor: valueMinor,
      price_usd_micro_per_token: valuation.priceUsdMicroPerToken,
      valuation_source_reference: valuation.sourceReference,
      valuation_source_hash: valuation.sourceHash,
      valuation_observed_at: valuation.observedAt
    });
  }

  if (total <= 0) throw new Error('wallet_equity_must_be_positive');
  assetValues.sort((a, b) => a.mint.localeCompare(b.mint));
  const payload = {
    schema_version: 1,
    source_type: 'WALLET_EQUITY_SNAPSHOT_V1',
    wallet_address: walletAddress,
    transaction_signature: transactionSignature,
    source_slot: sourceSlot,
    inventory_source_hash: inventorySourceHash,
    assets: assetValues.map(a => ({
      mint: a.mint,
      amount_raw: a.amount_raw,
      decimals: a.decimals,
      value_minor: a.value_minor,
      valuation_source_hash: a.valuation_source_hash
    })),
    equity_after_minor: total,
    currency: 'USD_MICRO',
    balance_scope: 'FULL_TRADER_WALLET_MARK_TO_MARKET'
  };
  const sourceHash = sha(payload);

  return {
    schema_version: 1,
    source_type: 'WALLET_EQUITY_SNAPSHOT_V1',
    source_reference: `wallet-equity:${sourceSlot}:${inventorySourceHash.slice(0, 16)}`,
    source_hash: sourceHash,
    source_slot: sourceSlot,
    observed_at: observed.iso,
    wallet_address: walletAddress,
    transaction_signature: transactionSignature,
    equity_after_minor: total,
    currency: 'USD_MICRO',
    balance_scope: 'FULL_TRADER_WALLET_MARK_TO_MARKET',
    completeness: 'COMPLETE_NONZERO_ASSET_VALUATION',
    status: 'COMPLETE',
    promoter_ready: true,
    reconciliation_ready: false,
    evidence_ready: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance: {
      balance_inventory_source_reference: inventoryReference,
      balance_inventory_source_hash: inventorySourceHash,
      asset_values: assetValues
    }
  };
}
