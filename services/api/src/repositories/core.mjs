import crypto from 'node:crypto';

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

export function createCoreRepositories(pool) {
  return {
    traders: {
      async getById(id) { return (await pool.query('SELECT * FROM traders WHERE trader_id=$1',[id])).rows[0] ?? null; },
      async getByWallet(wallet) { return (await pool.query('SELECT * FROM traders WHERE wallet_address=$1',[wallet])).rows[0] ?? null; }
    },
    copyPolicies: {
      async listForFollower(userId) {
        return (await pool.query(
          `SELECT p.*,t.display_name AS trader_display_name,t.wallet_address AS trader_wallet,t.verified AS trader_verified,t.published AS trader_published
           FROM copy_policies p JOIN traders t ON t.trader_id=p.trader_id
           WHERE p.follower_user_id=$1 ORDER BY p.updated_at DESC,p.created_at DESC`,
          [userId]
        )).rows;
      },
      async getForPair(userId,traderId) {
        return (await pool.query('SELECT * FROM copy_policies WHERE follower_user_id=$1 AND trader_id=$2',[userId,traderId])).rows[0] ?? null;
      },
      async createForFollower(userId, input) {
        if (!userId) throw new Error('user_id_required');
        const traderId = String(input?.trader_id || '').trim();
        if (!traderId) throw new Error('trader_id_required');
        const trader = (await pool.query(
          `SELECT trader_id,owner_user_id,status,verified,mode,onboarding_status,verification_status,published
           FROM traders WHERE trader_id=$1`,
          [traderId]
        )).rows[0];
        if (!trader || trader.status !== 'ACTIVE' || trader.verified !== true || trader.onboarding_status !== 'APPROVED' || trader.verification_status !== 'VERIFIED' || trader.published !== true) {
          throw new Error('trader_not_copyable');
        }
        if (trader.mode !== 'SHADOW') throw new Error('trader_not_shadow');
        if (trader.owner_user_id && String(trader.owner_user_id) === String(userId)) throw new Error('self_copy_not_allowed');
        const existing = await this.getForPair(userId, traderId);
        if (existing) throw new Error('copy_mandate_exists');

        const maxCopy = positiveMoney(input?.max_copy_amount_usd, 'max_copy_amount_usd');
        const maxPosition = positiveMoney(input?.max_position_amount_usd, 'max_position_amount_usd');
        if (maxPosition < maxCopy) throw new Error('invalid_max_position_amount_usd');
        const allocation = boundedInt(input?.allocation_bps ?? 1000, 'allocation_bps', 1, 10000);
        const slippage = boundedInt(input?.max_slippage_bps ?? 100, 'max_slippage_bps', 1, 1000);
        const dailyLoss = boundedInt(input?.max_daily_loss_bps ?? 300, 'max_daily_loss_bps', 1, 5000);
        const stopDrawdown = boundedInt(input?.stop_drawdown_bps ?? 1500, 'stop_drawdown_bps', 1, 9000);
        const policyId = crypto.randomUUID();
        return (await pool.query(
          `INSERT INTO copy_policies(
             policy_id,follower_user_id,trader_id,enabled,max_copy_amount_usd,max_position_amount_usd,
             mode,status,allocation_bps,max_slippage_bps,max_daily_loss_bps,stop_drawdown_bps,live_execution_authorized
           ) VALUES($1,$2,$3,true,$4,$5,'SHADOW','ACTIVE',$6,$7,$8,$9,false) RETURNING *`,
          [policyId,userId,traderId,maxCopy,maxPosition,allocation,slippage,dailyLoss,stopDrawdown]
        )).rows[0];
      },
      async updateForFollower(userId, policyId, input) {
        const current = (await pool.query('SELECT * FROM copy_policies WHERE policy_id=$1 AND follower_user_id=$2',[policyId,userId])).rows[0];
        if (!current) throw new Error('copy_mandate_not_found');
        const action = String(input?.action || '').toUpperCase();
        let status = current.status;
        let enabled = current.enabled;
        if (action) {
          if (!['PAUSE','RESUME','CANCEL'].includes(action)) throw new Error('invalid_copy_mandate_action');
          if (action === 'PAUSE') { status='PAUSED'; enabled=false; }
          if (action === 'RESUME') { if(current.status==='CANCELLED') throw new Error('copy_mandate_cancelled'); status='ACTIVE'; enabled=true; }
          if (action === 'CANCEL') { status='CANCELLED'; enabled=false; }
        }
        const maxCopy = input?.max_copy_amount_usd === undefined ? Number(current.max_copy_amount_usd) : positiveMoney(input.max_copy_amount_usd, 'max_copy_amount_usd');
        const maxPosition = input?.max_position_amount_usd === undefined ? Number(current.max_position_amount_usd) : positiveMoney(input.max_position_amount_usd, 'max_position_amount_usd');
        if (maxPosition < maxCopy) throw new Error('invalid_max_position_amount_usd');
        const allocation = input?.allocation_bps === undefined ? current.allocation_bps : boundedInt(input.allocation_bps, 'allocation_bps', 1, 10000);
        const slippage = input?.max_slippage_bps === undefined ? current.max_slippage_bps : boundedInt(input.max_slippage_bps, 'max_slippage_bps', 1, 1000);
        const dailyLoss = input?.max_daily_loss_bps === undefined ? current.max_daily_loss_bps : boundedInt(input.max_daily_loss_bps, 'max_daily_loss_bps', 1, 5000);
        const stopDrawdown = input?.stop_drawdown_bps === undefined ? current.stop_drawdown_bps : boundedInt(input.stop_drawdown_bps, 'stop_drawdown_bps', 1, 9000);
        return (await pool.query(
          `UPDATE copy_policies SET enabled=$3,status=$4,max_copy_amount_usd=$5,max_position_amount_usd=$6,
             allocation_bps=$7,max_slippage_bps=$8,max_daily_loss_bps=$9,stop_drawdown_bps=$10,
             mode='SHADOW',live_execution_authorized=false,updated_at=now()
           WHERE policy_id=$1 AND follower_user_id=$2 RETURNING *`,
          [policyId,userId,enabled,status,maxCopy,maxPosition,allocation,slippage,dailyLoss,stopDrawdown]
        )).rows[0];
      }
    },
    riskDecisions: {
      async create(d) { return (await pool.query('INSERT INTO risk_decisions(decision_id,event_id,follower_user_id,decision,reason_code) VALUES($1,$2,$3,$4,$5) RETURNING *',[d.decision_id,d.event_id,d.follower_user_id,d.decision,d.reason_code ?? null])).rows[0]; }
    },
    auditEvents: {
      async append(a) { return (await pool.query('INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[a.event_type,a.actor ?? null,a.entity_type ?? null,a.entity_id ?? null,a.payload ?? {}])).rows[0]; }
    }
  };
}
