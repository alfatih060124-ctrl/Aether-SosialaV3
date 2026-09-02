import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const U64_MAX = 18446744073709551615n;
const COMMITMENTS = new Set(['confirmed', 'finalized']);

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

function canonicalBase58(value, name, bytes) {
  if (typeof value !== 'string' || value !== value.trim() || !BASE58_RE.test(value)) throw new Error(`invalid_${name}`);
  if (decodedBase58ByteLength(value) !== bytes) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalSignature(value) {
  return canonicalBase58(value, 'solana_signature', 64);
}

function canonicalWallet(value) {
  return canonicalBase58(value, 'solana_wallet', 32);
}

function canonicalMint(value) {
  return canonicalBase58(value, 'solana_mint', 32);
}

function canonicalTimestamp(value, name) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalEndpointLabel(value) {
  if (value === undefined) return 'solana-rpc';
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('invalid_rpc_endpoint_label');
  return value;
}

function canonicalCommitment(value) {
  if (typeof value !== 'string' || !COMMITMENTS.has(value)) throw new Error('invalid_rpc_commitment');
  return value;
}

function safeInteger(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}

function canonicalRawAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid_token_raw_amount');
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error('invalid_token_raw_amount');
  return parsed.toString();
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeTokenBalances(rows, requestedWallet, side) {
  if (!Array.isArray(rows) || rows.length > 512) throw new Error(`invalid_${side}_token_balances`);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`invalid_${side}_token_balance_${index}`);
    const accountIndex = safeInteger(row.accountIndex, `${side}_token_account_index`);
    const mint = canonicalMint(row.mint);
    const owner = canonicalWallet(row.owner);
    const decimals = safeInteger(row.uiTokenAmount?.decimals, `${side}_token_decimals`);
    if (decimals > 255) throw new Error(`invalid_${side}_token_decimals`);
    const amountRaw = canonicalRawAmount(row.uiTokenAmount?.amount);
    const key = `${accountIndex}:${mint}`;
    if (seen.has(key)) throw new Error(`duplicate_${side}_token_balance`);
    seen.add(key);
    normalized.push({ account_index: accountIndex, mint, owner, decimals, amount_raw: amountRaw });
  }
  normalized.sort((a, b) => a.account_index - b.account_index || a.mint.localeCompare(b.mint));
  return normalized.filter((row) => row.owner === requestedWallet);
}

function buildWalletDeltas(preRows, postRows) {
  const entries = new Map();
  for (const row of preRows) entries.set(`${row.account_index}:${row.mint}`, { pre: row, post: null });
  for (const row of postRows) {
    const key = `${row.account_index}:${row.mint}`;
    const existing = entries.get(key);
    if (existing) existing.post = row;
    else entries.set(key, { pre: null, post: row });
  }

  const deltas = [];
  for (const { pre, post } of entries.values()) {
    const row = post ?? pre;
    if (pre && post) {
      if (pre.owner !== post.owner || pre.mint !== post.mint || pre.decimals !== post.decimals) throw new Error('token_balance_identity_changed');
    }
    const preRaw = BigInt(pre?.amount_raw ?? '0');
    const postRaw = BigInt(post?.amount_raw ?? '0');
    deltas.push({
      account_index: row.account_index,
      mint: row.mint,
      owner: row.owner,
      decimals: row.decimals,
      pre_amount_raw: preRaw.toString(),
      post_amount_raw: postRaw.toString(),
      delta_raw: (postRaw - preRaw).toString()
    });
  }
  deltas.sort((a, b) => a.account_index - b.account_index || a.mint.localeCompare(b.mint));
  return deltas;
}

function pendingBoundary(reason, provenance, sourceReference = null) {
  return {
    collection_status: 'PENDING_DATA',
    reason,
    source_type: 'SOLANA_RPC',
    source_reference: sourceReference,
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance
  };
}

function buildProvenance(payload) {
  const provenance = structuredClone(payload);
  provenance.source_hash = hash(payload);
  return provenance;
}

