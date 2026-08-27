export function createExecutionRequestRepository(pool) {
  return {
    async create(request) {
      const q = `INSERT INTO execution_requests (execution_request_id,idempotency_key,event_id,follower_user_id,requested_amount_usd,mode,status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=now() RETURNING *`;
      const v = [request.execution_request_id,request.idempotency_key,request.event_id,request.follower_user_id,request.requested_amount_usd,request.mode ?? 'SIMULATION',request.status ?? 'PENDING'];
      return (await pool.query(q,v)).rows[0];
    },
    async getById(id) { return (await pool.query('SELECT * FROM execution_requests WHERE execution_request_id=$1',[id])).rows[0] ?? null; },
    async getByIdempotencyKey(key) { return (await pool.query('SELECT * FROM execution_requests WHERE idempotency_key=$1',[key])).rows[0] ?? null; },
    async updateStatus(id,status) { return (await pool.query('UPDATE execution_requests SET status=$2,updated_at=now() WHERE execution_request_id=$1 RETURNING *',[id,status])).rows[0] ?? null; }
  };
}
