import { spawnSync } from 'node:child_process';

const checks = Object.freeze([
  ['decoder_fixture_coverage', 'scripts/run-decoder-fixtures.mjs'],
  ['signal_quality_scenarios', 'scripts/run-signal-quality-tests.mjs'],
  ['cross_venue_net_edge', 'scripts/cross-venue-net-edge-regression.mjs'],
  ['member_demo_accounting', 'scripts/member-autotrade-demo-regression.mjs'],
  ['shadow_lifecycle', 'scripts/shadow-autotrade-lifecycle-bridge-regression.mjs'],
  ['fifo_accounting', 'scripts/fifo-accounting-regression.mjs'],
  ['follower_position_accounting', 'scripts/follower-position-accounting-regression.mjs'],
  ['market_shadow_observability', 'scripts/market-shadow-observability-regression.mjs']
]);

const results = [];
for (const [name, file] of checks) {
  const run = spawnSync(process.execPath, [file], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false' }
  });
  const passed = run.status === 0;
  results.push({ name, passed });
  if (!passed) {
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    process.exit(1);
  }
}

console.log(JSON.stringify({ status: 'PASS', schema: 'aether.step20.shadow-validation.v1', checks: results, mode: 'SHADOW', min_expected_net_edge_bps: 20, live_execution_authorized: false }, null, 2));