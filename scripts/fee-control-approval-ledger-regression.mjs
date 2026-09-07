import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createFeeConfig,
  proposeFeeConfigChange,
  approveFeeConfigChange,
  applyApprovedFeeConfig,
} from '../services/api/src/fee-control.mjs';

const migration = fs.readFileSync(new URL('../migrations/020_fee_control_approval_ledger.sql', import.meta.url), 'utf8');
const repository = fs.readFileSync(new URL('../services/api/src/repositories/fee-control-approval.mjs', import.meta.url), 'utf8');

const operator = { role: 'FEE_CONFIG_OPERATOR', actor_id: 'operator:alpha' };
const approver = { role: 'FEE_CONFIG_APPROVER', actor_id: 'approver:beta' };
const applier = { role: 'FEE_CONFIG_APPLIER', actor_id: 'applier:gamma' };
const current = createFeeConfig({
  performance_fee_bps: 1000,
  execution_fee_bps: 25,
  mode: 'SHADOW',
  live_execution_authorized: false,
}, operator);
const pending = proposeFeeConfigChange(current, {
  performance_fee_bps: 900,
  execution_fee_bps: 20,
  mode: 'SHADOW',
  live_execution_authorized: false,
}, operator);
assert.equal(pending.status, 'PENDING_APPROVAL');
assert.equal(pending.applied, false);

assert.throws(
  () => approveFeeConfigChange(pending, { role: 'FEE_CONFIG_APPROVER', actor_id: operator.actor_id }),
  /separation_of_duties_required/,
);
const approved = approveFeeConfigChange(pending, approver);
assert.equal(approved.status, 'APPROVED');
assert.equal(approved.approved_by, approver.actor_id);
assert.throws(
  () => applyApprovedFeeConfig(approved, { role: 'FEE_CONFIG_APPLIER', actor_id: approver.actor_id }),
  /separation_of_duties_required/,
);
const applied = applyApprovedFeeConfig(approved, applier);
assert.equal(applied.change.status, 'APPLIED');
assert.equal(applied.audit.requested_by, operator.actor_id);
assert.equal(applied.audit.approved_by, approver.actor_id);
assert.equal(applied.audit.applied_by, applier.actor_id);
assert.equal(applied.audit.mode, 'SHADOW');
assert.equal(applied.audit.live_execution_authorized, false);
assert.equal(applied.audit.network_submission_authorized, false);
assert.equal(applied.audit.signer_required, false);

for (const required of [
  'CREATE TABLE IF NOT EXISTS fee_control_changes',
  "status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','APPLIED'))",
  'proposed_performance_fee_bps + proposed_execution_fee_bps <= 10000',
  'approved_by <> requested_by',
  'applied_by <> requested_by',
  "requested_role = 'FEE_CONFIG_OPERATOR'",
  "approved_role = 'FEE_CONFIG_APPROVER'",
  "applied_role = 'FEE_CONFIG_APPLIER'",
  "live_execution_authorized = false",
  "network_submission_authorized = false",
  "signer_required = false",
  'aether_guard_fee_control_change_transition',
  'fee_change_immutable_fields_modified',
  'invalid_fee_change_transition',
  "current_setting('aether.fee_change_id', true)",
  "current_setting('aether.actor_role', true)",
  "actor_role IS DISTINCT FROM 'FEE_CONFIG_APPLIER'",
  'fee_config_applier_role_required',
  'fee_change_context_required',
  "status = 'APPROVED'",
  'fee_change_payload_mismatch',
  'separation_of_duties_required',
  'PLATFORM_FEE_CHANGE_REQUESTED',
  'PLATFORM_FEE_CHANGE_APPROVED',
  'PLATFORM_FEE_CHANGE_APPLIED',
]) assert.ok(migration.includes(required), `missing migration invariant: ${required}`);

for (const required of [
  "import crypto from 'node:crypto'",
  "proposeFeeConfigChange",
  "approveFeeConfigChange",
  "applyApprovedFeeConfig",
  "await client.query('BEGIN')",
  "await client.query('COMMIT')",
  "await client.query('ROLLBACK')",
  'FOR UPDATE',
  "set_config('aether.actor',$1,true)",
  "set_config('aether.actor_role',$1,true)",
  "set_config('aether.fee_change_id',$1,true)",
  "status='PENDING_APPROVAL'",
  "status='APPROVED'",
  "status='APPLIED'",
  'execution_dispatched: false',
]) assert.ok(repository.includes(required), `missing repository invariant: ${required}`);

assert.ok(!repository.includes('LIVE_ENABLED=true'));
assert.ok(!repository.includes('FIXTURE_GATE_PASSED=true'));
assert.ok(!repository.includes('OPERATOR_APPROVED=true'));
assert.ok(!/private[_-]?key|seed[_-]?phrase|mnemonic/i.test(repository));

console.log('fee control approval ledger regression: ok');
