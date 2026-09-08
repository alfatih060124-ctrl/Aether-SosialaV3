import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PROBE_PATH = path.resolve(process.cwd(), 'scripts/vm-cross-venue-net-edge-probe.mjs');
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

let child = null;
let state = idleState();

function idleState() {
  return {
    status: 'IDLE',
    scan_id: null,
    started_at: null,
    completed_at: null,
    mode: 'SHADOW',
    min_expected_net_edge_bps: 20,
    execution_dispatched: false,
    transaction_signed: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    summary: null,
    error: null
  };
}

function compactResult(row) {
  return {
    symbol: row?.symbol || null,
    token_mint: row?.token_mint || null,
    status: row?.status || null,
    buy_dex: row?.buy_dex || null,
    sell_dex: row?.sell_dex || null,
    gross_executable_spread_bps: finite(row?.gross_executable_spread_bps),
    expected_net_edge_bps: finite(row?.expected_net_edge_bps),
    estimated_price_impact_bps: finite(row?.estimated_price_impact_bps),
    net_edge_gate_passed: row?.net_edge_gate_passed === true
  };
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function assertShadowInvariant(result) {
  if (
    result?.mode !== 'SHADOW' ||
    result?.execution_ready !== false ||
    result?.execution_dispatched !== false ||
    result?.transaction_signed !== false ||
    result?.signer_requested !== false ||
    result?.network_submission_authorized !== false ||
    result?.live_execution_authorized !== false
  ) throw new Error('market_shadow_invariant_failed');
}

function summarize(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const status_counts = {};
  for (const row of rows) {
    const key = String(row?.status || 'UNKNOWN');
    status_counts[key] = (status_counts[key] || 0) + 1;
  }
  const compact = rows.map(compactResult);
  const qualified = compact.filter(row => row.net_edge_gate_passed === true);
  const measured = compact.filter(row => row.expected_net_edge_bps !== null)
    .sort((a, b) => b.expected_net_edge_bps - a.expected_net_edge_bps);
  return {
    probe: result?.probe || 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
    observed_at: result?.observed_at || null,
    discovery_views: Array.isArray(result?.discovery_views) ? result.discovery_views : [],
    candidates_discovered: Number(result?.candidates_discovered || 0),
    candidates_scanned: Number(result?.candidates_scanned || 0),
    min_expected_net_edge_bps: Math.max(20, Number(result?.min_expected_net_edge_bps || 20)),
    status_counts,
    qualified_count: qualified.length,
    qualified: qualified.slice(0, 10),
    measured: measured.slice(0, 20),
    best_expected_net_edge_bps: measured[0]?.expected_net_edge_bps ?? null
  };
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function finishError(scanId, error) {
  if (state.scan_id !== scanId) return;
  state = {
    ...state,
    status: 'ERROR',
    completed_at: new Date().toISOString(),
    summary: null,
    error: String(error?.message || error || 'market_shadow_scan_failed'),
    execution_dispatched: false,
    transaction_signed: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  };
}

export function getMarketShadowRuntimeState() {
  return snapshot();
}

export function startMarketShadowRuntimeScan() {
  if (child) return snapshot();

  const scanId = randomUUID();
  state = {
    status: 'RUNNING',
    scan_id: scanId,
    started_at: new Date().toISOString(),
    completed_at: null,
    mode: 'SHADOW',
    min_expected_net_edge_bps: 20,
    execution_dispatched: false,
    transaction_signed: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    summary: null,
    error: null
  };

  const env = {
    ...process.env,
    EXECUTION_MODE: 'SHADOW',
    LIVE_ENABLED: 'false',
    SIGNAL_MIN_EXPECTED_NET_EDGE_BPS: '20',
    AETHER_MARKET_VIEWS: 'trending,new,gainers,volume',
    AETHER_CROSS_VENUE_CANDIDATE_LIMIT: '60',
    AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS: '12',
    AETHER_JUPITER_INTER_QUOTE_DELAY_MS: String(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || '400')
  };

  let stdout = '';
  let stderr = '';
  let overflow = false;
  child = spawn(process.execPath, [PROBE_PATH], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const runningChild = child;

  const timeout = setTimeout(() => {
    finishError(scanId, new Error('market_shadow_scan_timeout'));
    runningChild.kill('SIGTERM');
  }, SCAN_TIMEOUT_MS);

  runningChild.stdout.on('data', chunk => {
    if (overflow) return;
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
      overflow = true;
      finishError(scanId, new Error('market_shadow_scan_output_too_large'));
      runningChild.kill('SIGTERM');
    }
  });
  runningChild.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
  });
  runningChild.on('error', error => finishError(scanId, error));
  runningChild.on('close', code => {
    clearTimeout(timeout);
    if (child === runningChild) child = null;
    if (state.scan_id !== scanId || state.status === 'ERROR') return;
    try {
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start < 0 || end < start) throw new Error('market_shadow_invalid_probe_output');
      const result = JSON.parse(stdout.slice(start, end + 1));
      assertShadowInvariant(result);
      if (code !== 0 || result.status !== 'ok') throw new Error(result?.error || `market_shadow_probe_exit_${code}`);
      state = {
        ...state,
        status: 'COMPLETE',
        completed_at: new Date().toISOString(),
        summary: summarize(result),
        error: null,
        execution_dispatched: false,
        transaction_signed: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      };
    } catch (error) {
      const suffix = stderr ? `:${stderr.slice(-500)}` : '';
      finishError(scanId, new Error(`${String(error?.message || error)}${suffix}`));
    }
  });

  return snapshot();
}
