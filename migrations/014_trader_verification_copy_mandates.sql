ALTER TABLE traders ADD COLUMN IF NOT EXISTS verification_source text NOT NULL DEFAULT '';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verification_reference text NOT NULL DEFAULT '';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verification_observed_at timestamptz;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verification_note text NOT NULL DEFAULT '';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE TABLE IF NOT EXISTS trader_verification_evidence (
  evidence_id uuid PRIMARY KEY,
  trader_id uuid NOT NULL REFERENCES traders(trader_id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_reference text NOT NULL,
  observed_at timestamptz NOT NULL,
  trades_count integer NOT NULL,
  total_return_bps integer NOT NULL,
  win_rate_bps integer NOT NULL,
  drawdown_bps integer NOT NULL,
  reputation_score numeric(8,4) NOT NULL,
  evidence_status text NOT NULL DEFAULT 'RECORDED',
  review_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_trader_verification_evidence_trader
  ON trader_verification_evidence(trader_id, created_at DESC);

ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'SHADOW';
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS allocation_bps integer NOT NULL DEFAULT 1000;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS max_slippage_bps integer NOT NULL DEFAULT 100;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS max_daily_loss_bps integer NOT NULL DEFAULT 300;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS stop_drawdown_bps integer NOT NULL DEFAULT 1500;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS live_execution_authorized boolean NOT NULL DEFAULT false;

UPDATE copy_policies
SET mode='SHADOW', live_execution_authorized=false
WHERE mode IS DISTINCT FROM 'SHADOW' OR live_execution_authorized IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS idx_copy_policies_follower_status
  ON copy_policies(follower_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_copy_policies_trader_status
  ON copy_policies(trader_id, status, updated_at DESC);

-- Verification evidence is stored separately so public metrics have an audit trail.
-- Copy mandates are deliberately SHADOW-only and cannot authorize LIVE execution.
