CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trader_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  reputation_score NUMERIC(8,4),
  drawdown_bps INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE follows (
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trader_id UUID NOT NULL REFERENCES trader_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, trader_id)
);

CREATE TABLE copy_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trader_id UUID NOT NULL REFERENCES trader_profiles(id) ON DELETE CASCADE,
  policy_type TEXT NOT NULL CHECK (policy_type IN ('FIXED_USD','PERCENT_EQUITY','CAPPED_PROPORTIONAL')),
  value NUMERIC(28,10) NOT NULL CHECK (value > 0),
  max_copy_amount_usd NUMERIC(28,10) NOT NULL CHECK (max_copy_amount_usd > 0),
  max_position_amount_usd NUMERIC(28,10) NOT NULL CHECK (max_position_amount_usd > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trade_events (
  event_id UUID PRIMARY KEY,
  chain TEXT NOT NULL,
  dex TEXT NOT NULL,
  trader_wallet TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in_raw NUMERIC(78,0) NOT NULL,
  amount_out_raw NUMERIC(78,0) NOT NULL,
  amount_usd NUMERIC(28,10),
  tx_hash TEXT NOT NULL,
  slot BIGINT NOT NULL,
  slippage_bps INTEGER,
  confidence NUMERIC(8,6) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  decoder_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, decoder_version)
);
CREATE INDEX trade_events_trader_observed_idx ON trade_events(trader_wallet, observed_at DESC);
CREATE INDEX trade_events_slot_idx ON trade_events(slot DESC);

CREATE TABLE risk_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES trade_events(event_id) ON DELETE RESTRICT,
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason_code TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_decisions_event_idx ON risk_decisions(event_id);

CREATE TABLE execution_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_id UUID REFERENCES trade_events(event_id) ON DELETE RESTRICT,
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('SHADOW','PAPER','LIVE')) DEFAULT 'SHADOW',
  status TEXT NOT NULL CHECK (status IN ('PENDING','SIMULATED','SUBMITTED','CONFIRMED','REJECTED','FAILED')) DEFAULT 'PENDING',
  requested_amount_usd NUMERIC(28,10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE execution_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_request_id UUID NOT NULL UNIQUE REFERENCES execution_requests(id) ON DELETE RESTRICT,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('SIMULATED','SUBMITTED','CONFIRMED','FAILED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE circuit_breakers (
  name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE system_health (
  service_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('HEALTHY','DEGRADED','DOWN')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
