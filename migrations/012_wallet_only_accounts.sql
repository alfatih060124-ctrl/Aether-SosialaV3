CREATE TABLE IF NOT EXISTS user_accounts (
  user_id uuid PRIMARY KEY,
  username text,
  display_name text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_username_lower
  ON user_accounts (lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_wallets (
  user_wallet_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  chain text NOT NULL DEFAULT 'SOLANA' CHECK (chain = 'SOLANA'),
  wallet_address text NOT NULL UNIQUE,
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_wallets_one_primary
  ON user_wallets(user_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets(user_id);

CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
  challenge_id uuid PRIMARY KEY,
  wallet_address text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('LOGIN','LINK_WALLET','BECOME_TRADER','CHANGE_PRIMARY','RECOVERY')),
  nonce_hash char(64) NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_auth_challenges_wallet_created
  ON wallet_auth_challenges(wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_auth_challenges_expiry
  ON wallet_auth_challenges(expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS wallet_auth_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_auth_sessions_user
  ON wallet_auth_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_auth_sessions_active_expiry
  ON wallet_auth_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_consents (
  consent_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  consent_type text NOT NULL CHECK (consent_type IN ('TERMS','RISK_DISCLOSURE','FEE_DISCLOSURE')),
  policy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, consent_type, policy_version)
);

ALTER TABLE traders ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES user_accounts(user_id) ON DELETE SET NULL;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS ownership_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_traders_owner_user ON traders(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Wallet-only V1 stores public addresses and authentication/session metadata only.
-- Seed phrases, private keys, recovery phrases, and KYC identity documents are intentionally absent.
