BEGIN;

CREATE TABLE IF NOT EXISTS execution_engine_rentals (
  rental_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id UUID NOT NULL REFERENCES traders(trader_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAST_DUE','EXPIRED','CANCELLED')),
  monthly_rate_bps INTEGER NOT NULL DEFAULT 300 CHECK (monthly_rate_bps >= 0 AND monthly_rate_bps <= 10000),
  amount_due_usd NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (amount_due_usd >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_engine_rental_active
  ON execution_engine_rentals(trader_id)
  WHERE status='ACTIVE';

CREATE INDEX IF NOT EXISTS idx_execution_engine_rental_status_end
  ON execution_engine_rentals(status, period_end);

CREATE TABLE IF NOT EXISTS billing_ledger (
  ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id UUID REFERENCES traders(trader_id),
  rental_id UUID REFERENCES execution_engine_rentals(rental_id),
  fee_type TEXT NOT NULL CHECK (fee_type IN ('PERFORMANCE_FEE','EXECUTION_FEE','EXECUTION_ENGINE_RENTAL')),
  amount_usd NUMERIC(18,6) NOT NULL CHECK (amount_usd >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('PENDING','POSTED','PAID','VOID')),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_trader_created
  ON billing_ledger(trader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_fee_type
  ON billing_ledger(fee_type, created_at DESC);

ALTER TABLE platform_fee_config
  ADD COLUMN IF NOT EXISTS execution_rental_fee_bps INTEGER NOT NULL DEFAULT 300;

UPDATE platform_fee_config
SET performance_fee_bps = 1500,
    execution_rental_fee_bps = 300,
    updated_at = now()
WHERE config_id = 1;

COMMIT;
