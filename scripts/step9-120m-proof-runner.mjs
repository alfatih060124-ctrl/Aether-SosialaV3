import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { persistQualifiedPaperArbitrageProbe } from '../services/api/src/paper-arbitrage-persistence.mjs';
import { memberPaperIdempotencyKey } from '../services/api/src/member-autotrade-shadow-scheduler.mjs';

const require = createRequire(new URL('../services/api/package.json', import.meta.url));
const { Pool } = require('pg');

const durationMs = Math.max(30_000, Number(process.env.AETHER_BENCHMARK_DURATION_MS || 7_200_000));
const betweenScansMs = Math.max(0, Number(process.env.AETHER_BENCHMARK_BETWEEN_SCANS_MS || 2_000));
const databaseUrl = String(process.env.AETHER_BENCHMARK_DATABASE_URL || '').trim();
const outputDir = String(process.env.AETHER_BENCHMARK_OUTPUT_DIR || '/tmp/aether-benchmark').trim();
const benchmarkUserId = '00000000-0000-0000-0000-00000000b901';
const notionalRaw = String(process.env.AETHER_BENCHMARK_NOTIONAL_USDC_RAW || '5000000');
const performanceFeeBps = Math.max(0, Math.min(10_000, Number(process.env.AETHER_BENCHMARK_PERFORMANCE_FEE_BPS || 0)));
const executionFeeBps = Math.max(0, Math.min(10_000 - performanceFeeBps, Number(process.env.AETHER_BENCHMARK_EXECUTION_FEE_BPS || 0)));
if (!databaseUrl) throw new Error('benchmark_database_url_required');

fs.mkdirSync(outputDir, { recursive: true });
const statePath = path.join(outputDir, 'state.json');
const scansPath = path.join(outputDir, 'scans.jsonl');
const finalPath = path.join(outputDir, 'final.json');
const startedAtMs = Date.now();
const endsAtMs = startedAtMs + durationMs;
const pool = new Pool({ connectionString: databaseUrl, max: 3 });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);

