import crypto from 'node:crypto';

const publicTraderFields = `trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,ownership_verified_at,created_at,updated_at`;
const accountTraderFields = `trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,owner_user_id,ownership_verified_at,onboarding_status,published,applied_at,reviewed_at,review_note,created_at,updated_at`;

function cleanText(value, { name, min = 0, max }) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) throw new Error(`invalid_${name}`);
  return text;
}

export function createMarketplaceRepository(pool) {
  return {
    async listTraders(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query(
        `SELECT ${publicTraderFields} FROM traders
         WHERE status='ACTIVE' AND verified=true AND onboarding_status='APPROVED' AND published=true
         ORDER BY reputation_score DESC, created_at DESC LIMIT $1`,
        [n]
      )).rows;
    },

    async getTrader(id) {
      return (await pool.query(
        `SELECT ${publicTraderFields} FROM traders
         WHERE trader_id=$1 AND status='ACTIVE' AND verified=true AND onboarding_status='APPROVED' AND published=true`,
        [id]
      )).rows[0] ?? null;
    },

    async getOwnedTrader(userId) {
      if (!userId) throw new Error('user_id_required');
      return (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE owner_user_id=$1`, [userId])).rows[0] ?? null;
    },

    async createTraderApplication({ userId, walletAddress, displayName, bio = '', strategySummary = '' }) {
      if (!userId) throw new Error('user_id_required');
      if (!walletAddress) throw new Error('wallet_address_required');
      const name = cleanText(displayName, { name: 'trader_display_name', min: 3, max: 60 });
      const safeBio = cleanText(bio, { name: 'trader_bio', max: 500 });
      const safeSummary = cleanText(strategySummary, { name: 'strategy_summary', min: 10, max: 700 });
      const existing = (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE owner_user_id=$1 OR wallet_address=$2 LIMIT 1`, [userId, walletAddress])).rows[0];
      if (existing) throw new Error('trader_application_exists');

      const fee = (await pool.query(`SELECT performance_fee_bps,execution_fee_bps FROM platform_fee_config WHERE config_id=1`)).rows[0] || {};
      const traderId = crypto.randomUUID();
      return (await pool.query(
        `INSERT INTO traders(
           trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,
           verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,
           execution_fee_bps,owner_user_id,ownership_verified_at,onboarding_status,published,applied_at,reviewed_at,review_note
         ) VALUES($1,$2,$3,$4,$5,0,0,'PENDING_REVIEW',false,'SHADOW',0,0,0,0,$6,$7,$8,now(),'PENDING',false,now(),NULL,'')
         RETURNING ${accountTraderFields}`,
        [traderId, walletAddress, name, safeBio, safeSummary, Number(fee.performance_fee_bps ?? 1000), Number(fee.execution_fee_bps ?? 25), userId]
      )).rows[0];
    },

    async listTraderApplications(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
      return (await pool.query(
        `SELECT ${accountTraderFields} FROM traders
         WHERE owner_user_id IS NOT NULL
         ORDER BY CASE onboarding_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,
                  applied_at DESC NULLS LAST, created_at DESC
         LIMIT $1`,
        [n]
      )).rows;
    },

    async reviewTraderApplication(traderId, { decision, review_note = '' }) {
      const action = String(decision || '').toUpperCase();
      if (!['APPROVE','REJECT','SUSPEND'].includes(action)) throw new Error('invalid_trader_review_decision');
      const note = cleanText(review_note, { name: 'trader_review_note', max: 500 });
      const current = (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`, [traderId])).rows[0];
      if (!current) throw new Error('trader_application_not_found');
      if (action === 'REJECT' && current.onboarding_status !== 'PENDING') throw new Error('trader_review_invalid_state');
      if (action === 'SUSPEND' && current.onboarding_status !== 'APPROVED') throw new Error('trader_review_invalid_state');
      if (action === 'APPROVE' && !['PENDING','REJECTED'].includes(current.onboarding_status)) throw new Error('trader_review_invalid_state');

      const next = action === 'APPROVE'
        ? { onboarding: 'APPROVED', status: 'ACTIVE', verified: true, published: true }
        : action === 'REJECT'
          ? { onboarding: 'REJECTED', status: 'REJECTED', verified: false, published: false }
          : { onboarding: 'SUSPENDED', status: 'SUSPENDED', verified: false, published: false };

      return (await pool.query(
        `UPDATE traders SET onboarding_status=$1,status=$2,verified=$3,published=$4,reviewed_at=now(),review_note=$5,updated_at=now()
         WHERE trader_id=$6 RETURNING ${accountTraderFields}`,
        [next.onboarding, next.status, next.verified, next.published, note, traderId]
      )).rows[0];
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
