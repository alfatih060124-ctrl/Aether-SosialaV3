import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const U64_MAX = 18446744073709551615n;
const COMMITMENTS = new Set(['confirmed', 'finalized']);

function decodedLength(value) {
  let n = 0n;
  for (const char of value) {
    const digit = B58.indexOf(char);
    if (digit < 0) return -1;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let current = n; current > 0n; current >>= 8n) bytes += 1;
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros += 1;
  return zeros + bytes;
}

function canonicalBase58(value, name, bytes) {
  if (typeof value !== 'string' || value !== value.trim() || !B58_RE.test(value) || decodedLength(value) !== bytes) throw new Error(`invalid_${name}`);
  return value;
}
const signature = (v) => canonicalBase58(v, 'solana_signature', 64);
const wallet = (v) => canonicalBase58(v, 'solana_wallet', 32);
const mint = (v) => canonicalBase58(v, 'solana_mint', 32);

function timestamp(value, name) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`invalid_${name}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid_${name}`);
  return value;
}
function endpoint(value = 'solana-rpc') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('invalid_rpc_endpoint_label');
  return value;
}
function commitment(value) {
  if (typeof value !== 'string' || !COMMITMENTS.has(value)) throw new Error('invalid_rpc_commitment');
  return value;
}
function safeInt(value, name, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}
function rawAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid_token_raw_amount');
  const n = BigInt(value);
  if (n > U64_MAX) throw new Error('invalid_token_raw_amount');
  return n.toString();
}
function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeBalances(rows, requestedWallet, side) {
  if (!Array.isArray(rows) || rows.length > 512) throw new Error(`invalid_${side}_token_balances`);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`invalid_${side}_token_balance_${i}`);
    const accountIndex = safeInt(row.accountIndex, `${side}_token_account_index`);
    const normalized = {
      account_index: accountIndex,
      mint: mint(row.mint),
      owner: wallet(row.owner),
      decimals: safeInt(row.uiTokenAmount?.decimals, `${side}_token_decimals`),
      amount_raw: rawAmount(row.uiTokenAmount?.amount)
    };
    if (normalized.decimals > 255) throw new Error(`invalid_${side}_token_decimals`);
    if (seen.has(accountIndex)) throw new Error(`duplicate_${side}_token_account_index`);
    seen.add(accountIndex);
    if (normalized.owner === requestedWallet) out.push(normalized);
  }
  out.sort((a, b) => a.account_index - b.account_index);
  return out;
}

function buildDeltas(preRows, postRows) {
  const preByIndex = new Map(preRows.map((row) => [row.account_index, row]));
  const postByIndex = new Map(postRows.map((row) => [row.account_index, row]));
  const indices = [...new Set([...preByIndex.keys(), ...postByIndex.keys()])].sort((a, b) => a - b);
  return indices.map((index) => {
    const pre = preByIndex.get(index) ?? null;
    const post = postByIndex.get(index) ?? null;
    if (pre && post && (pre.owner !== post.owner || pre.mint !== post.mint || pre.decimals !== post.decimals)) throw new Error('token_balance_identity_changed');
    const row = post ?? pre;
    const preRaw = BigInt(pre?.amount_raw ?? '0');
    const postRaw = BigInt(post?.amount_raw ?? '0');
    return {
      account_index: index,
      mint: row.mint,
      owner: row.owner,
      decimals: row.decimals,
      pre_amount_raw: preRaw.toString(),
      post_amount_raw: postRaw.toString(),
      delta_raw: (postRaw - preRaw).toString()
    };
  });
}

function pending(reason, provenance, sourceReference = null) {
  return {
    collection_status: 'PENDING_DATA', reason, source_type: 'SOLANA_RPC', source_reference: sourceReference,
    metrics_available: false, trades_count: null, total_return_bps: null, win_rate_bps: null,
    drawdown_bps: null, reputation_score: null, verified: false, published: false,
    live_execution_authorized: false, provenance
  };
}
function provenance(payload) {
  const out = structuredClone(payload);
  out.source_hash = digest(payload);
  return out;
}

