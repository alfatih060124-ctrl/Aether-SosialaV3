import crypto from 'node:crypto';

const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';
const API_VERSION = '20230203';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CANDLE_SECONDS = 60;
const HASH_RE = /^[a-f0-9]{64}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
  if (!BASE58_RE.test(v) || decodedBase58ByteLength(v) !== 32) throw new Error(`invalid_${name}`);
  return v;
}

function safeInt(value, name, min = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`invalid_${name}`);
  return n;
}

function positiveFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${name}`);
  return n;
}

function nonNegativeFiniteOrNull(value, name) {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid_${name}`);
  return n;
}

function iso(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_${name}`);
  return { iso: new Date(ms).toISOString(), ms };
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalUrl(value, name) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new Error(`invalid_${name}`); }
  if (url.origin !== PROVIDER_ORIGIN || url.username || url.password || url.hash) throw new Error(`invalid_${name}`);
  return url;
}

function assertExactParams(url, expected, name) {
  const actualEntries = [...url.searchParams.entries()];
  const expectedEntries = Object.entries(expected).map(([key, value]) => [key, String(value)]);
  if (actualEntries.length !== expectedEntries.length) throw new Error(`${name}_mismatch`);
  for (const [key, value] of expectedEntries) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== value) throw new Error(`${name}_mismatch`);
  }
}

function microPriceFromClose(close) {
  const scaled = close * 1_000_000;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || rounded < 1) throw new Error('sol_usd_price_overflow');
  return rounded;
}

export function verifyHistoricalSolUsdSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('sol_usd_snapshot_required');
  if (snapshot.schema_version !== 1) throw new Error('invalid_sol_usd_schema_version');
  if (snapshot.source_type !== 'SOL_USD_PRICE_V1') throw new Error('invalid_sol_usd_source_type');
  if (snapshot.provider !== 'GECKOTERMINAL_PUBLIC') throw new Error('invalid_sol_usd_provider');
  if (snapshot.api_version !== API_VERSION) throw new Error('invalid_sol_usd_api_version');
  if (snapshot.network !== 'solana') throw new Error('invalid_sol_usd_network');
  if (snapshot.wsol_mint !== WSOL_MINT) throw new Error('invalid_sol_usd_wsol_mint');
  if (!['base', 'quote'].includes(snapshot.token_side)) throw new Error('invalid_sol_usd_token_side');

  const pool = address(snapshot.pool_address, 'sol_usd_pool_address');
  const slot = safeInt(snapshot.anchor_slot, 'sol_usd_anchor_slot');
  const blockTime = safeInt(snapshot.transaction_block_time_unix, 'sol_usd_transaction_block_time_unix');
  const candleTime = safeInt(snapshot.candle_timestamp_unix, 'sol_usd_candle_timestamp_unix');
  const interval = safeInt(snapshot.candle_interval_seconds, 'sol_usd_candle_interval_seconds', 1);
  if (interval !== CANDLE_SECONDS) throw new Error('sol_usd_candle_interval_invalid');
  if (!(candleTime <= blockTime && blockTime < candleTime + interval)) throw new Error('sol_usd_candle_time_mismatch');

  const price = safeInt(snapshot.price_usd_micro_per_sol, 'price_usd_micro_per_sol', 1);
  const candle = snapshot.candle;
  if (!candle || typeof candle !== 'object' || Array.isArray(candle)) throw new Error('invalid_sol_usd_candle');
  const open = positiveFinite(candle.open, 'sol_usd_candle_open');
  const high = positiveFinite(candle.high, 'sol_usd_candle_high');
  const low = positiveFinite(candle.low, 'sol_usd_candle_low');
  const close = positiveFinite(candle.close, 'sol_usd_candle_close');
  const volume = nonNegativeFiniteOrNull(candle.volume, 'sol_usd_candle_volume');
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) throw new Error('invalid_sol_usd_candle_range');
  if (price !== microPriceFromClose(close)) throw new Error('sol_usd_price_candle_mismatch');

  const expectedReference = `GECKOTERMINAL:${pool}:minute:1:${candleTime}:${snapshot.token_side}`;
  if (snapshot.source_reference !== expectedReference) throw new Error('sol_usd_source_reference_mismatch');
  if (!HASH_RE.test(String(snapshot.source_hash ?? ''))) throw new Error('invalid_sol_usd_source_hash');

  const sourcePayload = {
    schema_version: 1,
    source_type: 'SOL_USD_PRICE_V1',
    provider: 'GECKOTERMINAL_PUBLIC',
    api_version: API_VERSION,
    network: 'solana',
    pool_address: pool,
    wsol_mint: WSOL_MINT,
    token_side: snapshot.token_side,
    anchor_slot: slot,
    transaction_block_time_unix: blockTime,
    candle_timestamp_unix: candleTime,
    candle_interval_seconds: interval,
    price_usd_micro_per_sol: price,
    candle: { open, high, low, close, volume }
  };
  const expectedHash = sha256(sourcePayload);
  if (snapshot.source_hash !== expectedHash) throw new Error('sol_usd_source_hash_mismatch');

  const observed = iso(snapshot.observed_at, 'sol_usd_observed_at');
  if (observed.ms < blockTime * 1000) throw new Error('sol_usd_observed_before_transaction');
  if (snapshot.currency !== 'USD_MICRO_PER_SOL') throw new Error('sol_usd_currency_invalid');
  if (snapshot.status !== 'HISTORICAL_PRICE_OBSERVED') throw new Error('sol_usd_status_invalid');
  if (snapshot.read_only !== true || snapshot.reconciliation_ready !== false || snapshot.evidence_ready !== false || snapshot.verified !== false || snapshot.published !== false || snapshot.live_execution_authorized !== false) {
    throw new Error('sol_usd_boundary_violation');
  }

  const provenance = snapshot.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('invalid_sol_usd_provenance');
  if (provenance.provider_origin !== PROVIDER_ORIGIN || provenance.api_version !== API_VERSION || provenance.selection_policy !== 'EXPLICIT_POOL_ADDRESS_REQUIRED') {
    throw new Error('invalid_sol_usd_provenance');
  }
  const poolUrl = canonicalUrl(provenance.pool_url, 'sol_usd_pool_url');
  const ohlcvUrl = canonicalUrl(provenance.ohlcv_url, 'sol_usd_ohlcv_url');
  if (poolUrl.pathname !== `/api/v2/networks/solana/pools/${pool}`) throw new Error('sol_usd_pool_url_mismatch');
  assertExactParams(poolUrl, { include: 'base_token,quote_token' }, 'sol_usd_pool_url');

  if (ohlcvUrl.pathname !== `/api/v2/networks/solana/pools/${pool}/ohlcv/minute`) throw new Error('sol_usd_ohlcv_url_mismatch');
  assertExactParams(ohlcvUrl, {
    aggregate: '1',
    before_timestamp: blockTime + CANDLE_SECONDS,
    limit: '2',
    currency: 'usd',
    token: snapshot.token_side,
    include_empty_intervals: 'true'
  }, 'sol_usd_ohlcv_url');

  return Object.freeze({
    source_reference: expectedReference,
    source_hash: expectedHash,
    pool_address: pool,
    anchor_slot: slot,
    transaction_block_time_unix: blockTime,
    candle_timestamp_unix: candleTime,
    candle_interval_seconds: interval,
    price_usd_micro_per_sol: price,
    observed_at: observed.iso,
    provenance: Object.freeze({ provider_origin: PROVIDER_ORIGIN, api_version: API_VERSION, pool_url: poolUrl.toString(), ohlcv_url: ohlcvUrl.toString() })
  });
}
