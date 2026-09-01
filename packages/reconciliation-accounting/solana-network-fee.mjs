import crypto from 'node:crypto';

const SIGNATURE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HASH_RE = /^[a-f0-9]{64}$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_PRICE_TIME_DRIFT_MS = 5 * 60 * 1000;

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

function signature(value) {
  const s = String(value ?? '').trim();
  if (!SIGNATURE_BASE58.test(s) || decodedBase58ByteLength(s) !== 64) throw new Error('invalid_solana_signature');
  return s;
}

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

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashText(value, name) {
  const h = text(value, name, 64, 64).toLowerCase();
  if (!HASH_RE.test(h)) throw new Error(`invalid_${name}`);
  return h;
}

function isoTime(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_${name}`);
  return { ms, iso: new Date(ms).toISOString() };
}

function observationHashPayload(observation) {
  return {
    schema_version: 1,
    source_type: 'SOLANA_TRANSACTION_FEE_LAMPORTS_V1',
    source_reference: observation.source_reference,
    source_slot: observation.source_slot,
    block_time_unix: observation.block_time_unix,
    network_fee_lamports: observation.network_fee_lamports
  };
}

export function verifySolanaNetworkFeeObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new Error('invalid_solana_fee_observation');
  if (observation.source_type !== 'SOLANA_TRANSACTION_FEE_LAMPORTS_V1') throw new Error('invalid_solana_fee_source_type');
  if (observation.status !== 'PENDING_SOL_USD_VALUATION') throw new Error('invalid_solana_fee_observation_state');
  const sourceReference = signature(observation.source_reference);
  const sourceSlot = safeInt(observation.source_slot, 'solana_fee_source_slot');
  const blockTimeUnix = observation.block_time_unix === null || observation.block_time_unix === undefined
    ? null
    : safeInt(observation.block_time_unix, 'solana_fee_block_time_unix');
  const networkFeeLamports = safeInt(observation.network_fee_lamports, 'network_fee_lamports');
  const observed = isoTime(observation.observed_at, 'solana_fee_observed_at');
  if (observation.promoter_ready !== false || observation.reconciliation_ready !== false || observation.evidence_ready !== false) {
    throw new Error('solana_fee_boundary_violation');
  }
  if (observation.verified !== false || observation.published !== false || observation.live_execution_authorized !== false) {
    throw new Error('solana_fee_boundary_violation');
  }
  const expectedHash = hash(observationHashPayload({
    source_reference: sourceReference,
    source_slot: sourceSlot,
    block_time_unix: blockTimeUnix,
    network_fee_lamports: networkFeeLamports
  }));
  if (hashText(observation.source_hash, 'solana_fee_source_hash') !== expectedHash) throw new Error('solana_fee_source_hash_mismatch');
  return { sourceReference, sourceSlot, blockTimeUnix, networkFeeLamports, observedAt: observed.iso, observedMs: observed.ms, sourceHash: expectedHash };
}

export async function collectSolanaNetworkFeeObservation({
  signature: transactionSignature,
  rpcCall,
  expectedSlot = null,
  endpointLabel = 'solana-rpc',
  clock = () => new Date()
} = {}) {
  const sourceReference = signature(transactionSignature);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('solana_fee_clock_required');
  const normalizedExpectedSlot = expectedSlot === null || expectedSlot === undefined
    ? null
    : safeInt(expectedSlot, 'expected_solana_fee_slot');

  const transaction = await rpcCall('getTransaction', [sourceReference, {
    encoding: 'json',
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  }]);
  if (!transaction || typeof transaction !== 'object') throw new Error('solana_transaction_not_found');
  const sourceSlot = safeInt(transaction.slot, 'solana_fee_source_slot');
  if (normalizedExpectedSlot !== null && sourceSlot !== normalizedExpectedSlot) throw new Error('solana_fee_slot_mismatch');
  if (!transaction.meta || typeof transaction.meta !== 'object') throw new Error('solana_transaction_meta_required');
  if (transaction.meta.err !== null && transaction.meta.err !== undefined) throw new Error('solana_transaction_failed');
  const networkFeeLamports = safeInt(transaction.meta.fee, 'network_fee_lamports');
  const blockTimeUnix = transaction.blockTime === null || transaction.blockTime === undefined
    ? null
    : safeInt(transaction.blockTime, 'solana_fee_block_time_unix');
  const observedAt = clock();
  const observed = isoTime(observedAt instanceof Date ? observedAt.toISOString() : observedAt, 'solana_fee_observed_at');

  const sourceHash = hash(observationHashPayload({
    source_reference: sourceReference,
    source_slot: sourceSlot,
    block_time_unix: blockTimeUnix,
    network_fee_lamports: networkFeeLamports
  }));

  return {
    schema_version: 1,
    source_type: 'SOLANA_TRANSACTION_FEE_LAMPORTS_V1',
    source_reference: sourceReference,
    source_hash: sourceHash,
    source_slot: sourceSlot,
    observed_at: observed.iso,
    block_time_unix: blockTimeUnix,
    network_fee_lamports: networkFeeLamports,
    status: 'PENDING_SOL_USD_VALUATION',
    promoter_ready: false,
    reconciliation_ready: false,
    evidence_ready: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance: {
      rpc_endpoint_label: text(endpointLabel || 'solana-rpc', 'rpc_endpoint_label', 1, 120),
      rpc_method: 'getTransaction',
      commitment: 'confirmed',
      max_supported_transaction_version: 0
    }
  };
}

export function valueSolanaNetworkFeeObservation({ observation, solUsdSnapshot } = {}) {
  const checked = verifySolanaNetworkFeeObservation(observation);
  if (!solUsdSnapshot || typeof solUsdSnapshot !== 'object') throw new Error('sol_usd_snapshot_required');
  if (solUsdSnapshot.source_type !== 'SOL_USD_PRICE_V1') throw new Error('invalid_sol_usd_source_type');
  const priceReference = text(solUsdSnapshot.source_reference, 'sol_usd_source_reference', 8, 300);
  const priceHash = hashText(solUsdSnapshot.source_hash, 'sol_usd_source_hash');
  const anchorSlot = safeInt(solUsdSnapshot.anchor_slot, 'sol_usd_anchor_slot');
  if (anchorSlot !== checked.sourceSlot) throw new Error('sol_usd_anchor_slot_mismatch');
  const priceObserved = isoTime(solUsdSnapshot.observed_at, 'sol_usd_observed_at');
  if (Math.abs(priceObserved.ms - checked.observedMs) > MAX_PRICE_TIME_DRIFT_MS) throw new Error('sol_usd_time_mismatch');
  if (solUsdSnapshot.currency !== 'USD_MICRO_PER_SOL') throw new Error('sol_usd_currency_invalid');
  const priceUsdMicroPerSol = safeInt(solUsdSnapshot.price_usd_micro_per_sol, 'price_usd_micro_per_sol', 1);

  const numerator = BigInt(checked.networkFeeLamports) * BigInt(priceUsdMicroPerSol);
  const networkFeeMinorBig = (numerator + (LAMPORTS_PER_SOL / 2n)) / LAMPORTS_PER_SOL;
  if (networkFeeMinorBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('network_fee_usd_overflow');
  const networkFeeMinor = Number(networkFeeMinorBig);
  const sourceHash = hash({
    schema_version: 1,
    source_type: 'SOLANA_NETWORK_FEE_USD_V1',
    solana_fee_source_hash: checked.sourceHash,
    sol_usd_source_hash: priceHash,
    source_slot: checked.sourceSlot,
    network_fee_lamports: checked.networkFeeLamports,
    price_usd_micro_per_sol: priceUsdMicroPerSol,
    network_fee_minor: networkFeeMinor,
    rounding: 'HALF_UP_TO_USD_MICRO'
  });

  return {
    schema_version: 1,
    source_type: 'SOLANA_NETWORK_FEE_USD_V1',
    source_reference: checked.sourceReference,
    source_hash: sourceHash,
    source_slot: checked.sourceSlot,
    observed_at: checked.observedAt,
    network_fee_lamports: checked.networkFeeLamports,
    network_fee_minor: networkFeeMinor,
    currency: 'USD_MICRO',
    rounding: 'HALF_UP_TO_USD_MICRO',
    status: 'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES',
    complete_additional_fee_set: false,
    additional_fee_minor: null,
    promoter_ready: false,
    reconciliation_ready: false,
    evidence_ready: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance: {
      solana_fee_source_hash: checked.sourceHash,
      sol_usd_source_reference: priceReference,
      sol_usd_source_hash: priceHash,
      sol_usd_anchor_slot: anchorSlot,
      sol_usd_observed_at: priceObserved.iso,
      price_usd_micro_per_sol: priceUsdMicroPerSol
    }
  };
}
