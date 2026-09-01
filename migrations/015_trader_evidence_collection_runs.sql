CREATE TABLE IF NOT EXISTS trader_evidence_collection_runs (
  collection_id uuid PRIMARY KEY,
  trader_id uuid NOT NULL REFERENCES traders(trader_id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_reference text,
  observed_at timestamptz NOT NULL,
  collection_status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_available boolean NOT NULL DEFAULT false,
  verified boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT false,
  live_execution_authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trader_evidence_collection_source_chk
    CHECK (source_type IN ('SOLANA_RPC','SOLSCAN','INDEXER','INTERNAL_RECONCILIATION')),
  CONSTRAINT trader_evidence_collection_status_chk
    CHECK (collection_status IN ('PENDING_DATA','PENDING_REVIEW','RECORDED','FAILED')),
  CONSTRAINT trader_evidence_collection_fail_closed_chk
    CHECK (verified=false AND published=false AND live_execution_authorized=false)
);

CREATE INDEX IF NOT EXISTS idx_trader_evidence_collection_runs_trader
  ON trader_evidence_collection_runs(trader_id, created_at DESC);

-- This staging table records source provenance even when performance metrics are not yet
-- derivable. It must never verify/publish a trader or authorize LIVE execution.
