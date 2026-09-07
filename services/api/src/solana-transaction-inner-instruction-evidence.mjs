import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58);
const SCHEMA = 'aether.solana_transaction_inner_instruction_evidence.v1';

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}_invalid`);
}

function canonicalIso(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name}_invalid`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${name}_invalid`);
  return { value, ms };
}

function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0 || [...text].some((ch) => !BASE58_SET.has(ch))) throw new Error('base58_invalid');
  let bytes = [0];
  for (const ch of text) {
    let carry = BASE58.indexOf(ch);
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length - 1 && text[zeros] === '1') zeros += 1;
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes.reverse()]);
}

function canonicalSolanaKey(value, name, bytes) {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error(`${name}_invalid`);
  let decoded;
  try { decoded = decodeBase58(value); } catch { throw new Error(`${name}_invalid`); }
  if (decoded.length !== bytes) throw new Error(`${name}_invalid`);
  return value;
}

function canonicalEndpointLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('rpc_endpoint_label_invalid');
  return value;
}

function canonicalSafeInteger(value, name, { nullable = false, min = 0 } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name}_invalid`);
  return value;
}

function canonicalJson(value, name, depth = 0) {
  if (depth > 20) throw new Error(`${name}_invalid`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${name}_invalid`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, name, depth + 1));
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 128) throw new Error(`${name}_invalid`);
      out[key] = canonicalJson(value[key], name, depth + 1);
    }
    return out;
  }
  throw new Error(`${name}_invalid`);
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalInstructionData(value) {
  if (typeof value !== 'string' || value.length > 8192 || [...value].some((ch) => !BASE58_SET.has(ch))) throw new Error('inner_instruction_data_invalid');
  return value;
}

function canonicalAccountKeys(message, meta) {
  assertObject(message, 'transaction_message');
  if (!Array.isArray(message.accountKeys) || message.accountKeys.length === 0) throw new Error('transaction_account_keys_invalid');
  const staticKeys = message.accountKeys.map((key) => canonicalSolanaKey(key, 'account_key', 32));

  const loaded = meta?.loadedAddresses ?? { writable: [], readonly: [] };
  assertObject(loaded, 'loaded_addresses');
  if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)) throw new Error('loaded_addresses_invalid');
  const writable = loaded.writable.map((key) => canonicalSolanaKey(key, 'loaded_writable_key', 32));
  const readonly = loaded.readonly.map((key) => canonicalSolanaKey(key, 'loaded_readonly_key', 32));
  const combined = [...staticKeys, ...writable, ...readonly];
  if (new Set(combined).size !== combined.length) throw new Error('transaction_account_keys_duplicate');
  return { staticKeys, writable, readonly, combined };
}

function canonicalInnerTopology(innerInstructions, outerInstructionCount, combinedKeys) {
  if (innerInstructions === null || innerInstructions === undefined) return [];
  if (!Array.isArray(innerInstructions)) throw new Error('inner_instructions_invalid');
  let previousOuter = -1;
  return innerInstructions.map((group) => {
    assertObject(group, 'inner_instruction_group');
    const outerIndex = canonicalSafeInteger(group.index, 'inner_outer_index');
    if (outerIndex >= outerInstructionCount || outerIndex <= previousOuter) throw new Error('inner_outer_index_invalid');
    previousOuter = outerIndex;
    if (!Array.isArray(group.instructions) || group.instructions.length === 0) throw new Error('inner_instruction_group_empty');
    const instructions = group.instructions.map((instruction, innerIndex) => {
      assertObject(instruction, 'inner_instruction');
      const programIdIndex = canonicalSafeInteger(instruction.programIdIndex, 'inner_program_id_index');
      if (programIdIndex >= combinedKeys.length) throw new Error('inner_program_id_index_invalid');
      if (!Array.isArray(instruction.accounts)) throw new Error('inner_instruction_accounts_invalid');
      const accounts = instruction.accounts.map((accountIndex) => {
        const index = canonicalSafeInteger(accountIndex, 'inner_account_index');
        if (index >= combinedKeys.length) throw new Error('inner_account_index_invalid');
        return index;
      });
      const data = canonicalInstructionData(instruction.data);
      const stackHeight = instruction.stackHeight === undefined || instruction.stackHeight === null
        ? null
        : canonicalSafeInteger(instruction.stackHeight, 'inner_stack_height', { min: 1 });
      return {
        inner_index: innerIndex,
        program_id_index: programIdIndex,
        program_id: combinedKeys[programIdIndex],
        account_indexes: accounts,
        data_hash: createHash('sha256').update(data).digest('hex'),
        stack_height: stackHeight,
      };
    });
    return { outer_index: outerIndex, instructions };
  });
}

function basePending() {
  return {
    collection_status: 'PENDING_DATA',
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    reconciliation_required: true,
  };
}

export async function collectSolanaTransactionInnerInstructionEvidence({
  rpc_url,
  rpc_endpoint_label,
  signature,
  trader_wallet,
  commitment = 'confirmed',
  request_started_at,
  observed_at,
  fetch_fn = globalThis.fetch,
} = {}) {
  if (typeof rpc_url !== 'string' || !/^https:\/\//.test(rpc_url)) throw new Error('rpc_url_invalid');
  const endpointLabel = canonicalEndpointLabel(rpc_endpoint_label);
  const requestedSignature = canonicalSolanaKey(signature, 'signature', 64);
  const wallet = canonicalSolanaKey(trader_wallet, 'trader_wallet', 32);
  if (!['confirmed', 'finalized'].includes(commitment)) throw new Error('commitment_invalid');
  const started = canonicalIso(request_started_at, 'request_started_at');
  const observed = canonicalIso(observed_at, 'observed_at');
  if (observed.ms < started.ms) throw new Error('observation_before_request');
  if (typeof fetch_fn !== 'function') throw new Error('fetch_fn_invalid');

  const response = await fetch_fn(rpc_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [requestedSignature, { encoding: 'json', commitment, maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!response?.ok) throw new Error('solana_rpc_http_error');
  const payload = await response.json();
  if (payload?.error) throw new Error('solana_rpc_error');
  if (!Object.prototype.hasOwnProperty.call(payload ?? {}, 'result')) throw new Error('solana_rpc_response_invalid');

  if (payload.result === null) {
    const provenance = {
      schema: SCHEMA,
      requested_signature: requestedSignature,
      requested_wallet: wallet,
      rpc_endpoint_label: endpointLabel,
      commitment,
      request_started_at: started.value,
      observed_at: observed.value,
      found: false,
      cpi_available: false,
      slot: null,
      block_time: null,
      transaction_error: null,
      static_account_count: 0,
      loaded_writable_count: 0,
      loaded_readonly_count: 0,
      combined_account_keys: [],
      inner_topology: [],
      source_reference: null,
    };
    return { ...basePending(), source_reference: null, source_hash: hashJson(provenance), inner_program_ids: [], provenance };
  }

  assertObject(payload.result, 'transaction_result');
  const slot = canonicalSafeInteger(payload.result.slot, 'slot');
  const blockTime = canonicalSafeInteger(payload.result.blockTime, 'block_time', { nullable: true });
  if (blockTime !== null && blockTime * 1000 > observed.ms) throw new Error('transaction_block_time_after_observation');
  assertObject(payload.result.transaction, 'transaction');
  const signatures = payload.result.transaction.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) throw new Error('transaction_signatures_invalid');
  const primarySignature = canonicalSolanaKey(signatures[0], 'returned_signature', 64);
  if (primarySignature !== requestedSignature) throw new Error('returned_signature_mismatch');
  assertObject(payload.result.transaction.message, 'transaction_message');
  if (!Array.isArray(payload.result.transaction.message.instructions)) throw new Error('outer_instructions_invalid');
  assertObject(payload.result.meta, 'transaction_meta');

  const keys = canonicalAccountKeys(payload.result.transaction.message, payload.result.meta);
  if (!keys.combined.includes(wallet)) throw new Error('trader_wallet_not_in_transaction');
  const topology = canonicalInnerTopology(payload.result.meta.innerInstructions, payload.result.transaction.message.instructions.length, keys.combined);
  const cpiAvailable = topology.length > 0;
  const sourceReference = cpiAvailable ? `solana_rpc:${requestedSignature}@${slot}` : null;
  const innerProgramIds = [...new Set(topology.flatMap((group) => group.instructions.map((instruction) => instruction.program_id)))].sort();
  const provenance = {
    schema: SCHEMA,
    requested_signature: requestedSignature,
    requested_wallet: wallet,
    rpc_endpoint_label: endpointLabel,
    commitment,
    request_started_at: started.value,
    observed_at: observed.value,
    found: true,
    cpi_available: cpiAvailable,
    slot,
    block_time: blockTime,
    transaction_error: canonicalJson(payload.result.meta.err, 'transaction_error'),
    static_account_count: keys.staticKeys.length,
    loaded_writable_count: keys.writable.length,
    loaded_readonly_count: keys.readonly.length,
    combined_account_keys: keys.combined,
    inner_topology: topology,
    source_reference: sourceReference,
  };
  return {
    ...basePending(),
    source_reference: sourceReference,
    source_hash: hashJson(provenance),
    inner_program_ids: innerProgramIds,
    provenance,
  };
}

export function verifySolanaTransactionInnerInstructionEvidence(evidence) {
  try {
    assertObject(evidence, 'evidence');
    if (evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false || evidence.reconciliation_required !== true) return false;
    for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) if (evidence[key] !== null) return false;
    assertObject(evidence.provenance, 'provenance');
    const p = evidence.provenance;
    if (p.schema !== SCHEMA) return false;
    canonicalSolanaKey(p.requested_signature, 'requested_signature', 64);
    canonicalSolanaKey(p.requested_wallet, 'requested_wallet', 32);
    canonicalEndpointLabel(p.rpc_endpoint_label);
    if (!['confirmed', 'finalized'].includes(p.commitment)) return false;
    const started = canonicalIso(p.request_started_at, 'request_started_at');
    const observed = canonicalIso(p.observed_at, 'observed_at');
    if (observed.ms < started.ms || typeof p.found !== 'boolean' || typeof p.cpi_available !== 'boolean') return false;
    canonicalJson(p.transaction_error, 'transaction_error');
    if (!Array.isArray(p.combined_account_keys) || !Array.isArray(p.inner_topology) || !Array.isArray(evidence.inner_program_ids)) return false;

    if (!p.found) {
      if (p.cpi_available || p.slot !== null || p.block_time !== null || p.transaction_error !== null || p.static_account_count !== 0 || p.loaded_writable_count !== 0 || p.loaded_readonly_count !== 0 || p.combined_account_keys.length !== 0 || p.inner_topology.length !== 0 || p.source_reference !== null || evidence.source_reference !== null || evidence.inner_program_ids.length !== 0) return false;
    } else {
      const slot = canonicalSafeInteger(p.slot, 'slot');
      const blockTime = canonicalSafeInteger(p.block_time, 'block_time', { nullable: true });
      if (blockTime !== null && blockTime * 1000 > observed.ms) return false;
      const staticCount = canonicalSafeInteger(p.static_account_count, 'static_account_count');
      const writableCount = canonicalSafeInteger(p.loaded_writable_count, 'loaded_writable_count');
      const readonlyCount = canonicalSafeInteger(p.loaded_readonly_count, 'loaded_readonly_count');
      if (staticCount + writableCount + readonlyCount !== p.combined_account_keys.length || staticCount === 0) return false;
      const keys = p.combined_account_keys.map((key) => canonicalSolanaKey(key, 'combined_account_key', 32));
      if (new Set(keys).size !== keys.length || !keys.includes(p.requested_wallet)) return false;
      let previousOuter = -1;
      const programIds = [];
      for (const group of p.inner_topology) {
        assertObject(group, 'inner_instruction_group');
        const outerIndex = canonicalSafeInteger(group.outer_index, 'inner_outer_index');
        if (outerIndex <= previousOuter || !Array.isArray(group.instructions) || group.instructions.length === 0) return false;
        previousOuter = outerIndex;
        for (let i = 0; i < group.instructions.length; i += 1) {
          const instruction = group.instructions[i];
          assertObject(instruction, 'inner_instruction');
          if (instruction.inner_index !== i) return false;
          const programIdIndex = canonicalSafeInteger(instruction.program_id_index, 'inner_program_id_index');
          if (programIdIndex >= keys.length || instruction.program_id !== keys[programIdIndex]) return false;
          canonicalSolanaKey(instruction.program_id, 'inner_program_id', 32);
          if (!Array.isArray(instruction.account_indexes) || instruction.account_indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= keys.length)) return false;
          if (typeof instruction.data_hash !== 'string' || !/^[0-9a-f]{64}$/.test(instruction.data_hash)) return false;
          if (instruction.stack_height !== null) canonicalSafeInteger(instruction.stack_height, 'inner_stack_height', { min: 1 });
          programIds.push(instruction.program_id);
        }
      }
      const normalizedPrograms = [...new Set(programIds)].sort();
      if (JSON.stringify(normalizedPrograms) !== JSON.stringify(evidence.inner_program_ids)) return false;
      if (p.cpi_available !== (p.inner_topology.length > 0)) return false;
      const expectedRef = p.cpi_available ? `solana_rpc:${p.requested_signature}@${slot}` : null;
      if (p.source_reference !== expectedRef || evidence.source_reference !== expectedRef) return false;
    }
    return typeof evidence.source_hash === 'string' && evidence.source_hash === hashJson(p);
  } catch {
    return false;
  }
}
