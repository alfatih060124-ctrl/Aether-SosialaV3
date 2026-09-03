CREATE TABLE autotrade_runtime_risk_snapshots (
  policy_id UUID PRIMARY KEY REFERENCES copy_policies(id) ON DELETE CASCADE,
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  capital_limit_usd NUMERIC(28,10) NOT NULL CHECK (capital_limit_usd > 0),
  available_capital_usd NUMERIC(28,10) NOT NULL CHECK (available_capital_usd >= 0 AND available_capital_usd <= capital_limit_usd),
  daily_realized_pnl_usd NUMERIC(28,10) NOT NULL,
  trades_today INTEGER NOT NULL CHECK (trades_today >= 0),
  max_trades_per_day INTEGER NOT NULL CHECK (max_trades_per_day > 0),
  cooldown_seconds INTEGER NOT NULL CHECK (cooldown_seconds >= 0),
  seconds_since_last_trade INTEGER NOT NULL CHECK (seconds_since_last_trade >= 0),
  min_signal_score NUMERIC(8,4) NOT NULL CHECK (min_signal_score >= 0 AND min_signal_score <= 100),
  exit_quality_floor NUMERIC(8,4) NOT NULL CHECK (exit_quality_floor >= 0 AND exit_quality_floor <= 100),
  allowed_tokens JSONB NOT NULL CHECK (jsonb_typeof(allowed_tokens) = 'array'),
  authoritative BOOLEAN NOT NULL DEFAULT true CHECK (authoritative = true),
  live_execution_authorized BOOLEAN NOT NULL DEFAULT false CHECK (live_execution_authorized = false),
  network_submission_authorized BOOLEAN NOT NULL DEFAULT false CHECK (network_submission_authorized = false),
  signer_required BOOLEAN NOT NULL DEFAULT false CHECK (signer_required = false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX autotrade_runtime_risk_follower_idx
  ON autotrade_runtime_risk_snapshots(follower_user_id, observed_at DESC);
