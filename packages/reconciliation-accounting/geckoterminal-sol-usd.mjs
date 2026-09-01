import crypto from 'node:crypto';

const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';
const API_VERSION = '20230203';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CANDLE_SECONDS = 60;

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

function address(value, name) {
  const v = String(value ?? '').trim();
  if (!BASE58.test(v) || decodedBase58ByteLength(v) !== 32) throw new Error(`invalid_${name}`);
  return v;
}

function safeInt(value, name, min = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`invalid_${name}`);
  return n;
}

function iso(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_${name}`);
  return new Date(ms).toISOString();
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${name}`);
  return n;
}

function usdToMicroHalfUp(value) {
  const n = positiveNumber(value, 'sol_usd_price');
  const scaled = n * 1_000_000;
  if (!Number.isSafeInteger(Math.round(scaled))) throw new Error('sol_usd_price_overflow');
  return Math.round(scaled);
}

function tokenRelation(pool, side) {
  return pool?.relationships?.[`${side}_token`]?.data?.id || null;
}

function resolveSolSide(pool) {
  const target = `solana_${WSOL_MINT}`;
  const base = tokenRelation(pool, 'base');
  const quote = tokenRelation(pool, 'quote');
  if (base === target && quote === target) throw new Error('geckoterminal_pool_ambiguous_sol_side');
  if (base === target) return 'base';
  if (quote === target) return 'quote';
  throw new Error('geckoterminal_pool_missing_wsol');
}

function normalizeCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const timestamp = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  if (![open, high, low, close].every(v => Number.isFinite(v) && v > 0)) return null;
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { timestamp, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : null };
}

function selectCandle(rows, transactionBlockTimeUnix) {
  const candidates = (Array.isArray(rows) ? rows : []).map(normalizeCandle).filter(Boolean);
  const matching = candidates.filter(row => row.timestamp <= transactionBlockTimeUnix && transactionBlockTimeUnix < row.timestamp + CANDLE_SECONDS);
  if (matching.length !== 1) throw new Error(matching.length ? 'geckoterminal_candle_ambiguous' : 'geckoterminal_candle_not_found');
  return matching[0];
}

async function getJson(fetchImpl, path, timeoutMs) {
  const url = new URL(path, PROVIDER_ORIGIN);
  if (url.origin !== PROVIDER_ORIGIN) throw new Error('geckoterminal_target_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15_000, Number(timeoutMs) || 6000)));
  try {
    const response = await fetchImpl(url, {
      headers: { accept: `application/json;version=${API_VERSION}` },
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status === 404) throw new Error('geckoterminal_pool_or_candle_not_found');
    if (response.status === 429) throw new Error('geckoterminal_rate_limited');
    if (!response.ok) throw new Error('geckoterminal_unavailable');
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('invalid_geckoterminal_payload');
    return { body, url: url.toString() };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('geckoterminal_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectHistoricalSolUsdSnapshot({
  poolAddress,
  anchorSlot,
  transactionBlockTimeUnix,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
  clock = () => new Date()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('geckoterminal_fetch_required');
  if (typeof clock !== 'function') throw new Error('geckoterminal_clock_required');
  const pool = address(poolAddress, 'geckoterminal_pool_address');
  const slot = safeInt(anchorSlot, 'sol_usd_anchor_slot');
  const blockTime = safeInt(transactionBlockTimeUnix, 'transaction_block_time_unix');
  const observedAt = iso(clock() instanceof Date ? clock().toISOString() : clock(), 'sol_usd_observed_at');

  const poolResult = await getJson(fetchImpl, `/api/v2/networks/solana/pools/${encodeURIComponent(pool)}?include=base_token%2Cquote_token`, timeoutMs);
  const returnedPool = poolResult.body?.data;
  const returnedAddress = address(returnedPool?.attributes?.address, 'geckoterminal_returned_pool_address');
  if (returnedAddress !== pool) throw new Error('geckoterminal_pool_canonical_mismatch');
  const solSide = resolveSolSide(returnedPool);

  const beforeTimestamp = blockTime + CANDLE_SECONDS;
  const ohlcvResult = await getJson(fetchImpl, `/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=1&before_timestamp=${beforeTimestamp}&limit=2&currency=usd&token=${solSide}&include_empty_intervals=true`, timeoutMs);
  const candle = selectCandle(ohlcvResult.body?.data?.attributes?.ohlcv_list, blockTime);
  const priceUsdMicroPerSol = usdToMicroHalfUp(candle.close);

  const sourcePayload = {
    schema_version: 1,
    source_type: 'SOL_USD_PRICE_V1',
    provider: 'GECKOTERMINAL_PUBLIC',
    api_version: API_VERSION,
    network: 'solana',
    pool_address: pool,
    wsol_mint: WSOL_MINT,
    token_side: solSide,
    anchor_slot: slot,
    transaction_block_time_unix: blockTime,
    candle_timestamp_unix: candle.timestamp,
    candle_interval_seconds: CANDLE_SECONDS,
    price_usd_micro_per_sol: priceUsdMicroPerSol,
    candle: {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume
    }
  };

  return {
    ...sourcePayload,
    source_reference: `GECKOTERMINAL:${pool}:minute:1:${candle.timestamp}:${solSide}`,
    source_hash: hash(sourcePayload),
    observed_at: observedAt,
    currency: 'USD_MICRO_PER_SOL',
    status: 'HISTORICAL_PRICE_OBSERVED',
    read_only: true,
    reconciliation_ready: false,
    evidence_ready: false,
    verified: false,
    published: false,
    live_execution_authorized: false,
    provenance: {
      provider_origin: PROVIDER_ORIGIN,
      api_version: API_VERSION,
      selection_policy: 'EXPLICIT_POOL_ADDRESS_REQUIRED',
      pool_url: poolResult.url,
      ohlcv_url: ohlcvResult.url
    }
  };
}

export const HISTORICAL_SOL_USD_SOURCE = Object.freeze({
  provider_origin: PROVIDER_ORIGIN,
  api_version: API_VERSION,
  wsol_mint: WSOL_MINT,
  candle_interval_seconds: CANDLE_SECONDS
});
