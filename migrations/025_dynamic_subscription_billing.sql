BEGIN;

CREATE TABLE IF NOT EXISTS subscription_price_versions (
  price_id text PRIMARY KEY,
  duration_days integer NOT NULL CHECK (duration_days IN (30,90,180,360)),
  base_price_usdc_atomic bigint NOT NULL CHECK (base_price_usdc_atomic > 0),
  discount_bps integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
  final_price_usdc_atomic bigint NOT NULL CHECK (final_price_usdc_atomic > 0),
  promo_enabled boolean NOT NULL DEFAULT false,
  promo_start timestamptz,
  promo_end timestamptz,
  active boolean NOT NULL DEFAULT false,
  price_version integer NOT NULL CHECK (price_version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (final_price_usdc_atomic = (base_price_usdc_atomic * (10000 - discount_bps)) / 10000),
  CHECK (
    promo_enabled = false OR
    (promo_start IS NOT NULL AND promo_end IS NOT NULL AND promo_start < promo_end)
  ),
  UNIQUE(duration_days, price_version)
);

CREATE INDEX IF NOT EXISTS subscription_price_versions_active_idx
  ON subscription_price_versions(duration_days, active, price_version DESC);

CREATE TABLE IF NOT EXISTS subscription_orders (
  order_id text PRIMARY KEY,
  quote_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  member_wallet text NOT NULL,
  price_id text NOT NULL REFERENCES subscription_price_versions(price_id),
  price_version integer NOT NULL,
  duration_days integer NOT NULL CHECK (duration_days IN (30,90,180,360)),
  base_price_usdc_atomic bigint NOT NULL CHECK (base_price_usdc_atomic > 0),
  discount_bps integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  final_price_usdc_atomic bigint NOT NULL CHECK (final_price_usdc_atomic > 0),
  payment_network text NOT NULL DEFAULT 'SOLANA' CHECK (payment_network = 'SOLANA'),
  payment_asset text NOT NULL DEFAULT 'USDC' CHECK (payment_asset = 'USDC'),
  payment_recipient_wallet text NOT NULL,
  payment_mint text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT','PAYMENT_VERIFIED','EXPIRED','CANCELLED')),
  quoted_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quote_expires_at > quoted_at),
  CHECK (final_price_usdc_atomic = (base_price_usdc_atomic * (10000 - discount_bps)) / 10000)
);

CREATE INDEX IF NOT EXISTS subscription_orders_user_idx
  ON subscription_orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_payments (
  payment_id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
  signature text NOT NULL UNIQUE,
  sender_wallet text NOT NULL,
  recipient_wallet text NOT NULL,
  mint text NOT NULL,
  amount_usdc_atomic bigint NOT NULL CHECK (amount_usdc_atomic > 0),
  slot bigint NOT NULL CHECK (slot > 0),
  block_time bigint NOT NULL CHECK (block_time > 0),
  verification_source text NOT NULL CHECK (verification_source = 'SOLANA_FINALIZED_RPC'),
  source_reference text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_subscriptions (
  subscription_id text PRIMARY KEY,
  user_id text NOT NULL,
  order_id text NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
  payment_id text NOT NULL UNIQUE REFERENCES subscription_payments(payment_id),
  service_started_at timestamptz NOT NULL,
  service_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_expires_at > service_started_at)
);

CREATE INDEX IF NOT EXISTS member_subscriptions_user_idx
  ON member_subscriptions(user_id, service_expires_at DESC);

COMMIT;
