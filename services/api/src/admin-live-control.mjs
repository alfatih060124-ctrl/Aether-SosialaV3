import { getLiveExecutionGateState } from './live-execution-gate.mjs';

const ACTIONS = new Set(['STATUS','REQUEST_LIVE','ACTIVATE_LIVE','KILL_LIVE','RETURN_SHADOW']);

export function evaluateAdminLiveControl({ action='STATUS', adminAuthenticated=false, readiness={}, env=process.env }={}) {
  const requested = String(action || 'STATUS').toUpperCase();
  if (!ACTIONS.has(requested)) throw new Error('invalid_live_control_action');
  if (!adminAuthenticated && requested !== 'STATUS') throw new Error('admin_auth_required');

  const base = {
    execution_mode: readiness.execution_mode ?? env.EXECUTION_MODE ?? 'SHADOW',
    live_enabled: readiness.live_enabled ?? env.LIVE_ENABLED ?? false,
    readiness_passed: readiness.readiness_passed ?? env.LIVE_READINESS_PASSED ?? false,
    signer_unlocked: readiness.signer_unlocked ?? env.LIVE_SIGNER_UNLOCKED ?? false,
    network_submission_enabled: readiness.network_submission_enabled ?? env.LIVE_NETWORK_SUBMISSION_ENABLED ?? false,
    fund_movement_enabled: readiness.fund_movement_enabled ?? env.LIVE_FUND_MOVEMENT_ENABLED ?? false,
    admin_live_approved: readiness.admin_live_approved ?? env.ADMIN_LIVE_APPROVED ?? false,
    emergency_kill_switch: readiness.emergency_kill_switch ?? env.LIVE_EMERGENCY_KILL_SWITCH ?? true
  };

  if (requested === 'REQUEST_LIVE') base.admin_live_approved = true;
  if (requested === 'KILL_LIVE' || requested === 'RETURN_SHADOW') {
    base.admin_live_approved = false;
    base.emergency_kill_switch = true;
    base.live_enabled = false;
    base.execution_mode = 'SHADOW';
  }
  if (requested === 'ACTIVATE_LIVE') {
    base.admin_live_approved = true;
    base.execution_mode = 'LIVE';
    base.live_enabled = true;
    base.emergency_kill_switch = false;
  }

  const gate = getLiveExecutionGateState(base, {});
  const activationRequested = requested === 'REQUEST_LIVE' || requested === 'ACTIVATE_LIVE';
  const accepted = requested === 'STATUS' || requested === 'KILL_LIVE' || requested === 'RETURN_SHADOW' || (activationRequested && gate.live_execution_authorized);

  return Object.freeze({
    schema: 'aether.admin_live_control.v1',
    action: requested,
    accepted,
    requested_live: activationRequested,
    effective_mode: gate.live_execution_authorized ? 'LIVE' : 'SHADOW',
    gate,
    fail_closed: true,
    audit_required: requested !== 'STATUS',
    message: gate.live_execution_authorized ? 'LIVE_EXECUTION_AUTHORIZED' : 'LIVE_EXECUTION_REMAINS_LOCKED'
  });
}
