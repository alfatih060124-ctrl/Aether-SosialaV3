CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- ADMIN_API_TOKEN is a bootstrap secret only. The browser receives a short-lived,
-- opaque session token via an HttpOnly host-only cookie; no raw admin secret is stored here.