async function bootstrapDb() {
  const client = await pool.connect();
  try {
    for (const file of [
      'migrations/024_paper_arbitrage_persistence.sql',
      'migrations/029_paper_execution_fee_accounting.sql',
      'migrations/030_expand_paper_shadow_dex_constraints.sql'
    ]) {
      await client.query(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
    }
  } finally {
    client.release();
  }
}

function parseProbe(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('benchmark_probe_output_invalid');
  return JSON.parse(stdout.slice(start, end + 1));
}

function freshProbe() {
  const env = {
    ...process.env,
    EXECUTION_MODE: 'SHADOW',
    LIVE_ENABLED: 'false',
    AUTOTRADE_PAPER_MIN_NET_EDGE_BPS: '0.5',
    AETHER_JUPITER_QUOTE_USDC_RAW: notionalRaw,
    AETHER_MARKET_VIEWS: 'trending,gainers,volume,new',
    AETHER_MARKET_PROBE_LIMIT: String(process.env.AETHER_BENCHMARK_MARKET_PROBE_LIMIT || 20),
    AETHER_CROSS_VENUE_CANDIDATE_LIMIT: '0',
    AETHER_HOTPATH_WORKERS: String(process.env.AETHER_BENCHMARK_HOTPATH_WORKERS || 4),
    AETHER_FASTPATH_PAIR_LIMIT: String(process.env.AETHER_BENCHMARK_FASTPATH_PAIR_LIMIT || 4),
    AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS: String(process.env.AETHER_BENCHMARK_DEX_PAIR_ATTEMPTS || 8),
    AETHER_HOTPATH_REQUEST_TIMEOUT_MS: '900',
    AETHER_JUPITER_UNIVERSE_ENABLED: 'true',
    AETHER_JUPITER_UNIVERSE_LIMIT: String(process.env.AETHER_BENCHMARK_JUPITER_UNIVERSE_LIMIT || 20),
    AETHER_JUPITER_PREFER_PUBLIC: 'true',
    AETHER_JUPITER_INTER_QUOTE_DELAY_MS: String(process.env.AETHER_BENCHMARK_JUPITER_DELAY_MS || 300),
    AETHER_REAL_MARKET_ROUTE_ANCHORS_ENABLED: 'true'
  };
  const run = spawnSync(process.execPath, ['scripts/vm-cross-venue-net-edge-probe.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (run.status !== 0) {
    throw new Error('benchmark_probe_failed:' + String(run.stderr || '').slice(-500));
  }
  return parseProbe(run.stdout);
}

const aggregate = {
  schema: 'aether.step9.120m-proof.v1',
  mode: 'SHADOW',
  live_execution_authorized: false,
  transaction_count_cap: null,
  token_scan_cap: null,
  started_at: new Date(startedAtMs).toISOString(),
  target_duration_ms: durationMs,
  scans_started: 0,
  scans_completed: 0,
  scans_failed: 0,
  candidates_discovered: 0,
  candidates_scanned: 0,
  complete_atomic_evaluations: 0,
  scanner_sla_passed_complete: 0,
  e2e_sla_passed_complete: 0,
  edge_passed: 0,
  paper_qualified: 0,
  paper_settled: 0,
  duplicate_settlements_blocked: 0,
  profitable_settlements: 0,
  losing_settlements: 0,
  gross_profit_before_costs_usdc: 0,
  market_net_pnl_usdc: 0,
  member_net_profit_usdc: 0,
  net_edges_bps: [],
  scanner_latencies_ms: [],
  e2e_ages_ms: [],
  status_counts: {},
  provider_errors: {},
  last_error: null
};

function increment(map, key) {
  const normalized = String(key || 'UNKNOWN');
  map[normalized] = (map[normalized] || 0) + 1;
}

function isComplete(row) {
  return row?.mode === 'SHADOW' &&
    row?.transaction_built === true &&
    row?.atomic_two_leg === true &&
    row?.exact_transaction_fee_ready === true &&
    row?.costs_verified === true &&
    row?.roundtrip_simulation_ok === true &&
    finite(row?.expected_net_edge_bps) !== null;
}

async function settleQualified(row, scanId) {
  const result = await persistQualifiedPaperArbitrageProbe(
    pool,
    { user_id: benchmarkUserId, primary_wallet: 'BENCHMARK_READONLY' },
    row,
    {
      performanceFeeBps,
      executionFeeBps,
      initialBalanceUsdc: 100,
      idempotencyKey: memberPaperIdempotencyKey(scanId, row),
      minNetEdgeBps: 0.5
    }
  );
  if (result.duplicate) {
    aggregate.duplicate_settlements_blocked += 1;
    return;
  }
  aggregate.paper_settled += 1;
  const accounting = result.accounting || null;
  if (accounting?.member_net_profit_usdc > 0) aggregate.profitable_settlements += 1;
  if (accounting?.member_net_profit_usdc < 0) aggregate.losing_settlements += 1;
}

function writeState(extra = {}) {
  const values = aggregate.net_edges_bps;
  const scanner = aggregate.scanner_latencies_ms;
  const e2e = aggregate.e2e_ages_ms;
  const snapshot = {
    ...aggregate,
    elapsed_ms: Date.now() - startedAtMs,
    remaining_ms: Math.max(0, endsAtMs - Date.now()),
    avg_complete_net_edge_bps: values.length ? values.reduce((a,b) => a+b, 0) / values.length : null,
    avg_scanner_latency_ms: scanner.length ? scanner.reduce((a,b) => a+b, 0) / scanner.length : null,
    max_scanner_latency_ms: scanner.length ? Math.max(...scanner) : null,
    avg_e2e_age_ms: e2e.length ? e2e.reduce((a,b) => a+b, 0) / e2e.length : null,
    max_e2e_age_ms: e2e.length ? Math.max(...e2e) : null,
    ...extra
  };
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(snapshot, null, 2));
  fs.renameSync(statePath + '.tmp', statePath);
  return snapshot;
}

await bootstrapDb();
writeState({ status: 'RUNNING' });

while (Date.now() < endsAtMs) {
  aggregate.scans_started += 1;
  const scanStarted = Date.now();
  try {
    const report = freshProbe();
    aggregate.scans_completed += 1;
    aggregate.candidates_discovered += Number(report.candidates_discovered || 0);
    aggregate.candidates_scanned += Number(report.candidates_scanned || 0);
    const rows = Array.isArray(report.results) ? report.results : [];
    const scanId = 'benchmark:' + aggregate.scans_started + ':' + String(report.observed_at || new Date().toISOString());
    for (const row of rows) {
      increment(aggregate.status_counts, row?.status);
      if (Array.isArray(row?.quote_attempts)) {
        for (const attempt of row.quote_attempts) if (attempt?.ok === false) increment(aggregate.provider_errors, attempt.error);
      }
      if (!isComplete(row)) continue;
      aggregate.complete_atomic_evaluations += 1;
      const scanner = finite(row.analysis_latency_ms);
      const e2e = finite(row.opportunity_age_ms);
      const edge = finite(row.expected_net_edge_bps);
      if (scanner !== null) aggregate.scanner_latencies_ms.push(scanner);
      if (e2e !== null) aggregate.e2e_ages_ms.push(e2e);
      if (edge !== null) aggregate.net_edges_bps.push(edge);
      if (scanner !== null && scanner <= 300) aggregate.scanner_sla_passed_complete += 1;
      if (e2e !== null && e2e <= 3000) aggregate.e2e_sla_passed_complete += 1;
      if (edge !== null && edge >= 0.5) aggregate.edge_passed += 1;
      if (row.paper_approval_passed === true) {
        aggregate.paper_qualified += 1;
        await settleQualified(row, scanId);
      }
    }
    fs.appendFileSync(scansPath, JSON.stringify({
      scan_number: aggregate.scans_started,
      observed_at: report.observed_at || null,
      duration_ms: Date.now() - scanStarted,
      candidates_discovered: report.candidates_discovered || 0,
      candidates_scanned: report.candidates_scanned || 0,
      status_counts: rows.reduce((acc, row) => {
        increment(acc, row?.status);
        return acc;
      }, {})
    }) + '\n');
    aggregate.last_error = null;
  } catch (error) {
    aggregate.scans_failed += 1;
    aggregate.last_error = String(error?.message || error);
  }
  writeState({ status: 'RUNNING' });
  if (Date.now() < endsAtMs && betweenScansMs > 0) await sleep(Math.min(betweenScansMs, endsAtMs - Date.now()));
}

const db = await pool.query(`
  SELECT
    COUNT(*)::int AS cycles,
    COUNT(*) FILTER (WHERE member_net_profit_usdc > 0)::int AS wins,
    COUNT(*) FILTER (WHERE member_net_profit_usdc < 0)::int AS losses,
    COALESCE(SUM(gross_profit_before_costs_usdc),0) AS gross,
    COALESCE(SUM(market_net_pnl_usdc),0) AS market_net,
    COALESCE(SUM(member_net_profit_usdc),0) AS member_net,
    AVG(net_edge_bps) AS avg_edge
  FROM member_paper_arbitrage_cycles
  WHERE user_id=$1
`, [benchmarkUserId]);
const row = db.rows[0] || {};
aggregate.paper_settled = Number(row.cycles || 0);
aggregate.profitable_settlements = Number(row.wins || 0);
aggregate.losing_settlements = Number(row.losses || 0);
aggregate.gross_profit_before_costs_usdc = Number(row.gross || 0);
aggregate.market_net_pnl_usdc = Number(row.market_net || 0);
aggregate.member_net_profit_usdc = Number(row.member_net || 0);

const final = writeState({
  status: 'COMPLETE',
  completed_at: new Date().toISOString(),
  persisted_avg_net_edge_bps: row.avg_edge === null ? null : Number(row.avg_edge),
  accounting_consistent: aggregate.paper_settled === aggregate.paper_qualified - aggregate.duplicate_settlements_blocked,
  scanner_sla_pass_rate_complete: aggregate.complete_atomic_evaluations
    ? aggregate.scanner_sla_passed_complete / aggregate.complete_atomic_evaluations
    : null,
  e2e_sla_pass_rate_complete: aggregate.complete_atomic_evaluations
    ? aggregate.e2e_sla_passed_complete / aggregate.complete_atomic_evaluations
    : null
});
fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
await pool.end();
console.log(JSON.stringify(final, null, 2));