import { spawnSync } from 'node:child_process';

const checks = Object.freeze([
  ['paper_queue_reliability', 'scripts/step8-paper-queue-reliability-regression.mjs'],
  ['paper_persistence_guards', 'scripts/step8-paper-persistence-guards-regression.mjs'],
  ['state_recovery', 'scripts/step8-state-recovery-regression.mjs'],
  ['member_runtime_binding', 'scripts/step21-member-autotrade-runtime-binding-regression.mjs'],
  ['market_shadow_observability', 'scripts/market-shadow-observability-regression.mjs']
]);

const results = [];
for (const [name, file] of checks) {
  const run = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      EXECUTION_MODE: 'SHADOW',
      LIVE_ENABLED: 'false'
    },
    timeout: 60_000
  });
  const passed = run.status === 0;
  results.push({
    name,
    passed,
    exit_code: run.status,
    signal: run.signal || null
  });
  if (!passed) {
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    console.error(JSON.stringify({
      status: 'FAIL',
      schema: 'aether.step8.shadow-settlement-reliability.v1',
      checks: results,
      mode: 'SHADOW',
      live_execution_authorized: false
    }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({
  status: 'PASS',
  schema: 'aether.step8.shadow-settlement-reliability.v1',
  checks: results,
  guarantees: {
    stable_candidate_idempotency: true,
    duplicate_accounting_blocked: true,
    queue_ack_after_processing: true,
    queue_retry_without_silent_drop: true,
    queue_overflow_fail_closed: true,
    stale_execution_state_recovery: true,
    scanner_sla_guard: true,
    stale_opportunity_guard: true,
    atomic_two_leg_required: true
  },
  mode: 'SHADOW',
  live_execution_authorized: false
}, null, 2));