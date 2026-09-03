-- Backend/Product fee-control approval ledger.
-- Additive and fail-closed: no LIVE capability, signer material, network submission, or destructive rewrite.

CREATE TABLE IF NOT EXISTS fee_control_changes (
  change_id uuid PRIMARY KEY,
  config_id integer NOT NULL REFERENCES platform_fee_config(config_id),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','APPLIED')),
  requested_by text NOT NULL CHECK (length(btrim(requested_by)) BETWEEN 1 AND 128),
  approved_by text,
  applied_by text,
  requested_role text NOT NULL DEFAULT 'FEE_CONFIG_OPERATOR' CHECK (requested_role = 'FEE_CONFIG_OPERATOR'),
  approved_role text CHECK (approved_role IS NULL OR approved_role = 'FEE_CONFIG_APPROVER'),
  applied_role text CHECK (applied_role IS NULL OR applied_role = 'FEE_CONFIG_APPLIER'),
  current_performance_fee_bps integer NOT NULL CHECK (current_performance_fee_bps BETWEEN 0 AND 10000),
  current_execution_fee_bps integer NOT NULL CHECK (current_execution_fee_bps BETWEEN 0 AND 10000),
  proposed_performance_fee_bps integer NOT NULL CHECK (proposed_performance_fee_bps BETWEEN 0 AND 10000),
  proposed_execution_fee_bps integer NOT NULL CHECK (proposed_execution_fee_bps BETWEEN 0 AND 10000),
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  live_execution_authorized boolean NOT NULL DEFAULT false CHECK (live_execution_authorized = false),
  network_submission_authorized boolean NOT NULL DEFAULT false CHECK (network_submission_authorized = false),
  signer_required boolean NOT NULL DEFAULT false CHECK (signer_required = false),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  applied_at timestamptz,
  CHECK (current_performance_fee_bps + current_execution_fee_bps <= 10000),
  CHECK (proposed_performance_fee_bps + proposed_execution_fee_bps <= 10000),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (applied_by IS NULL OR (applied_by <> requested_by AND applied_by IS DISTINCT FROM approved_by)),
  CHECK (
    (status = 'PENDING_APPROVAL' AND approved_by IS NULL AND applied_by IS NULL AND approved_at IS NULL AND applied_at IS NULL)
    OR (status = 'APPROVED' AND approved_by IS NOT NULL AND applied_by IS NULL AND approved_at IS NOT NULL AND applied_at IS NULL)
    OR (status = 'APPLIED' AND approved_by IS NOT NULL AND applied_by IS NOT NULL AND approved_at IS NOT NULL AND applied_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fee_control_changes_status_requested_at
  ON fee_control_changes(status, requested_at DESC);

CREATE OR REPLACE FUNCTION aether_guard_fee_control_change_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'fee_change_must_start_pending';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.change_id IS DISTINCT FROM OLD.change_id
     OR NEW.config_id IS DISTINCT FROM OLD.config_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_role IS DISTINCT FROM OLD.requested_role
     OR NEW.current_performance_fee_bps IS DISTINCT FROM OLD.current_performance_fee_bps
     OR NEW.current_execution_fee_bps IS DISTINCT FROM OLD.current_execution_fee_bps
     OR NEW.proposed_performance_fee_bps IS DISTINCT FROM OLD.proposed_performance_fee_bps
     OR NEW.proposed_execution_fee_bps IS DISTINCT FROM OLD.proposed_execution_fee_bps
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.live_execution_authorized IS DISTINCT FROM OLD.live_execution_authorized
     OR NEW.network_submission_authorized IS DISTINCT FROM OLD.network_submission_authorized
     OR NEW.signer_required IS DISTINCT FROM OLD.signer_required
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'fee_change_immutable_fields_modified';
  END IF;

  IF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'APPROVED' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.requested_by
       OR NEW.approved_role IS DISTINCT FROM 'FEE_CONFIG_APPROVER'
       OR NEW.applied_by IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'fee_change_approval_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status = 'APPLIED' THEN
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_role IS DISTINCT FROM OLD.approved_role
       OR NEW.applied_by IS NULL
       OR NEW.applied_by = NEW.requested_by
       OR NEW.applied_by = NEW.approved_by
       OR NEW.applied_role IS DISTINCT FROM 'FEE_CONFIG_APPLIER' THEN
      RAISE EXCEPTION 'fee_change_application_invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid_fee_change_transition';
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_guard_fee_control_change_transition ON fee_control_changes;
CREATE TRIGGER trg_aether_guard_fee_control_change_transition
BEFORE INSERT OR UPDATE ON fee_control_changes
FOR EACH ROW EXECUTE FUNCTION aether_guard_fee_control_change_transition();

-- Strengthen the existing platform fee guard: changing performance/execution fees now
-- requires a matching APPROVED ledger entry and a distinct applier identity supplied in
-- transaction-local backend context. Existing inserts remain unaffected.
CREATE OR REPLACE FUNCTION aether_guard_fee_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  change_id_text text;
  actor_id text;
  approved_change fee_control_changes%ROWTYPE;
BEGIN
  IF NEW.performance_fee_bps < 0 OR NEW.performance_fee_bps > 10000 THEN RAISE EXCEPTION 'invalid_performance_fee_bps'; END IF;
  IF NEW.execution_fee_bps < 0 OR NEW.execution_fee_bps > 10000 THEN RAISE EXCEPTION 'invalid_execution_fee_bps'; END IF;
  IF NEW.execution_rental_fee_bps < 0 OR NEW.execution_rental_fee_bps > 10000 THEN RAISE EXCEPTION 'invalid_execution_rental_fee_bps'; END IF;
  IF NEW.performance_fee_bps + NEW.execution_fee_bps > 10000 THEN RAISE EXCEPTION 'combined_fee_exceeds_100_percent'; END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.performance_fee_bps IS DISTINCT FROM OLD.performance_fee_bps
    OR NEW.execution_fee_bps IS DISTINCT FROM OLD.execution_fee_bps
  ) THEN
    change_id_text := NULLIF(current_setting('aether.fee_change_id', true), '');
    actor_id := NULLIF(current_setting('aether.actor', true), '');
    IF change_id_text IS NULL OR actor_id IS NULL THEN
      RAISE EXCEPTION 'fee_change_context_required';
    END IF;

    BEGIN
      SELECT * INTO STRICT approved_change
      FROM fee_control_changes
      WHERE change_id = change_id_text::uuid
        AND config_id = NEW.config_id
        AND status = 'APPROVED'
      FOR UPDATE;
    EXCEPTION
      WHEN invalid_text_representation OR no_data_found THEN
        RAISE EXCEPTION 'approved_fee_change_required';
    END;

    IF approved_change.proposed_performance_fee_bps IS DISTINCT FROM NEW.performance_fee_bps
       OR approved_change.proposed_execution_fee_bps IS DISTINCT FROM NEW.execution_fee_bps THEN
      RAISE EXCEPTION 'fee_change_payload_mismatch';
    END IF;
    IF actor_id = approved_change.requested_by OR actor_id = approved_change.approved_by THEN
      RAISE EXCEPTION 'separation_of_duties_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION aether_audit_fee_control_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'PLATFORM_FEE_CHANGE_REQUESTED';
  ELSIF NEW.status = 'APPROVED' AND OLD.status = 'PENDING_APPROVAL' THEN
    kind := 'PLATFORM_FEE_CHANGE_APPROVED';
  ELSIF NEW.status = 'APPLIED' AND OLD.status = 'APPROVED' THEN
    kind := 'PLATFORM_FEE_CHANGE_APPLIED';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO audit_events(event_type, actor, entity_type, entity_id, payload)
  VALUES(
    kind,
    aether_audit_actor(),
    'FEE_CONTROL_CHANGE',
    NEW.change_id::text,
    jsonb_build_object(
      'status', NEW.status,
      'config_id', NEW.config_id,
      'requested_by', NEW.requested_by,
      'approved_by', NEW.approved_by,
      'applied_by', NEW.applied_by,
      'current', jsonb_build_object('performance_fee_bps', NEW.current_performance_fee_bps, 'execution_fee_bps', NEW.current_execution_fee_bps),
      'proposed', jsonb_build_object('performance_fee_bps', NEW.proposed_performance_fee_bps, 'execution_fee_bps', NEW.proposed_execution_fee_bps),
      'mode', 'SHADOW',
      'live_execution_authorized', false,
      'network_submission_authorized', false,
      'signer_required', false
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_audit_fee_control_change ON fee_control_changes;
CREATE TRIGGER trg_aether_audit_fee_control_change
AFTER INSERT OR UPDATE ON fee_control_changes
FOR EACH ROW EXECUTE FUNCTION aether_audit_fee_control_change();
