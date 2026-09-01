import crypto from 'node:crypto';
import { collectSolanaRpcEvidence } from './solana-evidence-source.mjs';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function safeRpcUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('solana_rpc_unconfigured');
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid_solana_rpc_url'); }
  if (!HTTP_PROTOCOLS.has(url.protocol)) throw new Error('invalid_solana_rpc_url');
  return url.toString();
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function strictOptionalBoundedInt(value, fallback, min, max, reason) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(reason);
  return value;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function projection(row) {
  if (!row) return null;
  return {
    collection_id: row.collection_id,
    trader_id: row.trader_id,
    source_type: row.source_type,
    source_reference: row.source_reference,
    observed_at: row.observed_at,
    collection_status: row.collection_status,
    reason: row.reason,
    provenance: row.provenance || {},
    metrics_available: row.metrics_available === true,
    trades_count: optionalNumber(row.trades_count),
    total_return_bps: optionalNumber(row.total_return_bps),
    win_rate_bps: optionalNumber(row.win_rate_bps),
    drawdown_bps: optionalNumber(row.drawdown_bps),
    reputation_score: optionalNumber(row.reputation_score),
    calculation_hash: row.calculation_hash || null,
    verified: false,
    published: false,
    live_execution_authorized: false,
    created_at: row.created_at
  };
}

export function createSolanaJsonRpcCaller({ rpcUrl, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const endpoint = safeRpcUrl(rpcUrl);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const timeout = boundedInt(timeoutMs, 8000, 1000, 30000);
  let rpcId = 0;

  return async (method, params = []) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: controller.signal
      });
      if (!response?.ok) throw new Error('solana_rpc_http_error');
      const body = await response.json();
      if (!body || typeof body !== 'object') throw new Error('invalid_solana_rpc_response');
      if (body.error) throw new Error('solana_rpc_error');
      return body.result;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createAutomaticEvidenceService(pool, {
  rpcUrl = process.env.SOLANA_RPC_URL,
  endpointLabel = process.env.SOLANA_RPC_ENDPOINT_LABEL || 'solana-rpc',
  fetchImpl = globalThis.fetch
} = {}) {
  if (!pool) throw new Error('database_unconfigured');

  async function loadApprovedTrader(traderId) {
    const trader = (await pool.query(
      `SELECT trader_id,wallet_address,onboarding_status,verification_status,published,verified,mode,status
       FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`,
      [traderId]
    )).rows[0];
    if (!trader) throw new Error('trader_application_not_found');
    if (trader.onboarding_status !== 'APPROVED') throw new Error('trader_verification_invalid_state');
    if (trader.mode !== 'SHADOW') throw new Error('trader_not_shadow');
    return trader;
  }

  return {
    async collectSolana(traderId, input = {}) {
      const limit = strictOptionalBoundedInt(input.limit, 100, 1, 1000, 'invalid_rpc_page_size');
      const maxPages = strictOptionalBoundedInt(input.max_pages, 3, 1, 20, 'invalid_rpc_max_pages');
      const trader = await loadApprovedTrader(traderId);
      const rpcCall = createSolanaJsonRpcCaller({
        rpcUrl,
        fetchImpl,
        timeoutMs: boundedInt(input.timeout_ms, 8000, 1000, 30000)
      });
      const collected = await collectSolanaRpcEvidence({
        walletAddress: trader.wallet_address,
        rpcCall,
        limit,
        maxPages,
        endpointLabel
      });
      const collectionId = crypto.randomUUID();
      const observedAt = new Date();
      const row = (await pool.query(
        `INSERT INTO trader_evidence_collection_runs(
           collection_id,trader_id,source_type,source_reference,observed_at,collection_status,reason,
           provenance,metrics_available,verified,published,live_execution_authorized
         ) VALUES($1,$2,$3,$4,$5,'PENDING_DATA',$6,$7::jsonb,false,false,false,false)
         RETURNING *`,
        [collectionId,trader.trader_id,'SOLANA_RPC',collected.source_reference,observedAt,collected.reason,JSON.stringify(collected.provenance || {})]
      )).rows[0];
      return projection(row);
    },

    async listCollections(traderId, limit = 20) {
      await loadApprovedTrader(traderId);
      const n = boundedInt(limit, 20, 1, 100);
      const rows = (await pool.query(
        `SELECT * FROM trader_evidence_collection_runs
         WHERE trader_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [traderId,n]
      )).rows;
      return rows.map(projection);
    }
  };
}
