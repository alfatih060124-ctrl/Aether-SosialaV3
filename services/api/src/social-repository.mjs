export function addSocialRepositoryMethods(Repository) {
  Repository.prototype.createCopyPolicy = async function (input) {
    const result = await this.pool.query(
      `INSERT INTO copy_policies
       (follower_user_id, trader_id, policy_type, value, max_copy_amount_usd, max_position_amount_usd, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.follower_user_id, input.trader_id, input.policy_type, input.value,
       input.max_copy_amount_usd, input.max_position_amount_usd, input.enabled ?? true]
    );
    return result.rows[0];
  };

  Repository.prototype.listCopyPolicies = async function (userId) {
    const result = await this.pool.query(
      `SELECT * FROM copy_policies WHERE follower_user_id = $1 ORDER BY created_at DESC`, [userId]
    );
    return result.rows;
  };

  Repository.prototype.createRiskDecision = async function (input) {
    const result = await this.pool.query(
      `INSERT INTO risk_decisions (event_id, follower_user_id, decision, reason_code)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.event_id, input.follower_user_id, input.decision, input.reason_code ?? null]
    );
    return result.rows[0];
  };
}
