const truthy = (value, fallback = false) => {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

export const LIVE_GATE_STEPS = Object.freeze([
  'readiness_passed',
  'admin_live_approved',
  'signer_unlocked',
  'network_submission_enabled',
  'fund_movement_enabled'
]);

export function getLiveExecutionGateState(input = {}, env = process.env) {
  const state = Object.freeze({
    execution_mode: String(input.execution_mode || env.EXECUTION_MODE || 'SHADOW').toUpperCase(),
    live_enabled: truthy(input.live_enabled, truthy(env.LIVE_ENABLED, false)),
    readiness_passed: truthy(input.readiness_passed, truthy(env.LIVE_READINESS_PASSED, false)),
    admin_live_approved: truthy(input.admin_live_approved, truthy(env.ADMIN_LIVE_APPROVED, false)),
    signer_unlocked: truthy(input.signer_unlocked, truthy(env.LIVE_SIGNER_UNLOCKED, false)),
    network_submission_enabled: truthy(input.network_submission_enabled, truthy(env.LIVE_NETWORK_SUBMISSION_ENABLED, false)),
    fund_movement_enabled: truthy(input.fund_movement_enabled, truthy(env.LIVE_FUND_MOVEMENT_ENABLED, false)),
    emergency_kill_switch: truthy(input.emergency_kill_switch, truthy(env.LIVE_EMERGENCY_KILL_SWITCH, true))
  });

  const blockers = [];
  if (state.execution_mode !== 'LIVE') blockers.push('EXECUTION_MODE_NOT_LIVE');
  if (!state.live_enabled) blockers.push('LIVE_DISABLED');
  if (!state.readiness_passed) blockers.push('LIVE_READINESS_NOT_PASSED');
  if (!state.admin_live_approved) blockers.push('ADMIN_LIVE_NOT_APPROVED');
  if (!state.signer_unlocked) blockers.push('SIGNER_LOCKED');
  if (!state.network_submission_enabled) blockers.push('NETWORK_SUBMISSION_LOCKED');
  if (!state.fund_movement_enabled) blockers.push('FUND_MOVEMENT_LOCKED');
  if (state.emergency_kill_switch) blockers.push('EMERGENCY_KILL_SWITCH_ACTIVE');

  return Object.freeze({
    schema: 'aether.live_execution_gate.v1',
    state,
    blockers: Object.freeze(blockers),
    live_execution_authorized: blockers.length === 0,
    fail_closed: true
  });
}

export function assertLiveExecutionAuthorized(input = {}, env = process.env) {
  const gate = getLiveExecutionGateState(input, env);
  if (!gate.live_execution_authorized) {
    const error = new Error('live_execution_gate_closed');
    error.code = 'LIVE_EXECUTION_GATE_CLOSED';
    error.blockers = gate.blockers;
    throw error;
  }
  return gate;
}
