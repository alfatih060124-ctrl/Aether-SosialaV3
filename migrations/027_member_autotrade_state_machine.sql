CREATE TABLE IF NOT EXISTS member_autotrade_states (
  user_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'STOPPED' CHECK (state IN ('STOPPED','RUNNING_SCANNING','EXECUTING','SETTLING','PAUSED')),
  execution_mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (execution_mode = 'SHADOW'),
  state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (live_execution_authorized = FALSE),
  transaction_submission_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (transaction_submission_authorized = FALSE),
  signer_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (signer_authorized = FALSE),
  fund_movement_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (fund_movement_authorized = FALSE)
);

CREATE INDEX IF NOT EXISTS member_autotrade_states_state_idx
  ON member_autotrade_states(state);
