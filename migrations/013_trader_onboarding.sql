ALTER TABLE traders ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'APPROVED';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'VERIFIED';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT true;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS strategy_summary text NOT NULL DEFAULT '';
ALTER TABLE traders ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE traders ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';

UPDATE traders
SET applied_at = COALESCE(applied_at, created_at),
    reviewed_at = CASE WHEN onboarding_status='APPROVED' THEN COALESCE(reviewed_at, created_at) ELSE reviewed_at END
WHERE applied_at IS NULL OR (onboarding_status='APPROVED' AND reviewed_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_traders_onboarding_queue
  ON traders(onboarding_status, verification_status, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_traders_public_marketplace
  ON traders(status, onboarding_status, verification_status, published, verified, reputation_score DESC);

-- New wallet-owned trader applications are PENDING, PENDING_DATA, unpublished and SHADOW-only.
-- Existing approved marketplace fixtures retain VERIFIED/public behavior through defaults.
-- Publication of new traders is intentionally fenced until verifiable history/performance/risk checks exist.
