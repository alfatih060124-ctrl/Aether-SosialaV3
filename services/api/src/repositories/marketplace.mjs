import crypto from 'node:crypto';

const publicTraderFields = `trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,ownership_verified_at,verification_source,verification_reference,verification_observed_at,verified_at,created_at,updated_at`;
const accountTraderFields = `trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,owner_user_id,ownership_verified_at,onboarding_status,verification_status,published,applied_at,reviewed_at,review_note,verification_source,verification_reference,verification_observed_at,verification_note,verified_at,created_at,updated_at`;
const ALLOWED_EVIDENCE_SOURCES = new Set(['SOLANA_RPC','SOLSCAN','INDEXER','INTERNAL_RECONCILIATION']);

function cleanText(value, { name, min = 0, max }) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) throw new Error(`invalid_${name}`);
  return text;
}
function boundedInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}
function boundedNumber(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
}

export function createMarketplaceRepository(pool) {
  return {
    async listTraders(limit = 50) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return (await pool.query(
        `SELECT ${publicTraderFields} FROM traders
         WHERE status='ACTIVE' AND verified=true AND onboarding_status='APPROVED' AND verification_status='VERIFIED' AND published=true
         ORDER BY reputation_score DESC, created_at DESC LIMIT $1`,
        [n]
      )).rows;
    },

    async getTrader(id) {
      return (await pool.query(
        `SELECT ${publicTraderFields} FROM traders
         WHERE trader_id=$1 AND status='ACTIVE' AND verified=true AND onboarding_status='APPROVED' AND verification_status='VERIFIED' AND published=true`,
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
           execution_fee_bps,owner_user_id,ownership_verified_at,onboarding_status,verification_status,published,applied_at,reviewed_at,review_note
         ) VALUES($1,$2,$3,$4,$5,0,0,'PENDING_REVIEW',false,'SHADOW',0,0,0,0,$6,$7,$8,now(),'PENDING','PENDING_DATA',false,now(),NULL,'')
         RETURNING ${accountTraderFields}`,
        [traderId, walletAddress, name, safeBio, safeSummary, Number(fee.performance_fee_bps ?? 1000), Number(fee.execution_fee_bps ?? 25), userId]
      )).rows[0];
    },

    async listTraderApplications(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
      return (await pool.query(
        `SELECT ${accountTraderFields} FROM traders
         WHERE owner_user_id IS NOT NULL
         ORDER BY CASE onboarding_status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 2 WHEN 'SUSPENDED' THEN 3 ELSE 4 END,
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
        ? { onboarding: 'APPROVED', status: 'PENDING_VERIFICATION', verified: false, published: false }
        : action === 'REJECT'
          ? { onboarding: 'REJECTED', status: 'REJECTED', verified: false, published: false }
          : { onboarding: 'SUSPENDED', status: 'SUSPENDED', verified: false, published: false };

      return (await pool.query(
        `UPDATE traders SET onboarding_status=$1,status=$2,verified=$3,published=$4,reviewed_at=now(),review_note=$5,updated_at=now()
         WHERE trader_id=$6 RETURNING ${accountTraderFields}`,
        [next.onboarding, next.status, next.verified, next.published, note, traderId]
      )).rows[0];
    },

    async recordTraderVerificationEvidence(traderId, input = {}) {
      const trader = (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`, [traderId])).rows[0];
      if (!trader) throw new Error('trader_application_not_found');
      if (trader.onboarding_status !== 'APPROVED') throw new Error('trader_verification_invalid_state');
      const sourceType = String(input.source_type || '').toUpperCase();
      if (!ALLOWED_EVIDENCE_SOURCES.has(sourceType)) throw new Error('invalid_verification_source');
      const sourceReference = cleanText(input.source_reference, { name: 'verification_reference', min: 8, max: 300 });
      const observedAt = new Date(input.observed_at || '');
      if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('invalid_verification_observed_at');
      const tradesCount = boundedInt(input.trades_count, 'trades_count', 1, 10000000);
      const totalReturnBps = boundedInt(input.total_return_bps, 'total_return_bps', -10000000, 10000000);
      const winRateBps = boundedInt(input.win_rate_bps, 'win_rate_bps', 0, 10000);
      const drawdownBps = boundedInt(input.drawdown_bps, 'drawdown_bps', 0, 10000);
      const reputationScore = boundedNumber(input.reputation_score, 'reputation_score', 0, 100);
      const note = cleanText(input.review_note || '', { name: 'verification_note', max: 500 });
      const evidenceId = crypto.randomUUID();
      return (await pool.query(
        `INSERT INTO trader_verification_evidence(
           evidence_id,trader_id,source_type,source_reference,observed_at,trades_count,total_return_bps,
           win_rate_bps,drawdown_bps,reputation_score,evidence_status,review_note
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECORDED',$11) RETURNING *`,
        [evidenceId,traderId,sourceType,sourceReference,observedAt,tradesCount,totalReturnBps,winRateBps,drawdownBps,reputationScore,note]
      )).rows[0];
    },

    async listTraderVerificationEvidence(traderId, limit = 20) {
      const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
      return (await pool.query(`SELECT * FROM trader_verification_evidence WHERE trader_id=$1 ORDER BY created_at DESC LIMIT $2`, [traderId,n])).rows;
    },

    async reviewTraderVerification(traderId, input = {}) {
      const decision = String(input.decision || '').toUpperCase();
      if (!['VERIFY','REJECT'].includes(decision)) throw new Error('invalid_trader_verification_decision');
      const evidenceId = String(input.evidence_id || '').trim();
      if (!evidenceId) throw new Error('evidence_id_required');
      const note = cleanText(input.review_note || '', { name: 'verification_note', max: 500 });
      const trader = (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`, [traderId])).rows[0];
      if (!trader) throw new Error('trader_application_not_found');
      if (trader.onboarding_status !== 'APPROVED') throw new Error('trader_verification_invalid_state');
      const evidence = (await pool.query(`SELECT * FROM trader_verification_evidence WHERE evidence_id=$1 AND trader_id=$2`, [evidenceId,traderId])).rows[0];
      if (!evidence) throw new Error('trader_evidence_not_found');
      if (!['RECORDED','REJECTED'].includes(evidence.evidence_status) && decision === 'VERIFY') throw new Error('trader_evidence_invalid_state');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (decision === 'VERIFY') {
          await client.query(`UPDATE trader_verification_evidence SET evidence_status='VERIFIED',review_note=$1,reviewed_at=now() WHERE evidence_id=$2`, [note,evidenceId]);
          const updated = (await client.query(
            `UPDATE traders SET verification_status='VERIFIED',verified=true,status='ACTIVE',published=false,
               verification_source=$1,verification_reference=$2,verification_observed_at=$3,verification_note=$4,verified_at=now(),
               trades_count=$5,total_return_bps=$6,win_rate_bps=$7,drawdown_bps=$8,reputation_score=$9,updated_at=now()
             WHERE trader_id=$10 RETURNING ${accountTraderFields}`,
            [evidence.source_type,evidence.source_reference,evidence.observed_at,note,evidence.trades_count,evidence.total_return_bps,evidence.win_rate_bps,evidence.drawdown_bps,evidence.reputation_score,traderId]
          )).rows[0];
          await client.query('COMMIT');
          return updated;
        }
        await client.query(`UPDATE trader_verification_evidence SET evidence_status='REJECTED',review_note=$1,reviewed_at=now() WHERE evidence_id=$2`, [note,evidenceId]);
        const updated = (await client.query(
          `UPDATE traders SET verification_status='PENDING_DATA',verified=false,status='PENDING_VERIFICATION',published=false,verification_note=$1,updated_at=now()
           WHERE trader_id=$2 RETURNING ${accountTraderFields}`,
          [note,traderId]
        )).rows[0];
        await client.query('COMMIT');
        return updated;
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally {
        client.release();
      }
    },

    async setTraderPublished(traderId, input = {}) {
      const published = input.published;
      if (typeof published !== 'boolean') throw new Error('invalid_trader_published');
      const note = cleanText(input.review_note || '', { name: 'trader_review_note', max: 500 });
      const trader = (await pool.query(`SELECT ${accountTraderFields} FROM traders WHERE trader_id=$1 AND owner_user_id IS NOT NULL`, [traderId])).rows[0];
      if (!trader) throw new Error('trader_application_not_found');
      if (published && !(trader.onboarding_status === 'APPROVED' && trader.verification_status === 'VERIFIED' && trader.verified === true && trader.status === 'ACTIVE' && trader.mode === 'SHADOW' && trader.verification_reference)) {
        throw new Error('trader_publication_gate_failed');
      }
      return (await pool.query(
        `UPDATE traders SET published=$1,review_note=CASE WHEN $2='' THEN review_note ELSE $2 END,updated_at=now() WHERE trader_id=$3 RETURNING ${accountTraderFields}`,
        [published,note,traderId]
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
