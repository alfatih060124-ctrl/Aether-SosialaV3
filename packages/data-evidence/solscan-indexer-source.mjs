import crypto from 'node:crypto';

const SOLSCAN_ACCOUNT_TX_URL = 'https://pro-api.solscan.io/v2.0/account/transactions';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const ALLOWED_LIMITS = new Set([10, 20, 30, 40]);
const TX_STATUSES = new Set(['Success', 'Fail']);

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

function solanaIdentifier(value, bytes, reason) {
  const text = String(value || '').trim();
  if (!BASE58_RE.test(text) || decodedBase58ByteLength(text) !== bytes) throw new Error(reason);
  return text;
}

function safeInt(value, reason, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(reason);
  return value;
}

function normalizeStatus(value) {
  if (typeof value !== 'string' || !TX_STATUSES.has(value.trim())) throw new Error('invalid_solscan_tx_status');
  return value.trim();
}

function normalizeLimit(value) {
  if (!Number.isSafeInteger(value) || !ALLOWED_LIMITS.has(value)) throw new Error('invalid_solscan_page_limit');
  return value;
}

function normalizeMaxPages(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error('invalid_solscan_max_pages');
  return value;
}

function normalizeToken(value) {
  if (typeof value !== 'string') throw new Error('solscan_api_token_required');
  const token = value.trim();
  if (!token || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) throw new Error('solscan_api_token_required');
  return token;
}

function canonicalTransactions(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid_solscan_transaction_rows');
  const deduped = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid_solscan_transaction_row');
    const tx = {
      tx_hash: solanaIdentifier(row.tx_hash, 64, 'invalid_solscan_tx_hash'),
      slot: safeInt(row.slot, 'invalid_solscan_slot'),
      block_time: safeInt(row.block_time, 'invalid_solscan_block_time'),
      fee_lamports: safeInt(row.fee, 'invalid_solscan_fee_lamports'),
      status: normalizeStatus(row.status)
    };
    const existing = deduped.get(tx.tx_hash);
    if (existing && JSON.stringify(existing) !== JSON.stringify(tx)) throw new Error('conflicting_solscan_duplicate_tx');
    deduped.set(tx.tx_hash, tx);
  }
  return [...deduped.values()].sort((a, b) => {
    if (a.slot !== b.slot) return b.slot - a.slot;
    if (a.block_time !== b.block_time) return b.block_time - a.block_time;
    return a.tx_hash.localeCompare(b.tx_hash);
  });
}

function sourceHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createSolscanAccountTransactionsCaller({ apiToken, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const token = normalizeToken(apiToken);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('invalid_solscan_timeout_ms');

  return async ({ address, before = null, limit = 20 }) => {
    const wallet = solanaIdentifier(address, 32, 'invalid_solana_wallet');
    const pageLimit = normalizeLimit(limit);
    const url = new URL(SOLSCAN_ACCOUNT_TX_URL);
    url.searchParams.set('address', wallet);
    url.searchParams.set('limit', String(pageLimit));
    if (before !== null) url.searchParams.set('before', solanaIdentifier(before, 64, 'invalid_solscan_before'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', token },
        signal: controller.signal
      });
      if (!response?.ok) throw new Error('solscan_http_error');
      const body = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.success !== true || !Array.isArray(body.data)) {
        throw new Error('invalid_solscan_response');
      }
      if (body.data.length > pageLimit) throw new Error('solscan_page_exceeds_requested_limit');
      return body.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('solscan_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function collectSolscanIndexerEvidence({ walletAddress, pageCall, limit = 20, maxPages = 3 } = {}) {
  const wallet = solanaIdentifier(walletAddress, 32, 'invalid_solana_wallet');
  if (typeof pageCall !== 'function') throw new Error('solscan_page_call_required');
  const pageLimit = normalizeLimit(limit);
  const pageCap = normalizeMaxPages(maxPages);
  const rows = [];
  let before = null;
  let pagesFetched = 0;
  let collectionComplete = false;

  for (let page = 0; page < pageCap; page += 1) {
    const pageRows = await pageCall({ address: wallet, before, limit: pageLimit });
    if (!Array.isArray(pageRows)) throw new Error('invalid_solscan_transaction_rows');
    if (pageRows.length > pageLimit) throw new Error('solscan_page_exceeds_requested_limit');
    pagesFetched += 1;
    rows.push(...pageRows);
    if (pageRows.length < pageLimit) {
      collectionComplete = true;
      break;
    }
    const nextBefore = solanaIdentifier(pageRows.at(-1)?.tx_hash, 64, 'invalid_solscan_tx_hash');
    if (nextBefore === before) throw new Error('solscan_pagination_stalled');
    before = nextBefore;
  }

  const transactions = canonicalTransactions(rows);
  const provenancePayload = {
    schema_version: 1,
    source_type: 'SOLSCAN_INDEXER',
    provider: 'SOLSCAN_PRO_API',
    endpoint: '/v2.0/account/transactions',
    wallet_address: wallet,
    pages_fetched: pagesFetched,
    page_limit: pageLimit,
    max_pages: pageCap,
    collection_complete: collectionComplete,
    transactions
  };
  const provenance = {
    ...provenancePayload,
    transactions_observed: transactions.length,
    successful_transactions_observed: transactions.filter(row => row.status === 'Success').length,
    failed_transactions_observed: transactions.filter(row => row.status === 'Fail').length,
    source_hash: sourceHash(provenancePayload)
  };

  return {
    collection_status: 'PENDING_DATA',
    reason: transactions.length ? 'reconciled_trade_performance_required' : 'no_verifiable_chain_activity',
    source_type: 'SOLSCAN_INDEXER',
    source_reference: transactions[0]?.tx_hash || null,
    provenance,
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false
  };
}