export async function collectSolanaTokenBalanceEvidence({
  signature: requestedSignatureInput,
  walletAddress,
  rpcCall,
  commitment: requestedCommitment = 'finalized',
  endpointLabel = 'solana-rpc',
  clock = () => new Date().toISOString()
} = {}) {
  const requestedSignature = signature(requestedSignatureInput);
  const requestedWallet = wallet(walletAddress);
  if (typeof rpcCall !== 'function') throw new Error('solana_rpc_call_required');
  if (typeof clock !== 'function') throw new Error('clock_required');
  const rpcCommitment = commitment(requestedCommitment);
  const rpcEndpointLabel = endpoint(endpointLabel);
  const requestStartedAt = timestamp(clock(), 'request_started_at');
  const response = await rpcCall('getTransaction', [requestedSignature, {
    commitment: rpcCommitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0
  }]);
  const observedAt = timestamp(clock(), 'observed_at');
  if (Date.parse(observedAt) < Date.parse(requestStartedAt)) throw new Error('rpc_observed_before_request');

  const common = {
    schema_version: 1, source_type: 'SOLANA_RPC', rpc_method: 'getTransaction',
    rpc_endpoint_label: rpcEndpointLabel, rpc_commitment: rpcCommitment,
    request_started_at: requestStartedAt, observed_at: observedAt,
    requested_signature: requestedSignature, requested_wallet: requestedWallet
  };
  if (response === null) return pending('transaction_not_found_at_requested_commitment', provenance({ ...common, transaction_found: false }), null);
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_rpc_transaction_response');

  const slot = safeInt(response.slot, 'rpc_slot');
  const blockTime = safeInt(response.blockTime, 'rpc_block_time', true);
  if (blockTime !== null && Date.parse(observedAt) < blockTime * 1000) throw new Error('rpc_observed_before_block_time');
  const signatures = response.transaction?.signatures;
  if (!Array.isArray(signatures) || signatures.length < 1) throw new Error('invalid_rpc_transaction_signatures');
  const returnedSignature = signature(signatures[0]);
  if (returnedSignature !== requestedSignature) throw new Error('rpc_transaction_signature_mismatch');
  const sourceReference = `solana_rpc:${returnedSignature}@${slot}`;

  if ((response.meta?.err ?? null) !== null) {
    return pending('failed_transaction_not_trade_evidence', provenance({
      ...common, transaction_found: true, transaction_succeeded: false, slot, block_time: blockTime,
      source_reference: sourceReference, error_hash: digest(response.meta.err)
    }), sourceReference);
  }

  const pre = normalizeBalances(response.meta?.preTokenBalances, requestedWallet, 'pre');
  const post = normalizeBalances(response.meta?.postTokenBalances, requestedWallet, 'post');
  const deltas = buildDeltas(pre, post);
  const proof = provenance({
    ...common, transaction_found: true, transaction_succeeded: true, source_reference: sourceReference,
    slot, block_time: blockTime, pre_wallet_token_balances: pre,
    post_wallet_token_balances: post, wallet_token_deltas: deltas
  });
  return pending(deltas.length === 0 ? 'no_wallet_token_balance_evidence' : 'wallet_token_balance_evidence_reconciliation_required', proof, sourceReference);
}

export function verifySolanaTokenBalanceEvidence(evidence) {
  try {
    if (!evidence || evidence.collection_status !== 'PENDING_DATA' || evidence.source_type !== 'SOLANA_RPC') return false;
    if (evidence.metrics_available !== false || evidence.trades_count !== null || evidence.total_return_bps !== null || evidence.win_rate_bps !== null || evidence.drawdown_bps !== null || evidence.reputation_score !== null) return false;
    if (evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) return false;
    const p = evidence.provenance;
    if (!p || typeof p !== 'object' || typeof p.source_hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.source_hash)) return false;
    const payload = structuredClone(p);
    delete payload.source_hash;
    if (digest(payload) !== p.source_hash) return false;
    signature(p.requested_signature); wallet(p.requested_wallet); endpoint(p.rpc_endpoint_label); commitment(p.rpc_commitment);
    timestamp(p.request_started_at, 'request_started_at'); timestamp(p.observed_at, 'observed_at');
    if (Date.parse(p.observed_at) < Date.parse(p.request_started_at)) return false;
    if (p.transaction_found === false) return evidence.source_reference === null;
    const slot = safeInt(p.slot, 'rpc_slot');
    const canonicalRef = `solana_rpc:${p.requested_signature}@${slot}`;
    if (p.source_reference !== canonicalRef || evidence.source_reference !== canonicalRef) return false;
    if (p.transaction_succeeded === true) {
      const toRpcRows = (rows) => rows.map((row) => ({ accountIndex: row.account_index, mint: row.mint, owner: row.owner, uiTokenAmount: { decimals: row.decimals, amount: row.amount_raw } }));
      const pre = normalizeBalances(toRpcRows(p.pre_wallet_token_balances), p.requested_wallet, 'pre');
      const post = normalizeBalances(toRpcRows(p.post_wallet_token_balances), p.requested_wallet, 'post');
      if (JSON.stringify(buildDeltas(pre, post)) !== JSON.stringify(p.wallet_token_deltas)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
