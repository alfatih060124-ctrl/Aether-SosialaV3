import assert from 'node:assert/strict';
import {
  createFeeConfig,
  proposeFeeConfigChange,
  approveFeeConfigChange,
  applyApprovedFeeConfig,
} from './fee-control.mjs';

const operator = { role: 'FEE_CONFIG_OPERATOR', actor_id: 'operator-1' };
const approver = { role: 'FEE_CONFIG_APPROVER', actor_id: 'approver-1' };
const applier = { role: 'FEE_CONFIG_APPLIER', actor_id: 'applier-1' };

const current = createFeeConfig({
  mode: 'SHADOW',
  performance_fee_bps: 1200,
  execution_fee_bps: 25,
  live_execution_authorized: false,
}, operator);

assert.equal(current.mode, 'SHADOW');
assert.equal(current.live_execution_authorized, false);
assert.equal(current.network_submission_authorized, false);
assert.equal(current.signer_required, false);

assert.throws(() => createFeeConfig({
  mode: 'LIVE',
  performance_fee_bps: 1200,
  execution_fee_bps: 25,
  live_execution_authorized: true,
}, operator), /live_execution_must_remain_false|shadow_mode_required/);

assert.throws(() => createFeeConfig({
  mode: 'SHADOW',
  performance_fee_bps: 10001,
  execution_fee_bps: 0,
  live_execution_authorized: false,
}, operator), /invalid_performance_fee_bps/);

assert.throws(() => createFeeConfig({
  mode: 'SHADOW',
  performance_fee_bps: 1200,
  execution_fee_bps: 25,
  live_execution_authorized: false,
}, { role: 'FEE_CONFIG_OPERATOR', actor_id: ' operator-1' }), /actor_id_required/);

assert.throws(() => createFeeConfig({
  mode: 'SHADOW',
  performance_fee_bps: 1200,
  execution_fee_bps: 25,
  live_execution_authorized: false,
}, { role: 'FEE_CONFIG_OPERATOR', actor_id: '   ' }), /actor_id_required/);

const change = proposeFeeConfigChange(current, {
  mode: 'SHADOW',
  performance_fee_bps: 1500,
  execution_fee_bps: 30,
  live_execution_authorized: false,
}, operator);

assert.equal(change.status, 'PENDING_APPROVAL');
assert.equal(change.applied, false);
assert.throws(() => approveFeeConfigChange(change, { role: 'FEE_CONFIG_APPROVER', actor_id: 'operator-1' }), /separation_of_duties_required/);
assert.throws(() => approveFeeConfigChange(change, { role: 'FEE_CONFIG_APPROVER', actor_id: ' operator-1' }), /approver_id_required/);

const approved = approveFeeConfigChange(change, approver);
assert.equal(approved.status, 'APPROVED');
assert.throws(() => applyApprovedFeeConfig(approved, { role: 'FEE_CONFIG_APPLIER', actor_id: 'approver-1' }), /separation_of_duties_required/);
assert.throws(() => applyApprovedFeeConfig(approved, { role: 'FEE_CONFIG_APPLIER', actor_id: ' approver-1' }), /applier_id_required/);

const applied = applyApprovedFeeConfig(approved, applier);
assert.equal(applied.config.performance_fee_bps, 1500);
assert.equal(applied.audit.requested_by, 'operator-1');
assert.equal(applied.audit.approved_by, 'approver-1');
assert.equal(applied.audit.applied_by, 'applier-1');
assert.equal(applied.audit.live_execution_authorized, false);

console.log('fee control regression: ok');
