-- Aether V3 SHADOW-only reconciliation.
-- Idempotently guarantees the configured public Trader/Follower fixture exists.
-- No private key, seed phrase, signer, or live-execution capability is introduced.

INSERT INTO shadow_wallet_identities (user_id, wallet_address, role, enabled)
VALUES
  ('10000000-0000-0000-0000-000000000001', '39Gmtt35gKrhs6erHfNttLhkRAxuT73MgxoTSHYxqb17', 'FOLLOWER', true)
ON CONFLICT (wallet_address) DO UPDATE SET
  role = EXCLUDED.role,
  enabled = true,
  updated_at = now();

WITH trader_upsert AS (
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
  ON CONFLICT (wallet_address) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    bio = EXCLUDED.bio,
    reputation_score = EXCLUDED.reputation_score,
    drawdown_bps = EXCLUDED.drawdown_bps,
    status = 'ACTIVE',
    verified = true,
    mode = 'SHADOW',
    followers_count = GREATEST(traders.followers_count, 1),
    performance_fee_bps = EXCLUDED.performance_fee_bps,
    execution_fee_bps = EXCLUDED.execution_fee_bps,
    updated_at = now()
  RETURNING trader_id
)
INSERT INTO copy_policies (
  policy_id, follower_user_id, trader_id, enabled,
  max_copy_amount_usd, max_position_amount_usd
)
SELECT
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  trader_id,
  true, 10000, 10000
FROM trader_upsert
ON CONFLICT (follower_user_id, trader_id) DO UPDATE SET
  enabled = true,
  max_copy_amount_usd = EXCLUDED.max_copy_amount_usd,
  max_position_amount_usd = EXCLUDED.max_position_amount_usd,
  updated_at = now();

INSERT INTO audit_events (event_type, actor, entity_type, entity_id, payload)
SELECT
  'SHADOW_WALLET_FIXTURE_RECONCILED', 'system', 'trader', t.trader_id::text,
  jsonb_build_object(
    'trader_wallet', t.wallet_address,
    'follower_wallet', '39Gmtt35gKrhs6erHfNttLhkRAxuT73MgxoTSHYxqb17',
    'mode', 'SHADOW',
    'live_enabled', false
  )
FROM traders t
WHERE t.wallet_address = 'FWS3E4FXRG1jYn9xJMpxFpJH7T6q5rVy3skDz7nsbAyK'
  AND NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.event_type = 'SHADOW_WALLET_FIXTURE_RECONCILED'
      AND a.entity_id = t.trader_id::text
  );
