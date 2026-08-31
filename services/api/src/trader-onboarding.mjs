import crypto from 'node:crypto';
import { verifySolanaMessageSignature, validateSolanaWallet } from './wallet-auth.mjs';

const MAX_DISPLAY_NAME = 64;
const MAX_BIO = 500;
const MAX_STRATEGY = 1200;
const DECISIONS = new Set(['APPROVE', 'REJECT']);

function cleanText(value, max, field, { required = false } = {}) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && !text) throw new Error(`${field}_required`);
  if (text.length > max) throw new Error(`invalid_${field}`);
  return text;
}

export function sanitizeTraderProfile(input = {}) {
  return {
    displayName: cleanText(input.display_name, MAX_DISPLAY_NAME, 'display_name', { required: true }),
    bio: cleanText(input.bio, MAX_BIO, 'bio'),
    strategySummary: cleanText(input.strategy_summary, MAX_STRATEGY, 'strategy_summary', { required: true }),
  };
}

const traderFields = `trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,performance_fee_bps,execution_fee_bps,owner_user_id,ownership_verified_at,onboarding_status,published,applied_at,reviewed_at,review_note,created_at,updated_at`;

export function createTraderOnboardingService(pool) {
  if (!pool) throw new Error('database_required');

  return {
    async getForUser(userId) {
      return (await pool.query(`SELECT ${traderFields} FROM traders WHERE owner_user_id=$1 LIMIT 1`, [userId])).rows[0] ?? null;
    },

    async listApplications(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
      return (await pool.query(`SELECT ${traderFields} FROM traders WHERE owner_user_id IS NOT NULL ORDER BY CASE onboarding_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 ELSE 2 END, applied_at DESC NULLS LAST, created_at DESC LIMIT $1`, [n])).rows;
    },

    async apply({ session, challengeId, walletAddress, signature, signatureEncoding = 'base64', profile }) {
      if (!session?.user_id || session.status !== 'ACTIVE') throw new Error('account_not_active');
      validateSolanaWallet(walletAddress);
      if (walletAddress !== session.primary_wallet) throw new Error('wallet_mismatch');
      if (!challengeId) throw new Error('challenge_id_required');
      const clean = sanitizeTraderProfile(profile);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = await client.query(`SELECT * FROM wallet_auth_challenges WHERE challenge_id=$1 FOR UPDATE`, [challengeId]);
        const challenge = q.rows[0];
        if (!challenge) throw new Error('auth_challenge_not_found');
        if (challenge.purpose !== 'BECOME_TRADER') throw new Error('invalid_auth_purpose');
        if (challenge.wallet_address !== walletAddress) throw new Error('wallet_mismatch');
        if (challenge.used_at) throw new Error('auth_challenge_used');
        if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new Error('auth_challenge_expired');
        if (!verifySolanaMessageSignature({ walletAddress, message: challenge.message, signature, signatureEncoding })) {
          throw new Error('invalid_wallet_signature');
        }

        const owned = (await client.query(`SELECT ${traderFields} FROM traders WHERE owner_user_id=$1 FOR UPDATE`, [session.user_id])).rows[0] ?? null;
        const byWallet = (await client.query(`SELECT trader_id,owner_user_id FROM traders WHERE wallet_address=$1 FOR UPDATE`, [walletAddress])).rows[0] ?? null;
        if (byWallet && String(byWallet.owner_user_id || '') !== String(session.user_id)) {
          throw new Error('wallet_already_registered_as_trader');
        }

        let trader;
        if (owned) {
          trader = (await client.query(
            `UPDATE traders SET wallet_address=$1,display_name=$2,bio=$3,strategy_summary=$4,status='PENDING',verified=false,mode='SHADOW',ownership_verified_at=now(),onboarding_status='PENDING',published=false,applied_at=now(),reviewed_at=NULL,review_note='',updated_at=now() WHERE trader_id=$5 RETURNING ${traderFields}`,
            [walletAddress, clean.displayName, clean.bio, clean.strategySummary, owned.trader_id]
          )).rows[0];
        } else {
          trader = (await client.query(
            `INSERT INTO traders(trader_id,wallet_address,display_name,bio,strategy_summary,reputation_score,drawdown_bps,status,verified,mode,total_return_bps,win_rate_bps,trades_count,followers_count,owner_user_id,ownership_verified_at,onboarding_status,published,applied_at,review_note) VALUES($1,$2,$3,$4,$5,0,0,'PENDING',false,'SHADOW',0,0,0,0,$6,now(),'PENDING',false,now(),'') RETURNING ${traderFields}`,
            [crypto.randomUUID(), walletAddress, clean.displayName, clean.bio, clean.strategySummary, session.user_id]
          )).rows[0];
        }

        await client.query(`UPDATE wallet_auth_challenges SET used_at=now() WHERE challenge_id=$1`, [challengeId]);
        await client.query(
          `INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload) VALUES('TRADER_APPLICATION_SUBMITTED',$1,'trader',$2,$3)`,
          [walletAddress, String(trader.trader_id), { user_id: session.user_id, wallet_address: walletAddress, ownership_verified: true, mode: 'SHADOW', published: false, live_execution_authorized: false }]
        );
        await client.query('COMMIT');
        return trader;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async review({ traderId, decision, note = '', published = true }) {
      const normalized = String(decision || '').toUpperCase();
      if (!DECISIONS.has(normalized)) throw new Error('invalid_trader_review_decision');
      const reviewNote = cleanText(note, 500, 'review_note');
      const approve = normalized === 'APPROVE';
      const publish = approve && Boolean(published);
      const row = (await pool.query(
        `UPDATE traders SET onboarding_status=$1,status=$2,verified=$3,published=$4,mode='SHADOW',reviewed_at=now(),review_note=$5,updated_at=now() WHERE trader_id=$6 AND owner_user_id IS NOT NULL RETURNING ${traderFields}`,
        [approve ? 'APPROVED' : 'REJECTED', approve ? 'ACTIVE' : 'SUSPENDED', approve, publish, reviewNote, traderId]
      )).rows[0] ?? null;
      return row;
    },
  };
}
