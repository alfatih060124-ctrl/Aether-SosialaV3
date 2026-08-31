function boundedInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}
function positiveMoney(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000000) throw new Error(`invalid_${name}`);
  return n;
}

export function createAdminRepository(pool) {
  return {
    async recentRiskDecisions(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query('SELECT * FROM risk_decisions ORDER BY created_at DESC LIMIT $1',[n])).rows;
    },
    async recentAuditEvents(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1',[n])).rows;
    },
    async listCopyPolicies(limit = 200) {
      const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
      return (await pool.query(
        `SELECT p.*,t.display_name AS trader_display_name,t.wallet_address AS trader_wallet,
                a.status AS follower_account_status,w.wallet_address AS follower_wallet
         FROM copy_policies p
         JOIN traders t ON t.trader_id=p.trader_id
         LEFT JOIN user_accounts a ON a.user_id=p.follower_user_id
         LEFT JOIN user_wallets w ON w.user_id=p.follower_user_id AND w.is_primary=true
         ORDER BY p.updated_at DESC,p.created_at DESC LIMIT $1`,
        [n]
      )).rows;
    },
    async updateCopyPolicy(policyId, patch) {
      const current = (await pool.query('SELECT * FROM copy_policies WHERE policy_id=$1',[policyId])).rows[0];
      if (!current) return null;
      if (current.status === 'CANCELLED') throw new Error('copy_mandate_cancelled');
      let enabled = current.enabled;
      let status = current.status;
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new Error('invalid_copy_policy_enabled');
        enabled = patch.enabled;
        status = enabled ? 'ACTIVE' : 'PAUSED';
      }
      const maxCopy = patch.max_copy_amount_usd === undefined ? Number(current.max_copy_amount_usd) : positiveMoney(patch.max_copy_amount_usd,'max_copy_amount_usd');
      const maxPosition = patch.max_position_amount_usd === undefined ? Number(current.max_position_amount_usd) : positiveMoney(patch.max_position_amount_usd,'max_position_amount_usd');
      if (maxPosition < maxCopy) throw new Error('invalid_max_position_amount_usd');
      const allocation = patch.allocation_bps === undefined ? current.allocation_bps : boundedInt(patch.allocation_bps,'allocation_bps',1,10000);
      const slippage = patch.max_slippage_bps === undefined ? current.max_slippage_bps : boundedInt(patch.max_slippage_bps,'max_slippage_bps',1,1000);
      const dailyLoss = patch.max_daily_loss_bps === undefined ? current.max_daily_loss_bps : boundedInt(patch.max_daily_loss_bps,'max_daily_loss_bps',1,5000);
      const stopDrawdown = patch.stop_drawdown_bps === undefined ? current.stop_drawdown_bps : boundedInt(patch.stop_drawdown_bps,'stop_drawdown_bps',1,9000);
      return (await pool.query(
        `UPDATE copy_policies SET enabled=$2,status=$3,max_copy_amount_usd=$4,max_position_amount_usd=$5,
           allocation_bps=$6,max_slippage_bps=$7,max_daily_loss_bps=$8,stop_drawdown_bps=$9,
           mode='SHADOW',live_execution_authorized=false,updated_at=now() WHERE policy_id=$1 RETURNING *`,
        [policyId,enabled,status,maxCopy,maxPosition,allocation,slippage,dailyLoss,stopDrawdown]
      )).rows[0] ?? null;
    }
  };
}
