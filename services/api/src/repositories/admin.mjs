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
    async updateCopyPolicy(policyId, patch) {
      return (await pool.query(`UPDATE copy_policies SET enabled=COALESCE($2,enabled), max_copy_amount_usd=COALESCE($3,max_copy_amount_usd), max_position_amount_usd=COALESCE($4,max_position_amount_usd), updated_at=now() WHERE policy_id=$1 RETURNING *`,[policyId,patch.enabled ?? null,patch.max_copy_amount_usd ?? null,patch.max_position_amount_usd ?? null])).rows[0] ?? null;
    }
  };
}
