export function createCoreRepositories(pool) {
  return {
    traders: {
      async getById(id) { return (await pool.query('SELECT * FROM traders WHERE trader_id=$1',[id])).rows[0] ?? null; },
      async getByWallet(wallet) { return (await pool.query('SELECT * FROM traders WHERE wallet_address=$1',[wallet])).rows[0] ?? null; }
    },
    copyPolicies: {
      async listForFollower(userId) { return (await pool.query('SELECT * FROM copy_policies WHERE follower_user_id=$1 AND enabled=true ORDER BY created_at DESC',[userId])).rows; },
      async getForPair(userId,traderId) { return (await pool.query('SELECT * FROM copy_policies WHERE follower_user_id=$1 AND trader_id=$2',[userId,traderId])).rows[0] ?? null; }
    },
    riskDecisions: {
      async create(d) { return (await pool.query('INSERT INTO risk_decisions(decision_id,event_id,follower_user_id,decision,reason_code) VALUES($1,$2,$3,$4,$5) RETURNING *',[d.decision_id,d.event_id,d.follower_user_id,d.decision,d.reason_code ?? null])).rows[0]; }
    },
    auditEvents: {
      async append(a) { return (await pool.query('INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[a.event_type,a.actor ?? null,a.entity_type ?? null,a.entity_id ?? null,a.payload ?? {}])).rows[0]; }
    }
  };
}
