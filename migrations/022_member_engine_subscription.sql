BEGIN;

CREATE TABLE IF NOT EXISTS member_engine_plans (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_period_days INTEGER NOT NULL DEFAULT 30 CHECK (billing_period_days > 0),
  price_usdc NUMERIC(18,6) NOT NULL CHECK (price_usdc > 0),
  base_price_usdc NUMERIC(18,6) NOT NULL CHECK (base_price_usdc > 0),
  discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (discount_bps >= 0 AND discount_bps <= 10000),
  currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  payment_network TEXT NOT NULL DEFAULT 'SOLANA' CHECK (payment_network = 'SOLANA'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_engine_subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES member_engine_plans(plan_id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','PAST_DUE','EXPIRED','CANCELLED')),
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED','VOID')),
  amount_usdc NUMERIC(18,6) NOT NULL CHECK (amount_usdc > 0),
  payment_provider TEXT,
  payment_reference TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_start IS NOT NULL),
  CHECK (period_end IS NULL OR period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_engine_subscription_active
  ON member_engine_subscriptions(user_id)
  WHERE status='ACTIVE';

CREATE INDEX IF NOT EXISTS idx_member_engine_subscription_user_created
  ON member_engine_subscriptions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_member_engine_subscription_status_end
  ON member_engine_subscriptions(status, payment_status, period_end);

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_engine_subscription_payment_reference
  ON member_engine_subscriptions(payment_provider, payment_reference)
  WHERE payment_provider IS NOT NULL AND payment_reference IS NOT NULL;

INSERT INTO member_engine_plans(code,name,billing_period_days,price_usdc,base_price_usdc,discount_bps,currency,payment_network,active)
VALUES
  ('AETHER_30D','AETHER Auto Trade · 30 Days',30,35.000000,35.000000,0,'USDC','SOLANA',true),
  ('AETHER_90D','AETHER Auto Trade · 3 Months',90,89.250000,105.000000,1500,'USDC','SOLANA',true),
  ('AETHER_180D','AETHER Auto Trade · 6 Months',180,157.500000,210.000000,2500,'USDC','SOLANA',true),
  ('AETHER_360D','AETHER Auto Trade · 12 Months',360,273.000000,420.000000,3500,'USDC','SOLANA',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  billing_period_days=EXCLUDED.billing_period_days,
  price_usdc=EXCLUDED.price_usdc,
  base_price_usdc=EXCLUDED.base_price_usdc,
  discount_bps=EXCLUDED.discount_bps,
  currency='USDC',
  payment_network='SOLANA',
  active=true,
  updated_at=now();

COMMIT;
