const traderFields = `trader_id,wallet_address,display_name,bio,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,created_at,updated_at`;

export function createMarketplaceRepository(pool) {
  return {
    async listTraders(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query(
        `SELECT ${traderFields} FROM traders WHERE status='ACTIVE' ORDER BY verified DESC, reputation_score DESC, created_at DESC LIMIT $1`,
        [n]
      )).rows;
    },
    async getTrader(id) {
      return (await pool.query(
        `SELECT ${traderFields} FROM traders WHERE trader_id=$1 AND status='ACTIVE'`,
        [id]
      )).rows[0] ?? null;
    },
    async getFeeConfig() {
      return (await pool.query(
        `SELECT config_id,performance_fee_bps,execution_fee_bps,currency,enabled,updated_at FROM platform_fee_config WHERE config_id=1`
      )).rows[0] ?? null;
    }
  };
}
