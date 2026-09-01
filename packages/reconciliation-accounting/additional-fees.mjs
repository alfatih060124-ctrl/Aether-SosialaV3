import crypto from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TIME_DRIFT_MS = 5 * 60 * 1000;
const EXPLICIT_FEE_CLASSES = new Set(['PLATFORM_EXECUTION_FEE', 'OTHER_EXPLICIT_FEE']);
const REQUIRED_SCAN_CLASSES = ['OTHER_EXPLICIT_FEE', 'PLATFORM_EXECUTION_FEE'];

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

function source(snapshot, name, expectedType, sourceSlot, observedMs) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${name}_required`);
  if (snapshot.source_type !== expectedType) throw new Error(`${name}_source_type_invalid`);
  const slot = safeInt(snapshot.source_slot, `${name}_source_slot`);
  if (slot !== sourceSlot) throw new Error(`${name}_slot_mismatch`);
  const reference = text(snapshot.source_reference, `${name}_source_reference`, 8, 300);
  const sourceHash = hashText(snapshot.source_hash, `${name}_source_hash`);
  const observed = time(snapshot.observed_at, `${name}_observed_at`);
  if (Math.abs(observed.ms - observedMs) > MAX_TIME_DRIFT_MS) throw new Error(`${name}_time_mismatch`);
  assertBoundary(snapshot, name);
  return { reference, sourceHash, slot, observedAt: observed.iso };
}

export function buildAdditionalFeeSnapshot({ networkFeeSnapshot, explicitFees = [], scanEvidence } = {}) {
  if (!networkFeeSnapshot || typeof networkFeeSnapshot !== 'object') throw new Error('network_fee_snapshot_required');
  if (networkFeeSnapshot.source_type !== 'SOLANA_NETWORK_FEE_USD_V1') throw new Error('network_fee_source_type_invalid');
  if (networkFeeSnapshot.status !== 'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES') throw new Error('network_fee_state_invalid');
  if (networkFeeSnapshot.currency !== 'USD_MICRO') throw new Error('network_fee_currency_invalid');
  if (networkFeeSnapshot.complete_additional_fee_set !== false || networkFeeSnapshot.promoter_ready !== false) throw new Error('network_fee_boundary_violation');
  assertBoundary(networkFeeSnapshot, 'network_fee');

  const sourceSlot = safeInt(networkFeeSnapshot.source_slot, 'network_fee_source_slot');
  const observed = time(networkFeeSnapshot.observed_at, 'network_fee_observed_at');
  const networkFeeMinor = safeInt(networkFeeSnapshot.network_fee_minor, 'network_fee_minor');
  const networkReference = text(networkFeeSnapshot.source_reference, 'network_fee_source_reference', 8, 300);
  const networkSourceHash = hashText(networkFeeSnapshot.source_hash, 'network_fee_source_hash');

  const scan = source(scanEvidence, 'explicit_fee_scan', 'EXPLICIT_FEE_SCAN_V1', sourceSlot, observed.ms);
  if (scanEvidence.complete !== true) throw new Error('explicit_fee_scan_incomplete');
  if (scanEvidence.scope !== 'SOURCE_TRADE_NON_EMBEDDED_FEES') throw new Error('explicit_fee_scan_scope_invalid');
  if (scanEvidence.performance_fee_handling !== 'OUT_OF_SCOPE_PERIODIC_FEE') throw new Error('performance_fee_handling_invalid');
  const covered = Array.isArray(scanEvidence.covered_fee_classes)
    ? [...new Set(scanEvidence.covered_fee_classes.map(v => String(v).trim().toUpperCase()))].sort()
    : [];
  if (JSON.stringify(covered) !== JSON.stringify(REQUIRED_SCAN_CLASSES)) throw new Error('explicit_fee_scan_coverage_incomplete');

  if (!Array.isArray(explicitFees)) throw new Error('explicit_fees_must_be_array');
  let platformExecutionFeeMinor = 0;
  let otherExplicitFeeMinor = 0;
  const seen = new Set();
  const charges = [];

  for (const fee of explicitFees) {
    const checked = source(fee, 'explicit_fee', 'EXPLICIT_FEE_CHARGE_V1', sourceSlot, observed.ms);
    if (fee.charged !== true) throw new Error('explicit_fee_must_be_charged');
    if (fee.currency !== 'USD_MICRO') throw new Error('explicit_fee_currency_invalid');
    const category = String(fee.category || '').trim().toUpperCase();
    if (category === 'PERFORMANCE_FEE') throw new Error('performance_fee_not_per_trade');
    if (!EXPLICIT_FEE_CLASSES.has(category)) throw new Error('explicit_fee_category_invalid');
    const amountMinor = safeInt(fee.amount_minor, 'explicit_fee_amount_minor', 1);
    if (seen.has(checked.sourceHash)) throw new Error('duplicate_explicit_fee_source');
    seen.add(checked.sourceHash);
    if (category === 'PLATFORM_EXECUTION_FEE') platformExecutionFeeMinor = safeInt(platformExecutionFeeMinor + amountMinor, 'platform_execution_fee_minor');
    else otherExplicitFeeMinor = safeInt(otherExplicitFeeMinor + amountMinor, 'other_explicit_fee_minor');
    charges.push({
      category,
      amount_minor: amountMinor,
      source_reference: checked.reference,
      source_hash: checked.sourceHash,
      observed_at: checked.observedAt
    });
  }

  charges.sort((a, b) => a.source_hash.localeCompare(b.source_hash));
  const additionalFeeMinor = safeInt(networkFeeMinor + platformExecutionFeeMinor + otherExplicitFeeMinor, 'additional_fee_minor');
  const payload = {
    schema_version: 1,
    source_type: 'ADDITIONAL_NON_EMBEDDED_FEES_V1',
    source_slot: sourceSlot,
    network_fee_source_hash: networkSourceHash,
    explicit_fee_scan_source_hash: scan.sourceHash,
    charges,
    network_fee_minor: networkFeeMinor,
    platform_execution_fee_minor: platformExecutionFeeMinor,
    other_explicit_fee_minor: otherExplicitFeeMinor,
    additional_fee_minor: additionalFeeMinor,
    embedded_swap_fee_handling: 'ALREADY_REFLECTED_IN_EXECUTION_VALUE',
    performance_fee_handling: 'OUT_OF_SCOPE_PERIODIC_FEE'
  };
  const sourceHash = sha(payload);

  return {
    schema_version: 1,
    source_type: 'ADDITIONAL_NON_EMBEDDED_FEES_V1',
    source_reference: `fee-set:${sourceSlot}:${networkSourceHash.slice(0, 12)}:${scan.sourceHash.slice(0, 12)}`,
    source_hash: sourceHash,
    source_slot: sourceSlot,
    observed_at: observed.iso,
    currency: 'USD_MICRO',
    additional_fee_minor: additionalFeeMinor,
    network_fee_minor: networkFeeMinor,
    platform_execution_fee_minor: platformExecutionFeeMinor,
    other_explicit_fee_minor: otherExplicitFeeMinor,
    embedded_swap_fee_handling: 'ALREADY_REFLECTED_IN_EXECUTION_VALUE',
    performance_fee_handling: 'OUT_OF_SCOPE_PERIODIC_FEE',
    fee_scope: 'SOURCE_TRADE_ONLY',
    status: 'COMPLETE_ADDITIONAL_FEE_SET',
    promoter_ready: true,
    reconciliation_ready: false,
    evidence_ready: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance: {
      network_fee_source_reference: networkReference,
      network_fee_source_hash: networkSourceHash,
      explicit_fee_scan_source_reference: scan.reference,
      explicit_fee_scan_source_hash: scan.sourceHash,
      covered_fee_classes: covered,
      explicit_charges: charges
    }
  };
}
