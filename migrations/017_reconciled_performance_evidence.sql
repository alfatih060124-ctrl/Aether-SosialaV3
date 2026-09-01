-- Real reconciled-trade ledger for deterministic trader performance evidence.
-- This schema does not verify/publish traders and does not authorize LIVE execution.

CREATE TABLE IF NOT EXISTS trader_reconciled_trades (
  reconciliation_trade_id uuid PRIMARY KEY,
  trader_id uuid NOT NULL REFERENCES traders(trader_id) ON DELETE CASCADE,
  trade_event_id text NOT NULL REFERENCES trade_events(event_id) ON DELETE RESTRICT,
  source_signature text NOT NULL,
  source_slot bigint NOT NULL CHECK (source_slot >= 0),
  executed_at timestamptz NOT NULL,
  realized_pnl_minor bigint NOT NULL,
  capital_minor bigint NOT NULL CHECK (capital_minor > 0),
  equity_after_minor bigint NOT NULL CHECK (equity_after_minor > 0),
  accounting_method text NOT NULL,
  valuation_reference text NOT NULL,
  source_hash text NOT NULL,
  reconciliation_status text NOT NULL DEFAULT 'RECONCILED',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trader_reconciled_trade_status_chk
    CHECK (reconciliation_status = 'RECONCILED'),
  CONSTRAINT trader_reconciled_trade_source_hash_chk
    CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT trader_reconciled_trade_accounting_chk
    CHECK (accounting_method IN ('FIFO_COST_BASIS_V1','WEIGHTED_AVERAGE_COST_BASIS_V1')),
  UNIQUE (trader_id, trade_event_id),
  UNIQUE (trader_id, source_signature)
);

CREATE INDEX IF NOT EXISTS idx_trader_reconciled_trades_trader
  ON trader_reconciled_trades(trader_id, executed_at, trade_event_id);

-- Evidence V1 intentionally has a bounded per-trader ledger. This prevents a caller from
-- silently calculating only the first 5,000 rows. An explicit batching/epoch scheme must
-- replace this guard before a trader can exceed this bound. Advisory locking makes the cap
-- deterministic even if multiple reconciliation requests arrive concurrently.
CREATE OR REPLACE FUNCTION aether_guard_reconciled_trade_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.trader_id::text, 0));
  SELECT count(*) INTO existing_count
  FROM trader_reconciled_trades
  WHERE trader_id = NEW.trader_id;
  IF existing_count >= 5000 THEN
    RAISE EXCEPTION 'reconciliation_evidence_row_limit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_reconciled_trade_limit ON trader_reconciled_trades;
CREATE TRIGGER trg_aether_reconciled_trade_limit
BEFORE INSERT ON trader_reconciled_trades
FOR EACH ROW EXECUTE FUNCTION aether_guard_reconciled_trade_limit();

ALTER TABLE trader_evidence_collection_runs
  ADD COLUMN IF NOT EXISTS trades_count integer,
  ADD COLUMN IF NOT EXISTS total_return_bps integer,
  ADD COLUMN IF NOT EXISTS win_rate_bps integer,
  ADD COLUMN IF NOT EXISTS drawdown_bps integer,
  ADD COLUMN IF NOT EXISTS reputation_score numeric(8,4),
  ADD COLUMN IF NOT EXISTS calculation_hash text;

ALTER TABLE trader_verification_evidence
  ADD COLUMN IF NOT EXISTS evidence_origin text NOT NULL DEFAULT 'MANUAL_ADMIN',
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES trader_evidence_collection_runs(collection_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_verification_evidence_collection
  ON trader_verification_evidence(collection_id)
  WHERE collection_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trader_verification_evidence_origin_chk'
  ) THEN
    ALTER TABLE trader_verification_evidence
      ADD CONSTRAINT trader_verification_evidence_origin_chk
      CHECK (evidence_origin IN ('MANUAL_ADMIN','AUTOMATIC_RECONCILIATION'));
  END IF;
END $$;

-- Only verified human/admin review may later change evidence_status to VERIFIED.
-- The reconciled ledger and automatic evidence pipeline remain evidence-generation only.
