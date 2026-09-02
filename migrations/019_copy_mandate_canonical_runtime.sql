-- Canonical Copy Mandate persistence bridge.
-- Existing mandates are intentionally not backfilled: missing consent/policy evidence must fail closed.
-- No LIVE capability, signer material, network submission, or destructive rewrite is introduced.

ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS policy_type text;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS policy_value numeric(30,10);
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS consent_version text;
ALTER TABLE copy_policies ADD COLUMN IF NOT EXISTS consented_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'copy_policies_policy_type_canonical'
  ) THEN
    ALTER TABLE copy_policies
      ADD CONSTRAINT copy_policies_policy_type_canonical
      CHECK (policy_type IS NULL OR policy_type IN ('FIXED_USD','PERCENT_EQUITY','CAPPED_PROPORTIONAL'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'copy_policies_policy_value_positive'
  ) THEN
    ALTER TABLE copy_policies
      ADD CONSTRAINT copy_policies_policy_value_positive
      CHECK (policy_value IS NULL OR policy_value > 0)
      NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN copy_policies.policy_type IS 'Canonical aether.copy_mandate.v1 policy type; NULL means runtime authorization must fail closed.';
COMMENT ON COLUMN copy_policies.policy_value IS 'Canonical aether.copy_mandate.v1 policy value; NULL means runtime authorization must fail closed.';
COMMENT ON COLUMN copy_policies.consent_version IS 'Follower consent document/version; never synthesized for legacy rows.';
COMMENT ON COLUMN copy_policies.consented_at IS 'Follower consent timestamp; never synthesized for legacy rows.';
