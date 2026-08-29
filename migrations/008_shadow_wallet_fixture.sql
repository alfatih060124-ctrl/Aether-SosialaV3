-- Aether V3 SHADOW-only wallet fixture.
-- Public addresses are identifiers only; no private key or signing material is stored.

CREATE TABLE IF NOT EXISTS shadow_wallet_identities (
  user_id uuid PRIMARY KEY,
  wallet_address text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('TRADER','FOLLOWER')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_wallet_role ON shadow_wallet_identities(role, enabled);

INSERT INTO shadow_wallet_identities (user_id, wallet_address, role)
VALUES
  ('10000000-0000-0000-0000-000000000001', '39Gmtt35gKrhs6erHfNttLhkRAxuT73MgxoTSHYxqb17', 'FOLLOWER')
ON CONFLICT (wallet_address) DO UPDATE SET
  role = EXCLUDED.role,
  enabled = true,
  updated_at = now();

INSERT INTO traders (
  trader_id, wallet_address, display_name, bio, reputation_score, drawdown_bps, status,
  verified, mode, total_return_bps, win_rate_bps, trades_count, followers_count,
  performance_fee_bps, execution_fee_bps
)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  'FWS3E4FXRG1jYn9xJMpxFpJH7T6q5rVy3skDz7nsbAyK',
  'Aether Primary Trader',
  'Aether V3 public SHADOW trader fixture.',
  100.0000, 0, 'ACTIVE', true, 'SHADOW', 0, 0, 0, 1, 1000, 25
)
ON CONFLICT (trader_id) DO UPDATE SET
  wallet_address = EXCLUDED.wallet_address,
  display_name = EXCLUDED.display_name,
  bio = EXCLUDED.bio,
  status = 'ACTIVE',
  verified = true,
  mode = 'SHADOW',
  followers_count = GREATEST(traders.followers_count, 1),
  updated_at = now();

INSERT INTO copy_policies (
  policy_id, follower_user_id, trader_id, enabled,
  max_copy_amount_usd, max_position_amount_usd
)
VALUES (
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  true, 10000, 10000
)
ON CONFLICT (follower_user_id, trader_id) DO UPDATE SET
  enabled = true,
  max_copy_amount_usd = EXCLUDED.max_copy_amount_usd,
  max_position_amount_usd = EXCLUDED.max_position_amount_usd,
  updated_at = now();

INSERT INTO audit_events (event_type, actor, entity_type, entity_id, payload)
SELECT
  'SHADOW_WALLET_FIXTURE_REGISTERED', 'system', 'trader',
  '10000000-0000-0000-0000-000000000002',
  jsonb_build_object(
    'trader_wallet', 'FWS3E4FXRG1jYn9xJMpxFpJH7T6q5rVy3skDz7nsbAyK',
    'follower_wallet', '39Gmtt35gKrhs6erHfNttLhkRAxuT73MgxoTSHYxqb17',
    'mode', 'SHADOW',
    'live_enabled', false
  )
WHERE NOT EXISTS (
  SELECT 1 FROM audit_events
  WHERE event_type='SHADOW_WALLET_FIXTURE_REGISTERED'
    AND entity_id='10000000-0000-0000-0000-000000000002'
);
