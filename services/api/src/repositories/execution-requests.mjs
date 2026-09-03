import { randomUUID } from 'node:crypto';

const EXECUTION_STATUSES = new Set(['PENDING', 'QUEUED', 'SIMULATED', 'EXECUTED', 'REJECTED', 'FAILED']);
const EXECUTION_MODES = new Set(['SHADOW', 'PAPER', 'LIVE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertUUID = (value, field) => {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`invalid_${field}_uuid`);
  }
};

export function createExecutionRequestRepository(pool) {
  return {
    async create(request) {
      if (!request?.idempotency_key) throw new Error('idempotency_key_required');
      if (!request?.event_id) throw new Error('event_id_required');
      if (!request?.follower_user_id) throw new Error('follower_user_id_required');
      if (!request?.trader_id) throw new Error('trader_id_required');

      assertUUID(request.follower_user_id, 'follower_user_id');
      assertUUID(request.trader_id, 'trader_id');
      if (request.execution_request_id != null) assertUUID(request.execution_request_id, 'execution_request_id');

      const amount = Number(request.requested_amount_usd);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid_requested_amount');

      const mode = request.mode ?? 'SHADOW';
      if (!EXECUTION_MODES.has(mode)) throw new Error('invalid_execution_mode');

      const status = request.status ?? 'PENDING';
      if (!EXECUTION_STATUSES.has(status)) throw new Error('invalid_execution_status');

      const q = `
        INSERT INTO execution_requests
          (execution_request_id,idempotency_key,event_id,follower_user_id,trader_id,requested_amount_usd,mode,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (idempotency_key)
        DO UPDATE SET updated_at=now()
        RETURNING *`;
      const v = [
        request.execution_request_id ?? randomUUID(),
        request.idempotency_key,
        request.event_id,
        request.follower_user_id,
        request.trader_id,
        amount,
        mode,
        status
      ];
      return (await pool.query(q, v)).rows[0];
    },
    async getById(id) {
      assertUUID(id, 'execution_request_id');
      return (await pool.query('SELECT * FROM execution_requests WHERE execution_request_id=$1', [id])).rows[0] ?? null;
    },
    async getByIdempotencyKey(key) {
      return (await pool.query('SELECT * FROM execution_requests WHERE idempotency_key=$1', [key])).rows[0] ?? null;
    },
    async listForFollower(userId, limit = 100) {
      assertUUID(userId, 'follower_user_id');
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const q = `
        SELECT
          er.execution_request_id,
          er.event_id,
          er.trader_id,
          er.requested_amount_usd,
          er.mode,
          er.status,
          er.created_at,
          er.updated_at,
          te.dex,
          te.token_in,
          te.token_out,
          te.amount_usd AS source_trade_amount_usd,
          te.tx_hash AS source_tx_hash,
          te.observed_at AS source_observed_at
        FROM execution_requests er
        LEFT JOIN trade_events te ON te.event_id=er.event_id
        WHERE er.follower_user_id=$1
        ORDER BY er.created_at DESC
        LIMIT $2`;
      return (await pool.query(q, [userId, safeLimit])).rows;
    },
    async updateStatus(id, status) {
      assertUUID(id, 'execution_request_id');
      if (!EXECUTION_STATUSES.has(status)) throw new Error('invalid_execution_status');
      return (await pool.query(
        'UPDATE execution_requests SET status=$2,updated_at=now() WHERE execution_request_id=$1 RETURNING *',
        [id, status]
      )).rows[0] ?? null;
    }
  };
}
