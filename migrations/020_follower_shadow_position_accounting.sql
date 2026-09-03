-- AETHER follower position accounting foundation.
-- SHADOW only. This schema stores no signing material and cannot authorize LIVE execution.

CREATE TABLE IF NOT EXISTS follower_shadow_accounting_state (
  follower_user_id uuid PRIMARY KEY REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  accounting_ready boolean NOT NULL DEFAULT false,
  complete_through timestamptz,
  source_cursor text,
  source_version text,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (accounting_ready=false OR complete_through IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS follower_shadow_positions (
  position_id uuid PRIMARY KEY,
  follower_user_id uuid NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES copy_policies(policy_id) ON DELETE RESTRICT,
  trader_id uuid NOT NULL REFERENCES traders(trader_id) ON DELETE RESTRICT,
  token_mint text NOT NULL,
  quote_mint text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','CLOSING','CLOSED')),
  token_quantity numeric(38,18) NOT NULL DEFAULT 0 CHECK (token_quantity >= 0),
  cost_basis_usdc numeric(30,10) NOT NULL DEFAULT 0 CHECK (cost_basis_usdc >= 0),
  realized_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  last_mark_price_usdc numeric(30,12),
  mark_observed_at timestamptz,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_mark_price_usdc IS NULL OR last_mark_price_usdc > 0),
  CHECK ((status='CLOSED' AND closed_at IS NOT NULL) OR status<>'CLOSED')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_follower_shadow_open_position
  ON follower_shadow_positions(follower_user_id, policy_id, token_mint, quote_mint)
  WHERE status IN ('OPEN','CLOSING');
CREATE INDEX IF NOT EXISTS idx_follower_shadow_positions_user_status
  ON follower_shadow_positions(follower_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS follower_shadow_position_events (
  event_id uuid PRIMARY KEY,
  position_id uuid NOT NULL REFERENCES follower_shadow_positions(position_id) ON DELETE CASCADE,
  follower_user_id uuid NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES copy_policies(policy_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('OPEN','INCREASE','DECREASE','CLOSE','MARK')),
  token_delta numeric(38,18) NOT NULL DEFAULT 0,
  usdc_delta numeric(30,10) NOT NULL DEFAULT 0,
  realized_pnl_usdc numeric(30,10) NOT NULL DEFAULT 0,
  mark_price_usdc numeric(30,12),
  source_type text NOT NULL,
  source_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mark_price_usdc IS NULL OR mark_price_usdc > 0)
);

CREATE INDEX IF NOT EXISTS idx_follower_shadow_events_user_occurred
  ON follower_shadow_position_events(follower_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_follower_shadow_events_position_occurred
  ON follower_shadow_position_events(position_id, occurred_at ASC);

INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload)
SELECT 'FOLLOWER_SHADOW_POSITION_ACCOUNTING_SCHEMA_INSTALLED','system','runtime','follower-shadow-position-accounting-v1',
       jsonb_build_object('mode','SHADOW','accounting_ready_default',false,'live_execution_authorized',false)
WHERE NOT EXISTS (
  SELECT 1 FROM audit_events
  WHERE event_type='FOLLOWER_SHADOW_POSITION_ACCOUNTING_SCHEMA_INSTALLED'
    AND entity_id='follower-shadow-position-accounting-v1'
);
