import crypto from 'node:crypto';
import { hashOpaqueToken, verifySolanaMessageSignature, validateSolanaWallet } from './wallet-auth.mjs';

const TREASURY_PURPOSE = 'TREASURY_VERIFY';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function getRentalTreasury(pool) {
  const q = await pool.query(`
    SELECT treasury_id,network,payment_asset,wallet_address,status,verified_at,verification_method,created_at,updated_at
    FROM member_engine_treasuries
    WHERE network='SOLANA' AND payment_asset='USDC' AND status IN ('VERIFIED','PENDING')
    ORDER BY CASE status WHEN 'VERIFIED' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `);
  return q.rows[0] ?? null;
}

export async function issueRentalTreasuryChallenge(pool) {
  const treasury = await getRentalTreasury(pool);
  if (!treasury) throw new Error('rental_treasury_not_configured');
  if (treasury.status === 'VERIFIED') return { treasury, already_verified: true, challenge: null };

  validateSolanaWallet(treasury.wallet_address);
  const recent = await pool.query(`
    SELECT count(*)::int AS count FROM wallet_auth_challenges
    WHERE wallet_address=$1 AND purpose=$2 AND created_at > now() - interval '1 minute'
  `,[treasury.wallet_address,TREASURY_PURPOSE]);
  if (Number(recent.rows[0]?.count || 0) >= 5) throw new Error('auth_rate_limited');

  const challengeId = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = [
    'AETHER TREASURY OWNERSHIP VERIFICATION',
    'Domain: aether.boats',
    `Wallet: ${treasury.wallet_address}`,
    'Network: Solana',
    'Asset: USDC',
    `Purpose: ${TREASURY_PURPOSE}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expires At: ${expiresAt.toISOString()}`,
    '',
    'Sign this message in Solflare to prove ownership of the AETHER rental treasury.',
    'This is not a blockchain transaction and does not authorize any transfer of funds.',
    'AETHER will never ask for your seed phrase or private key.'
  ].join('\n');

  await pool.query(`
    INSERT INTO wallet_auth_challenges(challenge_id,wallet_address,purpose,nonce_hash,message,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)
  `,[challengeId,treasury.wallet_address,TREASURY_PURPOSE,hashOpaqueToken(nonce),message,expiresAt]);

  return {
    treasury,
    already_verified:false,
    challenge:{
      challenge_id:challengeId,
      wallet_address:treasury.wallet_address,
      purpose:TREASURY_PURPOSE,
      message,
      expires_at:expiresAt.toISOString(),
      transaction_required:false,
      funds_authorized:false,
      wallet_provider_hint:'SOLFLARE'
    }
  };
}

export async function verifyRentalTreasuryOwnership(pool, {
  challengeId,
  walletAddress,
  signature,
  signatureEncoding = 'base64'
}) {
  const treasury = await getRentalTreasury(pool);
  if (!treasury) throw new Error('rental_treasury_not_configured');
  if (treasury.wallet_address !== walletAddress) throw new Error('rental_treasury_wallet_mismatch');
  if (treasury.status === 'VERIFIED') return { treasury, already_verified: true };
  validateSolanaWallet(walletAddress);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(`SELECT * FROM wallet_auth_challenges WHERE challenge_id=$1 FOR UPDATE`,[challengeId]);
    const challenge = q.rows[0];
    if (!challenge) throw new Error('auth_challenge_not_found');
    if (challenge.purpose !== TREASURY_PURPOSE) throw new Error('invalid_auth_purpose');
    if (challenge.wallet_address !== walletAddress) throw new Error('wallet_mismatch');
    if (challenge.used_at) throw new Error('auth_challenge_used');
    if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new Error('auth_challenge_expired');
    if (!verifySolanaMessageSignature({ walletAddress, message:challenge.message, signature, signatureEncoding })) {
      throw new Error('invalid_wallet_signature');
    }

    await client.query(`UPDATE wallet_auth_challenges SET used_at=now() WHERE challenge_id=$1`,[challengeId]);
    const updated = await client.query(`
      UPDATE member_engine_treasuries
      SET status='VERIFIED',verified_at=now(),verification_method='SOLANA_SIGN_MESSAGE',updated_at=now()
      WHERE treasury_id=$1 AND status='PENDING'
      RETURNING treasury_id,network,payment_asset,wallet_address,status,verified_at,verification_method,created_at,updated_at
    `,[treasury.treasury_id]);
    if (!updated.rows[0]) throw new Error('rental_treasury_verification_state_changed');

    await client.query('COMMIT');
    return {
      treasury:updated.rows[0],
      proof:{
        verified:true,
        wallet_address:walletAddress,
        purpose:TREASURY_PURPOSE,
        transaction_authorized:false,
        funds_authorized:false
      },
      already_verified:false
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const RENTAL_TREASURY_VERIFY_PURPOSE = TREASURY_PURPOSE;
