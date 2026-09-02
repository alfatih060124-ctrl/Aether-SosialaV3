const FEE_CONFIG_SCHEMA = 'aether.fee_control.v1';
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

function assertRole(actor) {
  if (!actor || typeof actor !== 'object') throw new Error('actor_required');
  if (actor.role !== 'FEE_CONFIG_OPERATOR') throw new Error('fee_operator_role_required');
  canonicalActorId(actor.actor_id);
}

export function createFeeConfig(input, actor) {
  assertRole(actor);
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
  const next = createFeeConfig(proposed, actor);
  if (!current || current.schema !== FEE_CONFIG_SCHEMA) throw new Error('current_fee_config_required');

  return Object.freeze({
    schema: 'aether.fee_control_change.v1',
    status: 'PENDING_APPROVAL',
    requested_by: actor.actor_id,
    approved_by: null,
    current,
    proposed: next,
    applied: false,
  });
}

export function approveFeeConfigChange(change, approver) {
  if (!change || change.schema !== 'aether.fee_control_change.v1') throw new Error('fee_change_required');
  if (!approver || approver.role !== 'FEE_CONFIG_APPROVER') throw new Error('fee_approver_role_required');
  const approverId = canonicalActorId(approver.actor_id, 'approver_id_required');
  const requestedBy = canonicalActorId(change.requested_by, 'invalid_requested_by');
  if (requestedBy === approverId) throw new Error('separation_of_duties_required');
  if (change.status !== 'PENDING_APPROVAL' || change.applied) throw new Error('fee_change_not_approvable');

  return Object.freeze({
    ...change,
    status: 'APPROVED',
    approved_by: approverId,
    applied: false,
  });
}

export function applyApprovedFeeConfig(change, actor) {
  if (!change || change.status !== 'APPROVED') throw new Error('approved_fee_change_required');
  if (!actor || actor.role !== 'FEE_CONFIG_APPLIER') throw new Error('fee_applier_role_required');
  const applierId = canonicalActorId(actor.actor_id, 'applier_id_required');
  const requestedBy = canonicalActorId(change.requested_by, 'invalid_requested_by');
  const approvedBy = canonicalActorId(change.approved_by, 'invalid_approved_by');
  if (applierId === requestedBy || applierId === approvedBy) {
    throw new Error('separation_of_duties_required');
  }

  return Object.freeze({
    config: change.proposed,
    audit: Object.freeze({
      schema: 'aether.fee_control_audit.v1',
      requested_by: requestedBy,
      approved_by: approvedBy,
      applied_by: applierId,
      mode: 'SHADOW',
      live_execution_authorized: false,
    }),
  });
}
