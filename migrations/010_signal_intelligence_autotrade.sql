-- Aether Signal Intelligence + quality-first Auto Trade foundation.
-- This migration is intentionally SHADOW-only: no signing material, no live execution.

CREATE TABLE IF NOT EXISTS signal_assessments (
  assessment_id uuid PRIMARY KEY,
  source_type text NOT NULL DEFAULT 'MACHINE_INTELLIGENCE' CHECK (source_type='MACHINE_INTELLIGENCE'),
  token_mint text NOT NULL,
  quote_mint text,
  quality_score numeric(6,2) NOT NULL CHECK (quality_score >= 0 AND quality_score <= 100),
  verdict text NOT NULL CHECK (verdict IN ('QUALIFIED','WATCH','REJECTED')),
  hard_rejects jsonb NOT NULL DEFAULT '[]'::jsonb,
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_assessments_token_created
  ON signal_assessments(token_mint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_assessments_verdict_score
  ON signal_assessments(verdict, quality_score DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS algorithmic_strategies (
  strategy_id uuid PRIMARY KEY,
  owner_user_id uuid,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  min_signal_score numeric(6,2) NOT NULL DEFAULT 82 CHECK (min_signal_score >= 0 AND min_signal_score <= 100),
  capital_limit_usd numeric(30,10) NOT NULL DEFAULT 0 CHECK (capital_limit_usd >= 0),
  max_trade_usd numeric(30,10) NOT NULL DEFAULT 0 CHECK (max_trade_usd >= 0),
  max_daily_loss_usd numeric(30,10) NOT NULL DEFAULT 0 CHECK (max_daily_loss_usd >= 0),
  max_trades_per_day integer NOT NULL DEFAULT 6 CHECK (max_trades_per_day > 0 AND max_trades_per_day <= 100),
  cooldown_seconds integer NOT NULL DEFAULT 1800 CHECK (cooldown_seconds >= 0),
  max_slippage_bps integer NOT NULL DEFAULT 100 CHECK (max_slippage_bps > 0 AND max_slippage_bps <= 1000),
  stop_loss_bps integer NOT NULL DEFAULT 500 CHECK (stop_loss_bps > 0 AND stop_loss_bps <= 5000),
  trailing_stop_bps integer NOT NULL DEFAULT 350 CHECK (trailing_stop_bps > 0 AND trailing_stop_bps <= 5000),
  allowed_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_trade_decisions (
  decision_id uuid PRIMARY KEY,
  assessment_id uuid REFERENCES signal_assessments(assessment_id),
  strategy_id uuid REFERENCES algorithmic_strategies(strategy_id),
  source_type text NOT NULL DEFAULT 'ALGORITHMIC_STRATEGY' CHECK (source_type='ALGORITHMIC_STRATEGY'),
  token_mint text,
  action text NOT NULL CHECK (action IN ('BUY','SELL','HOLD','REJECT')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_amount_usd numeric(30,10) NOT NULL DEFAULT 0 CHECK (requested_amount_usd >= 0),
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized=false),
  mandate jsonb NOT NULL DEFAULT '{}'::jsonb,
  position jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_trade_decisions_created
  ON auto_trade_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_trade_decisions_token_action
  ON auto_trade_decisions(token_mint, action, created_at DESC);

INSERT INTO audit_events(event_type,actor,entity_type,entity_id,payload)
SELECT 'SIGNAL_INTELLIGENCE_FOUNDATION_INSTALLED','system','runtime','signal-intelligence-v1',
       jsonb_build_object('mode','SHADOW','quality_first',true,'live_execution_authorized',false)
WHERE NOT EXISTS (
  SELECT 1 FROM audit_events
  WHERE event_type='SIGNAL_INTELLIGENCE_FOUNDATION_INSTALLED'
    AND entity_id='signal-intelligence-v1'
);
