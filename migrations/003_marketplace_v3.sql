ALTER TABLE traders ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT 'Aether Trader';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'SHADOW';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS total_return_bps integer NOT NULL DEFAULT 0;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS win_rate_bps integer NOT NULL DEFAULT 0;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS trades_count integer NOT NULL DEFAULT 0;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS followers_count integer NOT NULL DEFAULT 0;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS performance_fee_bps integer NOT NULL DEFAULT 1000;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS execution_fee_bps integer NOT NULL DEFAULT 25;

CREATE TABLE IF NOT EXISTS platform_fee_config (
  config_id integer PRIMARY KEY,
  performance_fee_bps integer NOT NULL DEFAULT 1000,
  execution_fee_bps integer NOT NULL DEFAULT 25,
  currency text NOT NULL DEFAULT 'USD',
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_fee_config(config_id, performance_fee_bps, execution_fee_bps, currency, enabled)
VALUES (1, 1000, 25, 'USD', true)
ON CONFLICT (config_id) DO NOTHING;

INSERT INTO traders (
  trader_id, wallet_address, display_name, bio, reputation_score, drawdown_bps, status,
  verified, mode, total_return_bps, win_rate_bps, trades_count, followers_count,
  performance_fee_bps, execution_fee_bps
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'DEMO_AETHER_ALPHA', 'Aether Alpha', 'Demo strategy for SHADOW marketplace validation.', 98.5000, 850, 'ACTIVE', true, 'SHADOW', 18400, 7425, 184, 37, 1000, 25),
  ('00000000-0000-0000-0000-000000000002', 'DEMO_AETHER_MOMENTUM', 'Aether Momentum', 'Demo momentum strategy; no live execution.', 94.2500, 1250, 'ACTIVE', true, 'SHADOW', 12600, 6810, 231, 24, 1000, 25),
  ('00000000-0000-0000-0000-000000000003', 'DEMO_AETHER_STABLE', 'Aether Stable', 'Demo lower-volatility strategy for marketplace QA.', 91.7500, 620, 'ACTIVE', true, 'SHADOW', 7900, 7130, 119, 18, 1000, 25)
ON CONFLICT (trader_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  bio=EXCLUDED.bio,
  reputation_score=EXCLUDED.reputation_score,
  drawdown_bps=EXCLUDED.drawdown_bps,
  status=EXCLUDED.status,
  verified=EXCLUDED.verified,
  mode=EXCLUDED.mode,
  total_return_bps=EXCLUDED.total_return_bps,
  win_rate_bps=EXCLUDED.win_rate_bps,
  trades_count=EXCLUDED.trades_count,
  followers_count=EXCLUDED.followers_count,
  performance_fee_bps=EXCLUDED.performance_fee_bps,
  execution_fee_bps=EXCLUDED.execution_fee_bps,
  updated_at=now();

CREATE INDEX IF NOT EXISTS idx_traders_marketplace ON traders(status, verified, reputation_score DESC);
