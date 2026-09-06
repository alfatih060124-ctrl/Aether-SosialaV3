const FEE_CONFIG_SCHEMA = 'aether.fee_control.v1';
const FEE_CHANGE_SCHEMA = 'aether.fee_control_change.v1';
const MAX_BPS = 10_000;
const ACTOR_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function assertIntegerBps(name, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BPS) {
    throw new Error(`invalid_${name}_bps`);
  }
}

function canonicalActorId(value, errorName = 'actor_id_required') {
  if (typeof value !== 'string' || !ACTOR_ID_RE.test(value)) throw new Error(errorName);
  return value;
}

function assertActor(actor, role, idError) {
  if (!actor || typeof actor !== 'object') throw new Error('actor_required');
  if (actor.role !== role) throw new Error(`${role.toLowerCase()}_required`);
  canonicalActorId(actor.actor_id, idError);
}

function assertCanonicalFeeConfig(config) {
  if (!config || typeof config !== 'object' || config.schema !== FEE_CONFIG_SCHEMA) {
    throw new Error('invalid_fee_config');
  }
  assertIntegerBps('performance_fee', config.performance_fee_bps);
  assertIntegerBps('execution_fee', config.execution_fee_bps);
  if (config.performance_fee_bps + config.execution_fee_bps > MAX_BPS) {
    throw new Error('combined_fee_exceeds_100_percent');
  }
  if (config.mode !== 'SHADOW') throw new Error('shadow_mode_required');
  if (config.live_execution_authorized !== false) throw new Error('live_execution_must_remain_false');
  if (config.network_submission_authorized !== false) throw new Error('network_submission_must_remain_false');
  if (config.signer_required !== false) throw new Error('signer_must_remain_false');
  canonicalActorId(config.configured_by, 'configured_by_required');
  return config;
}

function assertCanonicalChange(change) {
  if (!change || typeof change !== 'object' || change.schema !== FEE_CHANGE_SCHEMA) {
    throw new Error('fee_change_required');
  }
  canonicalActorId(change.requested_by, 'requester_id_required');
  if (change.approved_by !== null) canonicalActorId(change.approved_by, 'approver_id_required');
  if (!['PENDING_APPROVAL', 'APPROVED', 'APPLIED'].includes(change.status)) throw new Error('invalid_fee_change_status');
  if (typeof change.applied !== 'boolean') throw new Error('invalid_fee_change_applied');
  assertCanonicalFeeConfig(change.current);
  assertCanonicalFeeConfig(change.proposed);
  return change;
}

export function createFeeConfig(input, actor) {
  assertActor(actor, 'FEE_CONFIG_OPERATOR', 'actor_id_required');
  if (!input || typeof input !== 'object') throw new Error('fee_config_required');

  const performanceFeeBps = input.performance_fee_bps;
  const executionFeeBps = input.execution_fee_bps;
  assertIntegerBps('performance_fee', performanceFeeBps);
  assertIntegerBps('execution_fee', executionFeeBps);

  if (performanceFeeBps + executionFeeBps > MAX_BPS) {
    throw new Error('combined_fee_exceeds_100_percent');
  }

  if (input.live_execution_authorized !== false) throw new Error('live_execution_must_remain_false');
  if (input.mode !== 'SHADOW') throw new Error('shadow_mode_required');

  return Object.freeze({
    schema: FEE_CONFIG_SCHEMA,
    mode: 'SHADOW',
    performance_fee_bps: performanceFeeBps,
    execution_fee_bps: executionFeeBps,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false,
    configured_by: actor.actor_id,
  });
}

export function proposeFeeConfigChange(current, proposed, actor) {
  assertCanonicalFeeConfig(current);
  const next = createFeeConfig(proposed, actor);

  return Object.freeze({
    schema: FEE_CHANGE_SCHEMA,
    status: 'PENDING_APPROVAL',
    requested_by: actor.actor_id,
    approved_by: null,
    current,
    proposed: next,
    applied: false,
  });
}

export function approveFeeConfigChange(change, approver) {
  assertCanonicalChange(change);
  assertActor(approver, 'FEE_CONFIG_APPROVER', 'approver_id_required');
  if (change.requested_by === approver.actor_id) throw new Error('separation_of_duties_required');
  if (change.status !== 'PENDING_APPROVAL' || change.applied) throw new Error('fee_change_not_approvable');

  return Object.freeze({
    ...change,
    status: 'APPROVED',
    approved_by: approver.actor_id,
    applied: false,
  });
}

export function applyApprovedFeeConfig(change, actor) {
  assertCanonicalChange(change);
  assertActor(actor, 'FEE_CONFIG_APPLIER', 'applier_id_required');
  if (change.status !== 'APPROVED' || change.applied) throw new Error('approved_fee_change_required');
  if (!change.approved_by) throw new Error('approver_id_required');
  if (actor.actor_id === change.requested_by || actor.actor_id === change.approved_by) {
    throw new Error('separation_of_duties_required');
  }

  const consumedChange = Object.freeze({
    ...change,
    status: 'APPLIED',
    applied: true,
  });

  return Object.freeze({
    config: change.proposed,
    change: consumedChange,
    audit: Object.freeze({
      schema: 'aether.fee_control_audit.v1',
      requested_by: change.requested_by,
      approved_by: change.approved_by,
      applied_by: actor.actor_id,
      mode: 'SHADOW',
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false,
    }),
  });
}
