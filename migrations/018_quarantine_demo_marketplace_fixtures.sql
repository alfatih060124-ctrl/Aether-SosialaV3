-- Legacy marketplace demo rows were intentionally public in early SHADOW demos.
-- They must never be eligible for the verified marketplace once evidence-backed
-- verification/publication gates are active.
-- This migration is non-destructive: it only quarantines the three known fixture rows.

UPDATE traders
SET verified = false,
    published = false,
    verification_status = 'PENDING_DATA',
    status = 'PENDING_VERIFICATION',
    verification_source = '',
    verification_reference = '',
    verification_observed_at = NULL,
    verification_note = 'Legacy illustrative marketplace fixture quarantined; real verification evidence required.',
    verified_at = NULL,
    updated_at = now()
WHERE owner_user_id IS NULL
  AND trader_id IN (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003'
  )
  AND wallet_address IN (
    'DEMO_AETHER_ALPHA',
    'DEMO_AETHER_MOMENTUM',
    'DEMO_AETHER_STABLE'
  );

-- Future marketplace queries remain fail-closed: only separately verified and
-- explicitly published traders can become publicly discoverable.
