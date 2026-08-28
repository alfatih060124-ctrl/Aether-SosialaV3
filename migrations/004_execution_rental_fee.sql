ALTER TABLE platform_fee_config ADD COLUMN IF NOT EXISTS execution_rental_fee_bps integer NOT NULL DEFAULT 300;
UPDATE platform_fee_config SET execution_rental_fee_bps=300 WHERE config_id=1;