export async function collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress,
  rpcCall,
  commitment = 'finalized',
  endpointLabel = 'solana-rpc',
  clock = () => new Date().toISOString()
} = {}) {
  const requestedSignature = canonicalSignature(signature);
  const requestedWallet = canonicalWallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('clock_required');
  const normalizedCommitment = canonicalCommitment(commitment);
  const normalizedEndpoint = canonicalEndpointLabel(endpointLabel);
  const requestStartedAt = canonicalTimestamp(clock(), 'request_started_at');

  const response = await rpcCall('getTransaction', [requestedSignature, {
    commitment: normalizedCommitment,
    encoding: 'jsonParsed',
    maxSupportedTransactionVersion: 0
  }]);
  const observedAt = canonicalTimestamp(clock(), 'observed_at');
  if (Date.parse(observedAt) < Date.parse(requestStartedAt)) throw new Error('rpc_observed_before_request');

  const common = {
    schema_version: 1,
    source_type: 'SOLANA_RPC',
    rpc_method: 'getTransaction',
    rpc_endpoint_label: normalizedEndpoint,
    rpc_commitment: normalizedCommitment,
    request_started_at: requestStartedAt,
    observed_at: observedAt,
    requested_signature: requestedSignature,
    requested_wallet: requestedWallet
  };

  if (response === null) {
    return pendingBoundary('transaction_not_found_at_requested_commitment', buildProvenance({ ...common, transaction_found: false }), null);
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_rpc_transaction_response');

  const slot = safeInteger(response.slot, 'rpc_slot');
  const blockTime = safeInteger(response.blockTime, 'rpc_block_time', { nullable: true });
  if (blockTime !== null && Date.parse(observedAt) < blockTime * 1000) throw new Error('rpc_observed_before_block_time');

  const signatures = response.transaction?.signatures;
  if (!Array.isArray(signatures) || signatures.length < 1) throw new Error('invalid_rpc_transaction_signatures');
  const returnedSignature = canonicalSignature(signatures[0]);
  if (returnedSignature !== requestedSignature) throw new Error('rpc_transaction_signature_mismatch');

  const err = response.meta?.err ?? null;
  if (err !== null) {
    const provenance = buildProvenance({
      ...common,
      transaction_found: true,
      slot,
      block_time: blockTime,
      transaction_succeeded: false,
      error_hash: hash(err)
    });
    return pendingBoundary('failed_transaction_not_trade_evidence', provenance, `solana_rpc:${returnedSignature}@${slot}`);
  }

  const preWalletBalances = normalizeTokenBalances(response.meta?.preTokenBalances, requestedWallet, 'pre');
  const postWalletBalances = normalizeTokenBalances(response.meta?.postTokenBalances, requestedWallet, 'post');
  const walletDeltas = buildWalletDeltas(preWalletBalances, postWalletBalances);
  const sourceReference = `solana_rpc:${returnedSignature}@${slot}`;
  const provenance = buildProvenance({
    ...common,
    transaction_found: true,
    transaction_succeeded: true,
    source_reference: sourceReference,
    slot,
    block_time: blockTime,
    pre_wallet_token_balances: preWalletBalances,
    post_wallet_token_balances: postWalletBalances,
    wallet_token_deltas: walletDeltas
  });

  const reason = walletDeltas.length === 0
    ? 'no_wallet_token_balance_evidence'
    : 'wallet_token_balance_evidence_reconciliation_required';
  return pendingBoundary(reason, provenance, sourceReference);
}

export function verifySolanaTokenBalanceEvidence(evidence) {
  try {
    if (!evidence || evidence.collection_status !== 'PENDING_DATA' || evidence.source_type !== 'SOLANA_RPC') return false;
    if (evidence.metrics_available !== false || evidence.trades_count !== null || evidence.total_return_bps !== null || evidence.win_rate_bps !== null || evidence.drawdown_bps !== null || evidence.reputation_score !== null) return false;
    if (evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) return false;
    const provenance = evidence.provenance;
    if (!provenance || typeof provenance !== 'object') return false;
    const suppliedHash = provenance.source_hash;
    if (typeof suppliedHash !== 'string' || !/^[0-9a-f]{64}$/.test(suppliedHash)) return false;
    const payload = structuredClone(provenance);
    delete payload.source_hash;
    if (hash(payload) !== suppliedHash) return false;
    canonicalSignature(provenance.requested_signature);
    canonicalWallet(provenance.requested_wallet);
    canonicalEndpointLabel(provenance.rpc_endpoint_label);
    canonicalCommitment(provenance.rpc_commitment);
    canonicalTimestamp(provenance.request_started_at, 'request_started_at');
    canonicalTimestamp(provenance.observed_at, 'observed_at');
    if (Date.parse(provenance.observed_at) < Date.parse(provenance.request_started_at)) return false;
    if (provenance.transaction_found === false) return evidence.source_reference === null;
    const slot = safeInteger(provenance.slot, 'rpc_slot');
    if (provenance.source_reference !== undefined && provenance.source_reference !== `solana_rpc:${provenance.requested_signature}@${slot}`) return false;
    if (evidence.source_reference !== null && evidence.source_reference !== `solana_rpc:${provenance.requested_signature}@${slot}`) return false;
    if (provenance.transaction_succeeded === true) {
      const pre = normalizeTokenBalances(provenance.pre_wallet_token_balances.map((row) => ({ accountIndex: row.account_index, mint: row.mint, owner: row.owner, uiTokenAmount: { decimals: row.decimals, amount: row.amount_raw } })), provenance.requested_wallet, 'pre');
      const post = normalizeTokenBalances(provenance.post_wallet_token_balances.map((row) => ({ accountIndex: row.account_index, mint: row.mint, owner: row.owner, uiTokenAmount: { decimals: row.decimals, amount: row.amount_raw } })), provenance.requested_wallet, 'post');
      if (JSON.stringify(buildWalletDeltas(pre, post)) !== JSON.stringify(provenance.wallet_token_deltas)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
