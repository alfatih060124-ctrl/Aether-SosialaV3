import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ALLOWED_PURPOSES = new Set(['LOGIN','LINK_WALLET','BECOME_TRADER','CHANGE_PRIMARY','RECOVERY']);
const ALLOWED_CONSENTS = new Set(['TERMS','RISK_DISCLOSURE','FEE_DISCLOSURE']);
const REQUIRED_INITIAL_CONSENTS = ['TERMS','RISK_DISCLOSURE','FEE_DISCLOSURE'];

export function hashOpaqueToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function decodeBase58(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('invalid_base58');
  const bytes = [0];
  for (const ch of value) {
    const digit = BASE58_MAP.get(ch);
    if (digit === undefined) throw new Error('invalid_base58');
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < value.length - 1 && value[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function validateSolanaWallet(walletAddress) {
  const raw = decodeBase58(walletAddress);
  if (raw.length !== 32) throw new Error('invalid_solana_wallet');
  return raw;
}

function decodeSignature(signature, encoding = 'base64') {
  if (typeof signature !== 'string' || !signature.length) throw new Error('signature_required');
  let raw;
  if (encoding === 'base58') raw = decodeBase58(signature);
  else if (encoding === 'base64') raw = Buffer.from(signature, 'base64');
  else throw new Error('invalid_signature_encoding');
  if (raw.length !== 64) throw new Error('invalid_signature');
  return raw;
}

export function verifySolanaMessageSignature({ walletAddress, message, signature, signatureEncoding = 'base64' }) {
  const rawPublicKey = validateSolanaWallet(walletAddress);
  const rawSignature = decodeSignature(signature, signatureEncoding);
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
    format: 'der',
    type: 'spki'
  });
  return crypto.verify(null, Buffer.from(String(message), 'utf8'), publicKey, rawSignature);
}

export function buildWalletChallengeMessage({ domain = 'aether.boats', walletAddress, purpose, nonce, issuedAt, expiresAt }) {
  return [
    'AETHER WALLET AUTHENTICATION',
    `Domain: ${domain}`,
    `Wallet: ${walletAddress}`,
    `Purpose: ${purpose}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    '',
    'Sign this message to prove wallet ownership.',
    'This is not a blockchain transaction and does not authorize a trade or transfer of funds.',
    'Aether will never ask for your seed phrase or private key.'
  ].join('\n');
}

function normalizePurpose(value) {
  const purpose = String(value || 'LOGIN').toUpperCase();
  if (!ALLOWED_PURPOSES.has(purpose)) throw new Error('invalid_auth_purpose');
  return purpose;
}

function sanitizeConsents(consents) {
  if (!Array.isArray(consents)) return [];
  return consents.map(item => {
    const type = String(item?.type || '').toUpperCase();
    const version = String(item?.version || '').trim();
    if (!ALLOWED_CONSENTS.has(type) || !version || version.length > 64) throw new Error('invalid_consent');
    return { type, version };
  });
}

function hasRequiredInitialConsents(consents) {
  const accepted = new Set(consents.map(item => item.type));
  return REQUIRED_INITIAL_CONSENTS.every(type => accepted.has(type));
}

export function createWalletAuthService(pool, options = {}) {
  if (!pool) throw new Error('database_required');
  const domain = options.domain || process.env.AETHER_AUTH_DOMAIN || 'aether.boats';
  const challengeTtlMs = Number(options.challengeTtlMs || 5 * 60 * 1000);
  const sessionTtlMs = Number(options.sessionTtlMs || 30 * 24 * 60 * 60 * 1000);

  return {
    async issueChallenge({ walletAddress, purpose = 'LOGIN' }) {
      validateSolanaWallet(walletAddress);
      const normalizedPurpose = normalizePurpose(purpose);
      const recent = await pool.query(
        `SELECT count(*)::int AS count FROM wallet_auth_challenges
         WHERE wallet_address=$1 AND created_at > now() - interval '1 minute'`,
        [walletAddress]
      );
      if (Number(recent.rows[0]?.count || 0) >= 5) throw new Error('auth_rate_limited');

      const challengeId = crypto.randomUUID();
      const nonce = crypto.randomBytes(24).toString('base64url');
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + challengeTtlMs);
      const message = buildWalletChallengeMessage({
        domain,
        walletAddress,
        purpose: normalizedPurpose,
        nonce,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      });
      await pool.query(
        `INSERT INTO wallet_auth_challenges(challenge_id,wallet_address,purpose,nonce_hash,message,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [challengeId, walletAddress, normalizedPurpose, hashOpaqueToken(nonce), message, expiresAt]
      );
      return {
        challenge_id: challengeId,
        wallet_address: walletAddress,
        purpose: normalizedPurpose,
        message,
        expires_at: expiresAt.toISOString(),
        transaction_required: false,
        funds_authorized: false
      };
    },

    async verifyLogin({ challengeId, walletAddress, signature, signatureEncoding = 'base64', consents = [] }) {
      validateSolanaWallet(walletAddress);
      const acceptedConsents = sanitizeConsents(consents);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = await client.query(
          `SELECT * FROM wallet_auth_challenges WHERE challenge_id=$1 FOR UPDATE`,
          [challengeId]
        );
        const challenge = q.rows[0];
        if (!challenge) throw new Error('auth_challenge_not_found');
        if (challenge.purpose !== 'LOGIN') throw new Error('invalid_auth_purpose');
        if (challenge.wallet_address !== walletAddress) throw new Error('wallet_mismatch');
        if (challenge.used_at) throw new Error('auth_challenge_used');
        if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new Error('auth_challenge_expired');
        if (!verifySolanaMessageSignature({ walletAddress, message: challenge.message, signature, signatureEncoding })) {
          throw new Error('invalid_wallet_signature');
        }

        const existing = await client.query(
          `SELECT a.* FROM user_accounts a
           JOIN user_wallets w ON w.user_id=a.user_id
           WHERE w.wallet_address=$1`,
          [walletAddress]
        );
        let user = existing.rows[0];
        let created = false;
        if (!user) {
          if (!hasRequiredInitialConsents(acceptedConsents)) throw new Error('required_consents_missing');
          const userId = crypto.randomUUID();
          user = (await client.query(
            `INSERT INTO user_accounts(user_id) VALUES($1) RETURNING *`,
            [userId]
          )).rows[0];
          await client.query(
            `INSERT INTO user_wallets(user_wallet_id,user_id,wallet_address,is_primary,verified_at)
             VALUES($1,$2,$3,true,now())`,
            [crypto.randomUUID(), userId, walletAddress]
          );
          created = true;
        }
        if (user.status !== 'ACTIVE') throw new Error('account_not_active');

        for (const consent of acceptedConsents) {
          await client.query(
            `INSERT INTO user_consents(consent_id,user_id,consent_type,policy_version)
             VALUES($1,$2,$3,$4) ON CONFLICT(user_id,consent_type,policy_version) DO NOTHING`,
            [crypto.randomUUID(), user.user_id, consent.type, consent.version]
          );
        }

        const sessionToken = crypto.randomBytes(32).toString('base64url');
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + sessionTtlMs);
        await client.query(
          `INSERT INTO wallet_auth_sessions(session_id,user_id,token_hash,expires_at)
           VALUES($1,$2,$3,$4)`,
          [sessionId, user.user_id, hashOpaqueToken(sessionToken), expiresAt]
        );
        await client.query(`UPDATE wallet_auth_challenges SET used_at=now() WHERE challenge_id=$1`, [challengeId]);
        await client.query(
          `INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload)
           VALUES('WALLET_LOGIN_VERIFIED',$1,'user_account',$2,$3)`,
          [walletAddress, String(user.user_id), { wallet_address: walletAddress, account_created: created, private_key_stored: false }]
        );
        await client.query('COMMIT');
        return {
          user: {
            user_id: user.user_id,
            username: user.username,
            display_name: user.display_name,
            status: user.status,
            primary_wallet: walletAddress
          },
          account_created: created,
          session: {
            session_id: sessionId,
            token: sessionToken,
            expires_at: expiresAt.toISOString()
          }
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async verifyOwnership({ challengeId, walletAddress, purpose, signature, signatureEncoding = 'base64' }) {
      validateSolanaWallet(walletAddress);
      const normalizedPurpose = normalizePurpose(purpose);
      if (normalizedPurpose === 'LOGIN') throw new Error('invalid_auth_purpose');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = await client.query(`SELECT * FROM wallet_auth_challenges WHERE challenge_id=$1 FOR UPDATE`, [challengeId]);
        const challenge = q.rows[0];
        if (!challenge) throw new Error('auth_challenge_not_found');
        if (challenge.purpose !== normalizedPurpose) throw new Error('invalid_auth_purpose');
        if (challenge.wallet_address !== walletAddress) throw new Error('wallet_mismatch');
        if (challenge.used_at) throw new Error('auth_challenge_used');
        if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new Error('auth_challenge_expired');
        if (!verifySolanaMessageSignature({ walletAddress, message: challenge.message, signature, signatureEncoding })) {
          throw new Error('invalid_wallet_signature');
        }
        await client.query(`UPDATE wallet_auth_challenges SET used_at=now() WHERE challenge_id=$1`, [challengeId]);
        await client.query('COMMIT');
        return {
          verified: true,
          wallet_address: walletAddress,
          purpose: normalizedPurpose,
          verified_at: new Date().toISOString(),
          transaction_authorized: false,
          funds_authorized: false
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getSession(sessionToken) {
      if (!sessionToken) return null;
      const q = await pool.query(
        `SELECT s.session_id,s.user_id,s.expires_at,a.username,a.display_name,a.status,
                w.wallet_address AS primary_wallet
         FROM wallet_auth_sessions s
         JOIN user_accounts a ON a.user_id=s.user_id
         LEFT JOIN user_wallets w ON w.user_id=a.user_id AND w.is_primary=true
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
        [hashOpaqueToken(sessionToken)]
      );
      const row = q.rows[0];
      if (!row || row.status !== 'ACTIVE') return null;
      await pool.query(`UPDATE wallet_auth_sessions SET last_seen_at=now() WHERE session_id=$1`, [row.session_id]);
      return row;
    },

    async revokeSession(sessionToken) {
      if (!sessionToken) return false;
      const q = await pool.query(
        `UPDATE wallet_auth_sessions SET revoked_at=COALESCE(revoked_at,now())
         WHERE token_hash=$1 AND revoked_at IS NULL RETURNING session_id`,
        [hashOpaqueToken(sessionToken)]
      );
      return Boolean(q.rows[0]);
    }
  };
}
