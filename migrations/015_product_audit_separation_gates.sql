-- Product-level fail-closed guards and immutable audit evidence for sensitive control-plane changes.
-- No LIVE capability is introduced. Existing rows are not rewritten.

CREATE OR REPLACE FUNCTION aether_audit_actor()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('aether.actor', true), ''), 'db:automatic');
$$;

CREATE OR REPLACE FUNCTION aether_guard_trader_control_plane()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM 'SHADOW' THEN
    RAISE EXCEPTION 'trader_mode_must_remain_shadow';
  END IF;

  -- New trader rows must never inherit legacy VERIFIED/published defaults.
  -- Creation is always fail-closed; verification and publication require later,
  -- explicit and separately audited control-plane transitions.
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status IS DISTINCT FROM 'PENDING_DATA'
       OR NEW.verified IS DISTINCT FROM false
       OR NEW.published IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'trader_insert_must_start_unverified_unpublished';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.published IS TRUE THEN
    IF OLD.verification_status IS DISTINCT FROM 'VERIFIED' THEN
      RAISE EXCEPTION 'trader_publication_requires_prior_verification';
    END IF;
    IF NOT (
      NEW.onboarding_status = 'APPROVED'
      AND NEW.verification_status = 'VERIFIED'
      AND NEW.verified IS TRUE
      AND NEW.status = 'ACTIVE'
      AND NEW.mode = 'SHADOW'
      AND COALESCE(NEW.verification_reference, '') <> ''
    ) THEN
      RAISE EXCEPTION 'trader_publication_gate_failed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_guard_trader_control_plane ON traders;
CREATE TRIGGER trg_aether_guard_trader_control_plane
BEFORE INSERT OR UPDATE ON traders
FOR EACH ROW
EXECUTE FUNCTION aether_guard_trader_control_plane();

CREATE OR REPLACE FUNCTION aether_audit_trader_control_plane()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  kind text;
BEGIN
  IF OLD.verification_status IS DISTINCT FROM NEW.verification_status OR OLD.verified IS DISTINCT FROM NEW.verified THEN
    kind := 'TRADER_VERIFICATION_CHANGED';
  ELSIF OLD.published IS DISTINCT FROM NEW.published THEN
    kind := 'TRADER_PUBLICATION_CHANGED';
  ELSIF OLD.onboarding_status IS DISTINCT FROM NEW.onboarding_status OR OLD.status IS DISTINCT FROM NEW.status THEN
    kind := 'TRADER_CONTROL_STATE_CHANGED';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO audit_events(event_type, actor, entity_type, entity_id, payload)
  VALUES(
    kind,
    aether_audit_actor(),
    'TRADER',
    NEW.trader_id::text,
    jsonb_build_object(
      'before', jsonb_build_object(
        'onboarding_status', OLD.onboarding_status,
        'verification_status', OLD.verification_status,
        'verified', OLD.verified,
        'published', OLD.published,
        'status', OLD.status,
        'mode', OLD.mode
      ),
      'after', jsonb_build_object(
        'onboarding_status', NEW.onboarding_status,
        'verification_status', NEW.verification_status,
        'verified', NEW.verified,
        'published', NEW.published,
        'status', NEW.status,
        'mode', NEW.mode
      ),
      'live_execution_authorized', false
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_audit_trader_control_plane ON traders;
CREATE TRIGGER trg_aether_audit_trader_control_plane
AFTER UPDATE ON traders
FOR EACH ROW
EXECUTE FUNCTION aether_audit_trader_control_plane();

CREATE OR REPLACE FUNCTION aether_guard_copy_mandate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM 'SHADOW' THEN
    RAISE EXCEPTION 'copy_mandate_mode_must_remain_shadow';
  END IF;
  IF NEW.live_execution_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'copy_mandate_live_execution_forbidden';
  END IF;
  IF NEW.allocation_bps < 0 OR NEW.allocation_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_allocation_bps';
  END IF;
  IF NEW.max_slippage_bps < 0 OR NEW.max_slippage_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_max_slippage_bps';
  END IF;
  IF NEW.max_daily_loss_bps < 0 OR NEW.max_daily_loss_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_max_daily_loss_bps';
  END IF;
  IF NEW.stop_drawdown_bps < 0 OR NEW.stop_drawdown_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_stop_drawdown_bps';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_guard_copy_mandate ON copy_policies;
CREATE TRIGGER trg_aether_guard_copy_mandate
BEFORE INSERT OR UPDATE ON copy_policies
FOR EACH ROW
EXECUTE FUNCTION aether_guard_copy_mandate();

CREATE OR REPLACE FUNCTION aether_audit_copy_mandate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_events(event_type, actor, entity_type, entity_id, payload)
  VALUES(
    CASE WHEN TG_OP = 'INSERT' THEN 'COPY_MANDATE_CREATED' ELSE 'COPY_MANDATE_CHANGED' END,
    aether_audit_actor(),
    'COPY_MANDATE',
    NEW.policy_id::text,
    jsonb_build_object(
      'follower_user_id', NEW.follower_user_id,
      'trader_id', NEW.trader_id,
      'enabled', NEW.enabled,
      'status', NEW.status,
      'mode', NEW.mode,
      'allocation_bps', NEW.allocation_bps,
      'max_slippage_bps', NEW.max_slippage_bps,
      'max_daily_loss_bps', NEW.max_daily_loss_bps,
      'stop_drawdown_bps', NEW.stop_drawdown_bps,
      'live_execution_authorized', NEW.live_execution_authorized
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_audit_copy_mandate ON copy_policies;
CREATE TRIGGER trg_aether_audit_copy_mandate
AFTER INSERT OR UPDATE ON copy_policies
FOR EACH ROW
EXECUTE FUNCTION aether_audit_copy_mandate();

CREATE OR REPLACE FUNCTION aether_guard_fee_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.performance_fee_bps < 0 OR NEW.performance_fee_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_performance_fee_bps';
  END IF;
  IF NEW.execution_fee_bps < 0 OR NEW.execution_fee_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_execution_fee_bps';
  END IF;
  IF NEW.execution_rental_fee_bps < 0 OR NEW.execution_rental_fee_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_execution_rental_fee_bps';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_guard_fee_config ON platform_fee_config;
CREATE TRIGGER trg_aether_guard_fee_config
BEFORE UPDATE ON platform_fee_config
FOR EACH ROW
EXECUTE FUNCTION aether_guard_fee_config();

CREATE OR REPLACE FUNCTION aether_audit_fee_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_events(event_type, actor, entity_type, entity_id, payload)
  VALUES(
    'PLATFORM_FEE_CONFIG_CHANGED',
    aether_audit_actor(),
    'PLATFORM_FEE_CONFIG',
    NEW.config_id::text,
    jsonb_build_object(
      'before', jsonb_build_object(
        'performance_fee_bps', OLD.performance_fee_bps,
        'execution_fee_bps', OLD.execution_fee_bps,
        'execution_rental_fee_bps', OLD.execution_rental_fee_bps,
        'enabled', OLD.enabled
      ),
      'after', jsonb_build_object(
        'performance_fee_bps', NEW.performance_fee_bps,
        'execution_fee_bps', NEW.execution_fee_bps,
        'execution_rental_fee_bps', NEW.execution_rental_fee_bps,
        'enabled', NEW.enabled
      )
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aether_audit_fee_config ON platform_fee_config;
CREATE TRIGGER trg_aether_audit_fee_config
AFTER UPDATE ON platform_fee_config
FOR EACH ROW
EXECUTE FUNCTION aether_audit_fee_config();
