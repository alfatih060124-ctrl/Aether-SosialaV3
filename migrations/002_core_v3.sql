CREATE TABLE IF NOT EXISTS traders (
  trader_id uuid PRIMARY KEY,
  wallet_address text NOT NULL UNIQUE,
  reputation_score numeric(8,4) NOT NULL DEFAULT 0,
  drawdown_bps integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_events (
  event_id text PRIMARY KEY,
  chain text NOT NULL,
  dex text NOT NULL,
  trader_wallet text NOT NULL,
  token_in text NOT NULL,
  token_out text NOT NULL,
  amount_in_raw numeric(78,0) NOT NULL,
  amount_out_raw numeric(78,0) NOT NULL,
  amount_usd numeric(30,10),
  tx_hash text NOT NULL UNIQUE,
  slot bigint NOT NULL,
  confidence numeric(5,4) NOT NULL,
  observed_at timestamptz NOT NULL,
  decoder_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copy_policies (
  policy_id uuid PRIMARY KEY,
  follower_user_id uuid NOT NULL,
  trader_id uuid NOT NULL REFERENCES traders(trader_id),
  enabled boolean NOT NULL DEFAULT true,
  max_copy_amount_usd numeric(30,10) NOT NULL DEFAULT 0,
  max_position_amount_usd numeric(30,10) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (follower_user_id, trader_id)
);

CREATE TABLE IF NOT EXISTS risk_decisions (
  decision_id uuid PRIMARY KEY,
  event_id text NOT NULL REFERENCES trade_events(event_id),
  follower_user_id uuid NOT NULL,
  decision text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_requests (
  execution_request_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  event_id text NOT NULL REFERENCES trade_events(event_id),
  follower_user_id uuid NOT NULL,
  requested_amount_usd numeric(30,10) NOT NULL,
  mode text NOT NULL DEFAULT 'SIMULATION',
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  actor text,
  entity_type text,
  entity_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_events_observed_at ON trade_events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_event ON risk_decisions(event_id);
CREATE INDEX IF NOT EXISTS idx_execution_requests_event ON execution_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
