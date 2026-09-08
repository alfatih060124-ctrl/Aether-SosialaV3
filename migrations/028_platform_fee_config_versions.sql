BEGIN;

CREATE TABLE IF NOT EXISTS platform_fee_config_versions (
  version_number bigserial PRIMARY KEY,
  performance_fee_bps integer NOT NULL CHECK (performance_fee_bps BETWEEN 0 AND 10000),
  execution_fee_bps integer NOT NULL CHECK (execution_fee_bps BETWEEN 0 AND 10000),
  execution_rental_fee_bps integer NOT NULL CHECK (execution_rental_fee_bps BETWEEN 0 AND 10000),
  enabled boolean NOT NULL,
  created_by text NOT NULL,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (performance_fee_bps + execution_fee_bps <= 10000)
);

CREATE INDEX IF NOT EXISTS platform_fee_config_versions_created_idx
  ON platform_fee_config_versions(created_at DESC);

INSERT INTO platform_fee_config_versions(
  performance_fee_bps,execution_fee_bps,execution_rental_fee_bps,enabled,created_by
)
SELECT performance_fee_bps,execution_fee_bps,execution_rental_fee_bps,enabled,'migration-baseline'
FROM platform_fee_config
WHERE config_id=1
  AND NOT EXISTS (SELECT 1 FROM platform_fee_config_versions);

COMMIT;
