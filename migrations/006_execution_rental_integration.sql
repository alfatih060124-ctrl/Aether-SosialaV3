BEGIN;

-- Align the runtime schema with the execution event payloads and make
-- Execution Engine rental ownership explicit for new execution requests.
ALTER TABLE trade_events
  ADD COLUMN IF NOT EXISTS slippage_bps integer;

ALTER TABLE execution_requests
  ADD COLUMN IF NOT EXISTS trader_id uuid REFERENCES traders(trader_id);

-- Older builds used SIMULATION while the V3 runtime uses SHADOW/PAPER/LIVE.
UPDATE execution_requests
SET mode = 'SHADOW', updated_at = now()
WHERE mode = 'SIMULATION';

CREATE INDEX IF NOT EXISTS idx_execution_requests_trader_created
  ON execution_requests(trader_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_engine_rentals_trader_end
  ON execution_engine_rentals(trader_id, period_end DESC);

-- Keep the platform defaults in the database as the source of truth.
UPDATE platform_fee_config
SET performance_fee_bps = 1500,
    execution_fee_bps = COALESCE(execution_fee_bps, 25),
    execution_rental_fee_bps = 300,
    updated_at = now()
WHERE config_id = 1;

COMMIT;
