import { spawnSync } from 'node:child_process';

const checks = Object.freeze([
  ['native_execution_gate', 'scripts/step456-native-execution-gate.mjs'],
  ['intelligent_approval', 'scripts/step7-intelligent-approval-regression.mjs'],
  ['settlement_reliability', 'scripts/step8-shadow-settlement-reliability-gate.mjs'],
  ['dashboard_web', 'scripts/market-shadow-web-regression.mjs'],
  ['market_observability', 'scripts/market-shadow-observability-regression.mjs']
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
    timeout: 120_000
  });
  const passed = run.status === 0;
  results.push({ name, passed, exit_code: run.status, signal: run.signal || null });
  if (!passed) {
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    console.error(JSON.stringify({
      status: 'FAIL',
      schema: 'aether.step9.prebenchmark.v1',
      checks: results,
      mode: 'SHADOW',
      live_execution_authorized: false
    }, null, 2));
    process.exit(1);
  }
}

const probeEnv = {
  ...process.env,
  EXECUTION_MODE: 'SHADOW',
  LIVE_ENABLED: 'false',
  AUTOTRADE_PAPER_MIN_NET_EDGE_BPS: '0.5',
  AETHER_MARKET_VIEWS: 'trending,gainers,volume,new',
  AETHER_MARKET_PROBE_LIMIT: '6',
  AETHER_CROSS_VENUE_CANDIDATE_LIMIT: '4',
  AETHER_HOTPATH_WORKERS: '2',
  AETHER_FASTPATH_PAIR_LIMIT: '2',
  AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS: '4',
  AETHER_HOTPATH_REQUEST_TIMEOUT_MS: '900',
  AETHER_JUPITER_UNIVERSE_ENABLED: 'true',
  AETHER_JUPITER_UNIVERSE_LIMIT: '8',
  AETHER_JUPITER_PREFER_PUBLIC: 'true',
  AETHER_JUPITER_INTER_QUOTE_DELAY_MS: '300',
  AETHER_REAL_MARKET_ROUTE_ANCHORS_ENABLED: 'true'
};
const probe = spawnSync(process.execPath, ['scripts/vm-cross-venue-net-edge-probe.mjs'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: probeEnv,
  timeout: 90_000,
  maxBuffer: 12 * 1024 * 1024
});
if (probe.status !== 0) {
  process.stderr.write(probe.stderr || '');
  throw new Error('step9_real_market_probe_failed');
}
const start = probe.stdout.indexOf('{');
const end = probe.stdout.lastIndexOf('}');
if (start < 0 || end < start) throw new Error('step9_real_market_probe_output_invalid');
const report = JSON.parse(probe.stdout.slice(start, end + 1));
const rows = Array.isArray(report.results) ? report.results : [];
const complete = rows.filter(row =>
  row.mode === 'SHADOW' &&
  row.transaction_built === true &&
  row.atomic_two_leg === true &&
  row.exact_transaction_fee_ready === true &&
  row.costs_verified === true &&
  row.roundtrip_simulation_ok === true &&
  Number.isFinite(Number(row.expected_net_edge_bps)) &&
  Number.isFinite(Number(row.analysis_latency_ms)) &&
  Number(row.analysis_latency_ms) <= 300 &&
  Number.isFinite(Number(row.opportunity_age_ms)) &&
  Number(row.opportunity_age_ms) <= 3000 &&
  row.execution_dispatched === false &&
  row.transaction_signed === false &&
  row.network_submission_authorized === false &&
  row.live_execution_authorized === false
);
if (!complete.length) {
  console.error(JSON.stringify({
    status: 'FAIL',
    reason: 'no_complete_real_market_atomic_evaluation_under_sla',
    status_counts: rows.reduce((acc, row) => {
      const key = String(row.status || 'UNKNOWN');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  }, null, 2));
  process.exit(1);
}

const edgePass = complete.filter(row => Number(row.expected_net_edge_bps) >= 0.5);
const qualified = complete.filter(row => row.paper_approval_passed === true);

console.log(JSON.stringify({
  status: 'PASS',
  schema: 'aether.step9.prebenchmark.v1',
  checks: results,
  real_market_probe: {
    candidates_discovered: Number(report.candidates_discovered || 0),
    candidates_scanned: Number(report.candidates_scanned || 0),
    complete_atomic_under_sla: complete.length,
    edge_passed: edgePass.length,
    paper_qualified: qualified.length,
    best_complete_net_edge_bps: complete.reduce((best, row) => Math.max(best, Number(row.expected_net_edge_bps)), -Infinity),
    min_scanner_latency_ms: Math.min(...complete.map(row => Number(row.analysis_latency_ms))),
    max_scanner_latency_ms: Math.max(...complete.map(row => Number(row.analysis_latency_ms))),
    max_e2e_age_ms: Math.max(...complete.map(row => Number(row.opportunity_age_ms))),
    route_anchor_candidates: Number(report.route_anchor_candidates || 0)
  },
  benchmark_ready: true,
  mode: 'SHADOW',
  live_execution_authorized: false
}, null, 2));