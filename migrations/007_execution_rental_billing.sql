BEGIN;

ALTER TABLE execution_engine_rentals
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED','VOID')),
  ADD COLUMN IF NOT EXISTS payment_reference TEXT;

UPDATE execution_engine_rentals
SET payment_status = CASE WHEN paid_at IS NOT NULL THEN 'PAID' ELSE 'PENDING' END
WHERE payment_status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_execution_engine_rentals_payment_status
  ON execution_engine_rentals(payment_status, period_end);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_ledger_rental_reference
  ON billing_ledger(rental_id, reference_id)
  WHERE rental_id IS NOT NULL AND reference_id IS NOT NULL;

COMMIT;
