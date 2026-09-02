import crypto from 'node:crypto';

const clampTtlSeconds = value => {
  const n = Number(value || 1800);
  if (!Number.isInteger(n)) return 1800;
  return Math.min(Math.max(n, 300), 43200);
};

const hashToken = token => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

export const ADMIN_SESSION_COOKIE = 'aether_admin_session';

export function createAdminAuthService(pool, options = {}) {
  const ttlSeconds = clampTtlSeconds(options.ttlSeconds ?? process.env.ADMIN_SESSION_TTL_SECONDS);
  const bootstrapSecret = String(options.bootstrapSecret ?? process.env.ADMIN_API_TOKEN ?? '');

  const verifyBootstrapToken = token => safeEqual(token, bootstrapSecret);

  async function issueSession(token) {
    if (!verifyBootstrapToken(token)) throw new Error('admin_unauthorized');
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await pool.query(
      `INSERT INTO admin_sessions(session_id, token_hash, expires_at)
       VALUES($1,$2,$3)`,
      [sessionId, hashToken(rawToken), expiresAt],
    );
    return { token: rawToken, session_id: sessionId, expires_at: expiresAt.toISOString(), ttl_seconds: ttlSeconds };
  }

  async function getSession(token) {
    if (!token) return null;
    const q = await pool.query(
      `SELECT session_id, created_at, expires_at, last_seen_at
       FROM admin_sessions
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()
       LIMIT 1`,
      [hashToken(token)],
    );
    const row = q.rows[0];
    if (!row) return null;
    return {
      session_id: row.session_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
    };
  }

  async function revokeSession(token) {
    if (!token) return false;
    const q = await pool.query(
      `UPDATE admin_sessions SET revoked_at=now(), last_seen_at=now()
       WHERE token_hash=$1 AND revoked_at IS NULL
       RETURNING session_id`,
      [hashToken(token)],
    );
    return Boolean(q.rows[0]);
  }

  return { ttlSeconds, verifyBootstrapToken, issueSession, getSession, revokeSession };
}

export function adminSessionCookie(token, ttlSeconds) {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSeconds}`;
}

export function clearAdminSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
