import { randomUUID } from 'node:crypto';

const EXECUTION_STATUSES = new Set(['PENDING', 'QUEUED', 'SIMULATED', 'EXECUTED', 'REJECTED', 'FAILED']);
const EXECUTION_MODES = new Set(['SHADOW', 'PAPER', 'LIVE']);

export function createExecutionRequestRepository(pool) {
  return {
    async create(request) {
      if (!request?.idempotency_key) throw new Error('idempotency_key_required');
      if (!request?.event_id) throw new Error('event_id_required');
      if (!request?.follower_user_id) throw new Error('follower_user_id_required');
      if (!request?.trader_id) throw new Error('trader_id_required');

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
      return (await pool.query('SELECT * FROM execution_requests WHERE execution_request_id=$1', [id])).rows[0] ?? null;
    },
    async getByIdempotencyKey(key) {
      return (await pool.query('SELECT * FROM execution_requests WHERE idempotency_key=$1', [key])).rows[0] ?? null;
    },
    async updateStatus(id, status) {
      if (!EXECUTION_STATUSES.has(status)) throw new Error('invalid_execution_status');
      return (await pool.query(
        'UPDATE execution_requests SET status=$2,updated_at=now() WHERE execution_request_id=$1 RETURNING *',
        [id, status]
      )).rows[0] ?? null;
    }
  };
}
