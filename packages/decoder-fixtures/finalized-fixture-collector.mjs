import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const REQUIRED_DEX = new Set(['jupiter', 'raydium', 'orca']);
const EXPECTED = new Set(['EVENT', 'REJECT']);
const PLACEHOLDER_MARKERS = ['replace', 'unset', 'unknown', 'placeholder', 'any'];

function text(value, name, min = 1, max = 200) {
  const result = String(value ?? '').trim();
  if (result.length < min || result.length > max) throw new Error(`invalid_${name}`);
  return result;
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

function base58Bytes(value, bytes, name) {
  const result = text(value, name, bytes, bytes * 2);
  if (!BASE58.test(result) || decodedBase58ByteLength(result) !== bytes) throw new Error(`invalid_${name}`);
  return result;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeVersion(value) {
  const version = text(value, 'dex_version', 2, 100);
  const lower = version.toLowerCase();
  if (PLACEHOLDER_MARKERS.some(marker => lower.includes(marker))) throw new Error('placeholder_version_not_allowed');
  return version;
}

function normalizeEndpointLabel(value) {
  const label = text(value || 'solana-rpc', 'rpc_endpoint_label', 1, 80);
  const lower = label.toLowerCase();
  if (label.includes('://') || /(?:api[_-]?key|token|secret|password|passphrase|bearer)/i.test(lower)) {
    throw new Error('rpc_endpoint_label_must_not_contain_secret_or_url');
  }
  return label;
}

function accountKeyString(key) {
  if (typeof key === 'string') return key;
  if (key && typeof key === 'object' && typeof key.pubkey === 'string') return key.pubkey;
  return null;
}

function resolvedAccountKeys(transactionResult) {
  const messageKeys = transactionResult?.transaction?.message?.accountKeys || [];
  const loaded = transactionResult?.meta?.loadedAddresses || {};
  return [
    ...messageKeys.map(accountKeyString),
    ...(loaded.writable || []).map(accountKeyString),
    ...(loaded.readonly || []).map(accountKeyString),
  ].filter(Boolean);
}

function instructionProgramId(instruction, accountKeys) {
  if (typeof instruction?.programId === 'string') return instruction.programId;
  if (instruction?.programId && typeof instruction.programId?.toString === 'function') {
    const value = instruction.programId.toString();
    if (value && value !== '[object Object]') return value;
  }
  if (Number.isSafeInteger(instruction?.programIdIndex)) return accountKeys[instruction.programIdIndex] || null;
  return null;
}

export function executedProgramIds(transactionResult) {
  const accountKeys = resolvedAccountKeys(transactionResult);
  const ids = new Set();
  const topLevel = transactionResult?.transaction?.message?.instructions || [];
  for (const instruction of topLevel) {
    const id = instructionProgramId(instruction, accountKeys);
    if (id) ids.add(id);
  }
  for (const group of transactionResult?.meta?.innerInstructions || []) {
    for (const instruction of group?.instructions || []) {
      const id = instructionProgramId(instruction, accountKeys);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

function validateRpcResult(result, name) {
  if (result === undefined) throw new Error(`rpc_${name}_missing_result`);
  return result;
}

export async function captureFinalizedFixture({
  rpcCall,
  signature,
  dex,
  version,
  programId,
  expected = 'EVENT',
  endpointLabel = 'solana-rpc',
} = {}) {
  if (typeof rpcCall !== 'function') throw new Error('rpc_call_required');
  const normalizedSignature = base58Bytes(signature, 64, 'solana_signature');
  const normalizedProgramId = base58Bytes(programId, 32, 'program_id');
  const normalizedDex = text(dex, 'dex', 3, 20).toLowerCase();
  if (!REQUIRED_DEX.has(normalizedDex)) throw new Error('unsupported_fixture_dex');
  const normalizedVersion = normalizeVersion(version);
  const normalizedExpected = text(expected, 'expected', 5, 6).toUpperCase();
  if (!EXPECTED.has(normalizedExpected)) throw new Error('invalid_fixture_expected');
  const normalizedEndpointLabel = normalizeEndpointLabel(endpointLabel);

  const statusResult = validateRpcResult(await rpcCall('getSignatureStatuses', [
    [normalizedSignature],
    { searchTransactionHistory: true },
  ]), 'signature_status');
  const status = statusResult?.value?.[0];
  if (!status) throw new Error('signature_status_not_found');
  if (status.confirmationStatus !== 'finalized') throw new Error('transaction_not_finalized');
  if (status.err !== null) throw new Error('transaction_failed_onchain');

  const transactionResult = validateRpcResult(await rpcCall('getTransaction', [
    normalizedSignature,
    { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ]), 'transaction');
  if (!transactionResult || typeof transactionResult !== 'object') throw new Error('finalized_transaction_not_found');
  if (!Number.isSafeInteger(transactionResult.slot) || transactionResult.slot <= 0) throw new Error('invalid_transaction_slot');
  if (!Number.isSafeInteger(transactionResult.blockTime) || transactionResult.blockTime <= 0) throw new Error('invalid_transaction_block_time');
  if (!transactionResult.meta || transactionResult.meta.err !== null) throw new Error('transaction_meta_not_successful');

  const programIds = executedProgramIds(transactionResult);
  if (!programIds.includes(normalizedProgramId)) throw new Error('required_dex_program_not_executed');

  const evidence = {
    capture_schema_version: 1,
    capture_kind: 'SOLANA_FINALIZED_TRANSACTION',
    fixture_class: 'VERIFIED_ONCHAIN',
    review_state: 'RAW_CAPTURE',
    countable_for_live_manifest: false,
    expected: normalizedExpected,
    dex: normalizedDex,
    version: normalizedVersion,
    program_id: normalizedProgramId,
    program_execution_proven: true,
    signature: normalizedSignature,
    slot: transactionResult.slot,
    block_time: transactionResult.blockTime,
    commitment: 'finalized',
    rpc_endpoint_label: normalizedEndpointLabel,
    executed_program_ids: programIds,
    transaction: transactionResult,
    safety: {
      network_read_only: true,
      network_submission: false,
      signer_used: false,
      live_execution_authorized: false,
    },
  };

  const evidenceSha256 = crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex');
  return { ...evidence, evidence_sha256: evidenceSha256 };
}
