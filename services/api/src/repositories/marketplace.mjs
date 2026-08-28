const traderFields = `trader_id,wallet_address,display_name,bio,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,created_at,updated_at`;

export function createMarketplaceRepository(pool) {
  return {
    async listTraders(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query(`SELECT ${traderFields} FROM traders WHERE status='ACTIVE' ORDER BY verified DESC, reputation_score DESC, created_at DESC LIMIT $1`, [n])).rows;
    },
    async getTrader(id) {
      return (await pool.query(`SELECT ${traderFields} FROM traders WHERE trader_id=$1 AND status='ACTIVE'`, [id])).rows[0] ?? null;
    },
    async getFeeConfig() {
      return (await pool.query(`SELECT config_id,performance_fee_bps,execution_fee_bps,execution_rental_fee_bps,currency,enabled,updated_at FROM platform_fee_config WHERE config_id=1`)).rows[0] ?? null;
    },
    async updateFeeConfig({ performance_fee_bps, execution_fee_bps, execution_rental_fee_bps, enabled }) {
      const p = Number(performance_fee_bps), e = Number(execution_fee_bps), r = Number(execution_rental_fee_bps);
      if (!Number.isInteger(p) || p < 0 || p > 10000) throw new Error('invalid_performance_fee_bps');
      if (!Number.isInteger(e) || e < 0 || e > 10000) throw new Error('invalid_execution_fee_bps');
      if (!Number.isInteger(r) || r < 0 || r > 10000) throw new Error('invalid_execution_rental_fee_bps');
      if (typeof enabled !== 'boolean') throw new Error('invalid_fee_enabled');
      return (await pool.query(`UPDATE platform_fee_config SET performance_fee_bps=$1,execution_fee_bps=$2,execution_rental_fee_bps=$3,enabled=$4,updated_at=now() WHERE config_id=1 RETURNING config_id,performance_fee_bps,execution_fee_bps,execution_rental_fee_bps,currency,enabled,updated_at`, [p,e,r,enabled])).rows[0] ?? null;
    }
  };
}
