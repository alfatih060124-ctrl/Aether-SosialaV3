BEGIN;

CREATE TABLE IF NOT EXISTS member_engine_plans (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_period_days INTEGER NOT NULL DEFAULT 30 CHECK (billing_period_days > 0),
  price_usdc NUMERIC(18,6) NOT NULL CHECK (price_usdc > 0),
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

COMMIT;
