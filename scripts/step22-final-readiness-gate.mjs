import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const REQUIRED_EDGE_BPS = 20;
const checks = [
  ['step20_shadow_validation', 'scripts/step20-shadow-validation-gate.mjs'],
  ['step21_admin_control_panel', 'scripts/step21-admin-control-panel-regression.mjs'],
  ['step21_member_area', 'scripts/step21-member-area-regression.mjs'],
  ['step21_subscription', 'scripts/step21-subscription-regression.mjs'],
  ['delegated_authority', 'scripts/regression-member-delegated-authority.mjs'],
  ['funding_preflight', 'scripts/regression-member-live-funding-preflight.mjs'],
  ['autotrade_state_machine', 'scripts/regression-member-autotrade-state-machine.mjs'],
  ['shadow_runtime_binding', 'scripts/step21-member-autotrade-runtime-binding-regression.mjs'],
  ['paper_persistence', 'scripts/regression-paper-arbitrage-persistence.mjs'],
  ['two_leg_live_boundary', 'scripts/regression-two-leg-live-execution-boundary.mjs'],
  ['live_gate_fail_closed', 'scripts/run-live-gate-tests.mjs'],
  ['infrastructure_contract', 'scripts/infrastructure-contract.mjs'],
  ['postdeploy_shadow_audit_contract', 'scripts/postdeploy-shadow-audit-regression.mjs']
];

const safeEnv = {
  ...process.env,
  EXECUTION_MODE: 'SHADOW',
  LIVE_ENABLED: 'false',
  FIXTURE_GATE_PASSED: 'false',
  OPERATOR_APPROVED: 'false',
  SIGNAL_MIN_EXPECTED_NET_EDGE_BPS: String(REQUIRED_EDGE_BPS)
};

const requiredFiles = [
  'docs/STEP22_OPERATOR_APPROVAL_WORKFLOW.md',
  'docs/STEP22_RELEASE_READINESS.md',
  'web/admin.html',
  'public/member.html',
  'services/api/src/live-execution-gate.mjs',
  'services/api/src/member-autotrade-shadow-scheduler.mjs'
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    console.error(`step22 missing required file: ${file}`);
    process.exit(1);
  }
}

const results = [];
for (const [name, file] of checks) {
  const run = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: safeEnv,
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024
  });
  const passed = run.status === 0;
  results.push({ name, passed });
  if (!passed) {
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    console.error(`step22 check failed: ${name}`);
    process.exit(1);
  }
}

const approvalDoc = fs.readFileSync('docs/STEP22_OPERATOR_APPROVAL_WORKFLOW.md', 'utf8');
for (const marker of [
  'LIVE remains OFF',
  'separate explicit user instruction',
  'OPERATOR_APPROVED=false',
  'Emergency Kill',
  '0.20%',
  'LIVE PILOT'
]) {
  if (!approvalDoc.includes(marker)) {
    console.error(`step22 operator workflow missing marker: ${marker}`);
    process.exit(1);
  }
}

const runtimeGate = await import('../services/api/src/live-execution-gate.mjs');
const gate = runtimeGate.getLiveExecutionGateState({}, safeEnv);
if (gate.live_execution_authorized) {
  console.error('step22 safety violation: LIVE unexpectedly authorized');
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'PASS',
  schema: 'aether.step22.final-readiness.v1',
  checks: results,
  release_candidate_ready: true,
  execution_mode: 'SHADOW',
  live_enabled: false,
  fixture_gate_passed: false,
  operator_approved: false,
  min_expected_net_edge_bps: REQUIRED_EDGE_BPS,
  live_execution_authorized: false,
  next_after_step22: 'LIVE_PILOT_REQUIRES_SEPARATE_EXPLICIT_USER_INSTRUCTION'
}, null, 2));
