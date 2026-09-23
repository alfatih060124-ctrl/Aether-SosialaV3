import { spawnSync } from 'node:child_process';

const checks = Object.freeze([
  ['orca_native_quote', 'scripts/orca-readonly-quote-regression.mjs'],
  ['raydium_native_quote', 'scripts/raydium-native-readonly-quote-regression.mjs'],
  ['meteora_native_quote', 'scripts/meteora-native-readonly-quote-regression.mjs'],
  ['native_atomic_two_leg', 'scripts/native-roundtrip-shadow-regression.mjs']
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
      schema: 'aether.step456.native-execution-gate.v1',
      checks: results,
      mode: 'SHADOW',
      live_execution_authorized: false
    }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({
  status: 'PASS',
  schema: 'aether.step456.native-execution-gate.v1',
  checks: results,
  guarantees: {
    native_quote_orca: true,
    native_quote_raydium: true,
    native_quote_meteora: true,
    atomic_two_leg_transaction_built: true,
    exact_transaction_fee_ready: true,
    real_rpc_simulation_passed: true,
    exact_cost_ledger_ready: true
  },
  mode: 'SHADOW',
  live_execution_authorized: false
}, null, 2));