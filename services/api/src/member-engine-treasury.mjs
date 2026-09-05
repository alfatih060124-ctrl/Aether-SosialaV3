const TREASURY_PURPOSE = 'TREASURY_VERIFY';

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

export async function issueRentalTreasuryChallenge(pool, walletAuth) {
  const treasury = await getRentalTreasury(pool);
  if (!treasury) throw new Error('rental_treasury_not_configured');
  if (treasury.status === 'VERIFIED') return { treasury, already_verified: true, challenge: null };
  const challenge = await walletAuth.issueChallenge({
    walletAddress: treasury.wallet_address,
    purpose: TREASURY_PURPOSE
  });
  return { treasury, already_verified: false, challenge };
}

export async function verifyRentalTreasuryOwnership(pool, walletAuth, {
  challengeId,
  walletAddress,
  signature,
  signatureEncoding = 'base64'
}) {
  const treasury = await getRentalTreasury(pool);
  if (!treasury) throw new Error('rental_treasury_not_configured');
  if (treasury.wallet_address !== walletAddress) throw new Error('rental_treasury_wallet_mismatch');
  if (treasury.status === 'VERIFIED') return { treasury, already_verified: true };

  const proof = await walletAuth.verifyOwnership({
    challengeId,
    walletAddress,
    purpose: TREASURY_PURPOSE,
    signature,
    signatureEncoding
  });

  const q = await pool.query(`
    UPDATE member_engine_treasuries
    SET status='VERIFIED',verified_at=now(),verification_method='SOLANA_SIGN_MESSAGE',updated_at=now()
    WHERE treasury_id=$1 AND status='PENDING'
    RETURNING treasury_id,network,payment_asset,wallet_address,status,verified_at,verification_method,created_at,updated_at
  `,[treasury.treasury_id]);

  if (!q.rows[0]) throw new Error('rental_treasury_verification_state_changed');
  return { treasury:q.rows[0], proof, already_verified:false };
}

export const RENTAL_TREASURY_VERIFY_PURPOSE = TREASURY_PURPOSE;
