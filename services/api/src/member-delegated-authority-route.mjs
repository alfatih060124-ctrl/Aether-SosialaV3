import {
  createDelegatedAuthorityIntent,
  activateDelegatedAuthority,
  buildDelegatedAuthorityConsentMessage,
  revokeDelegatedAuthority
} from './member-delegated-authority.mjs';
import { verifySolanaMessageSignature } from './wallet-auth.mjs';
import crypto from 'node:crypto';

export const MEMBER_AUTHORITY_ROUTE = '/api/account/delegated-authority';
export const MEMBER_AUTHORITY_CHALLENGE_ROUTE = '/api/account/delegated-authority/challenge';
export const MEMBER_AUTHORITY_VERIFY_ROUTE = '/api/account/delegated-authority/verify';
export const MEMBER_AUTHORITY_REVOKE_ROUTE = '/api/account/delegated-authority/revoke';

const hash = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

async function parseBody(req, providedParser) {
  if (typeof providedParser === 'function') return providedParser(req);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 32768) throw new Error('request_body_too_large');
  }
  return raw ? JSON.parse(raw) : {};
}

function project(row) {
  if (!row) return null;
  return {
    authority_id: row.authority_id,
    wallet_address: row.wallet_address,
    status: row.status,
    authority_type: row.authority_type,
    max_notional_usdc_atomic: String(row.max_notional_usdc_atomic),
    max_daily_loss_usdc_atomic: String(row.max_daily_loss_usdc_atomic),
    allowed_strategy: row.allowed_strategy,
    allowed_dex_pair: row.allowed_dex_pair,
    min_net_edge_bps: Number(row.min_net_edge_bps),
    issued_at: new Date(row.issued_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    live_execution_authorized: false,
    transaction_submission_authorized: false,
    private_key_stored: false,
    signer_material_stored: false
  };
}

async function expireStale(pool, userId) {
  await pool.query(`UPDATE member_delegated_authorities SET status='EXPIRED', updated_at=now() WHERE user_id=$1 AND status='ACTIVE' AND expires_at<=now()`, [userId]);
}

export async function handleMemberDelegatedAuthorityRoute({ req, res, route, pool, walletAuth, sessionFor, jsonBody, send }) {
  const routes = new Set([MEMBER_AUTHORITY_ROUTE, MEMBER_AUTHORITY_CHALLENGE_ROUTE, MEMBER_AUTHORITY_VERIFY_ROUTE, MEMBER_AUTHORITY_REVOKE_ROUTE]);
  if (!routes.has(route)) return false;
  if (!pool || !walletAuth) { send(res,503,{error:'database_unconfigured',live_execution_authorized:false}); return true; }
  const session = await sessionFor(req);
  if (!session) { send(res,401,{error:'session_required',live_execution_authorized:false}); return true; }

  try {
    if (route === MEMBER_AUTHORITY_ROUTE) {
      if (req.method !== 'GET') { send(res,405,{error:'method_not_allowed',live_execution_authorized:false}); return true; }
      await expireStale(pool, session.user_id);
      const q = await pool.query(`SELECT * FROM member_delegated_authorities WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [session.user_id]);
      send(res,200,{authority:project(q.rows[0]),authentication:'WALLET_SESSION',mode:'SHADOW',live_execution_authorized:false});
      return true;
    }

    if (req.method !== 'POST') { send(res,405,{error:'method_not_allowed',live_execution_authorized:false}); return true; }
    const body = await parseBody(req, jsonBody);

    if (route === MEMBER_AUTHORITY_CHALLENGE_ROUTE) {
      await expireStale(pool, session.user_id);
      const now = new Date();
      const ttlDays = Math.max(1, Math.min(30, Number(body?.ttl_days || 30)));
      const intent = createDelegatedAuthorityIntent({
        user_id: session.user_id,
        wallet_address: session.primary_wallet,
        max_notional_usdc_atomic: body?.max_notional_usdc_atomic,
        max_daily_loss_usdc_atomic: body?.max_daily_loss_usdc_atomic,
        issued_at: now,
        expires_at: new Date(now.getTime() + ttlDays * 86400000)
      });
      await pool.query(`INSERT INTO member_delegated_authorities(authority_id,user_id,wallet_address,authority_type,status,max_notional_usdc_atomic,max_daily_loss_usdc_atomic,allowed_strategy,allowed_dex_pair,min_net_edge_bps,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [intent.authority_id,intent.user_id,intent.wallet_address,intent.authority_type,intent.status,intent.max_notional_usdc_atomic,intent.max_daily_loss_usdc_atomic,intent.allowed_strategy,intent.allowed_dex_pair,intent.min_net_edge_bps,intent.issued_at,intent.expires_at]);
      send(res,201,{challenge:{challenge_id:intent.authority_id,authority_id:intent.authority_id,wallet_address:intent.wallet_address,message:intent.consent_message,message_sha256:intent.consent_message_sha256,expires_at:intent.expires_at,signature_encoding:'base64_or_base58'},mode:'SHADOW',live_execution_authorized:false});
      return true;
    }

    const authorityId = String(body?.authority_id || body?.challenge_id || '').trim();
    if (!authorityId) throw new Error('authority_id_required');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = await client.query(`SELECT * FROM member_delegated_authorities WHERE authority_id=$1 AND user_id=$2 FOR UPDATE`, [authorityId, session.user_id]);
      const row = q.rows[0];
      if (!row) throw new Error('authority_not_found');

      if (route === MEMBER_AUTHORITY_REVOKE_ROUTE) {
        const revoked = revokeDelegatedAuthority(project(row));
        await client.query(`UPDATE member_delegated_authorities SET status='REVOKED', revoked_at=$1, updated_at=now() WHERE authority_id=$2`, [revoked.revoked_at, authorityId]);
        await client.query('COMMIT');
        send(res,200,{authority:{...project(row),status:'REVOKED',revoked_at:revoked.revoked_at},live_execution_authorized:false});
        return true;
      }

      if (route !== MEMBER_AUTHORITY_VERIFY_ROUTE) throw new Error('authority_route_invalid');
      if (row.status !== 'PENDING_CONSENT') throw new Error('authority_not_pending_consent');
      const intentBase = project(row);
      const message = buildDelegatedAuthorityConsentMessage(intentBase);
      const messageHash = hash(message);
      const signature = String(body?.signature || '');
      const signatureEncoding = body?.signature_encoding === 'base58' ? 'base58' : 'base64';
      const verified = verifySolanaMessageSignature({walletAddress:session.primary_wallet,message,signature,signatureEncoding});
      if (!verified) throw new Error('invalid_wallet_signature');
      const intent = Object.freeze({...intentBase,user_id:session.user_id,consent_message:message,consent_message_sha256:messageHash});
      const active = activateDelegatedAuthority(intent,{challenge_id:authorityId,ownership_verified:true,verified_wallet_address:session.primary_wallet,verified_authority_id:authorityId,verified_message:message,verified_message_sha256:messageHash,verified_at:new Date()});
      await client.query(`UPDATE member_delegated_authorities SET status='ACTIVE', activated_at=$1, consent_challenge_id=$2, consent_verified_at=$3, updated_at=now() WHERE authority_id=$4`, [active.activated_at,authorityId,active.consent_verified_at,authorityId]);
      await client.query('COMMIT');
      send(res,200,{authority:{...project(row),status:'ACTIVE',activated_at:active.activated_at},ownership_verified:true,mode:'SHADOW',live_execution_authorized:false,transaction_submission_authorized:false});
      return true;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if (error?.code === '23505') throw new Error('active_authority_exists');
      throw error;
    } finally { client.release(); }
  } catch (error) {
    const code = String(error?.message || 'delegated_authority_failed');
    const status = code === 'authority_not_found' ? 404 : ['authority_not_pending_consent','authority_not_revocable','active_authority_exists'].includes(code) ? 409 : ['invalid_wallet_signature'].includes(code) ? 401 : code === 'request_body_too_large' ? 413 : code.endsWith('_required') || code.endsWith('_invalid') || code.includes('_mismatch') ? 400 : 500;
    send(res,status,{error:code,mode:'SHADOW',live_execution_authorized:false,transaction_submission_authorized:false,private_key_stored:false});
    return true;
  }
}
