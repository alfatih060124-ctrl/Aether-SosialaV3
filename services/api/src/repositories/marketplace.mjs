export function createMarketplaceRepository(pool) {
  return {
    async listTraders(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query(`SELECT trader_id,wallet_address,reputation_score,drawdown_bps,status,created_at FROM traders WHERE status='ACTIVE' ORDER BY reputation_score DESC, created_at DESC LIMIT $1`,[n])).rows;
    },
    async getTrader(id) {
      return (await pool.query(`SELECT trader_id,wallet_address,reputation_score,drawdown_bps,status,created_at FROM traders WHERE trader_id=$1 AND status='ACTIVE'`,[id])).rows[0] ?? null;
    }
  };
}
