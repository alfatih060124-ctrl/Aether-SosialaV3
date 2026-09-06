BEGIN;

CREATE TABLE IF NOT EXISTS member_delegated_authorities (
  authority_id text PRIMARY KEY,
  user_id text NOT NULL,
  wallet_address text NOT NULL,
  authority_type text NOT NULL CHECK (authority_type = 'AUTOTRADE_SESSION'),
  status text NOT NULL CHECK (status IN ('PENDING_CONSENT','ACTIVE','REVOKED','EXPIRED')),
  max_notional_usdc_atomic bigint NOT NULL CHECK (max_notional_usdc_atomic > 0),
  max_daily_loss_usdc_atomic bigint NOT NULL CHECK (max_daily_loss_usdc_atomic >= 0),
  allowed_strategy text NOT NULL CHECK (allowed_strategy = 'TWO_LEG_ARBITRAGE'),
  allowed_dex_pair text NOT NULL CHECK (allowed_dex_pair = 'ORCA_RAYDIUM'),
  min_net_edge_bps integer NOT NULL CHECK (min_net_edge_bps >= 20),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  consent_challenge_id text,
  consent_verified_at timestamptz,
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized = false),
  private_key_stored boolean NOT NULL DEFAULT false CHECK (private_key_stored = false),
  signer_material_stored boolean NOT NULL DEFAULT false CHECK (signer_material_stored = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS member_delegated_authorities_user_idx
  ON member_delegated_authorities(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS member_delegated_authorities_one_active_idx
  ON member_delegated_authorities(user_id)
  WHERE status = 'ACTIVE';

COMMIT;
