import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PROBE_PATH = path.resolve(process.cwd(), 'scripts/vm-cross-venue-net-edge-probe.mjs');
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const PAPER_MIN_EXPECTED_NET_EDGE_BPS = Math.max(0, Math.min(20, Number(process.env.AUTOTRADE_PAPER_MIN_NET_EDGE_BPS || 0.5)));
const ANALYSIS_SLA_MS = 300;
const PAPER_EXECUTION_SLA_MS = 3000;
const PROVIDER_BACKOFF_BASE_MS = Math.max(1000, Math.min(10_000, Number(process.env.AETHER_PROVIDER_BACKOFF_BASE_MS || 2000)));
const PROVIDER_BACKOFF_MAX_MS = Math.max(PROVIDER_BACKOFF_BASE_MS, Math.min(60_000, Number(process.env.AETHER_PROVIDER_BACKOFF_MAX_MS || 30_000)));

let child = null;
let state = idleState();
const streamingPaperEvents = [];

function marketShadowPaperEventKey(scanId, candidate) {
  const identity = [
    String(scanId || ''),
    String(candidate?.observed_at || ''),
    String(candidate?.token_mint || ''),
    String(candidate?.quote_mint || ''),
    String(candidate?.buy_dex || ''),
    String(candidate?.sell_dex || ''),
    String(candidate?.buy_pool_address || ''),
    String(candidate?.sell_pool_address || ''),
    String(candidate?.notional_usdc ?? ''),
    String(candidate?.expected_net_edge_bps ?? '')
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function enqueueMarketShadowPaperEvent({ scanId, candidate, receivedAt = new Date().toISOString() } = {}) {
  if (!scanId || !candidate || typeof candidate !== 'object') throw new Error('market_shadow_paper_event_required');
  const eventKey = marketShadowPaperEventKey(scanId, candidate);
  const existing = streamingPaperEvents.find(item => item.event_key === eventKey);
  if (existing) return Object.freeze({ queued: false, duplicate: true, overflow: false, event_id: existing.event_id });
  if (streamingPaperEvents.length >= 500) {
    runtimeMetrics.paper_queue_overflow_total += 1;
    return Object.freeze({ queued: false, duplicate: false, overflow: true, event_id: null });
  }
  const event = {
    event_id: randomUUID(),
    event_key: eventKey,
    scan_id: String(scanId),
    received_at: String(receivedAt),
    delivery_attempts: 0,
    last_delivery_attempt_at: null,
    candidate: JSON.parse(JSON.stringify(candidate))
  };
  streamingPaperEvents.push(event);
  runtimeMetrics.paper_queue_depth = streamingPaperEvents.length;
  return Object.freeze({ queued: true, duplicate: false, overflow: false, event_id: event.event_id });
}

export function peekMarketShadowPaperEvents(limit = 100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return streamingPaperEvents.slice(0, n).map(item => JSON.parse(JSON.stringify(item)));
}

export function ackMarketShadowPaperEvent(eventId) {
  const id = String(eventId || '').trim();
  if (!id) return false;
  const index = streamingPaperEvents.findIndex(item => item.event_id === id);
  if (index < 0) return false;
  streamingPaperEvents.splice(index, 1);
  runtimeMetrics.paper_queue_depth = streamingPaperEvents.length;
  runtimeMetrics.paper_queue_acked_total += 1;
  return true;
}

export function retryMarketShadowPaperEvent(eventId) {
  const id = String(eventId || '').trim();
  const event = streamingPaperEvents.find(item => item.event_id === id);
  if (!event) return false;
  event.delivery_attempts = Math.max(0, Number(event.delivery_attempts) || 0) + 1;
  event.last_delivery_attempt_at = new Date().toISOString();
  runtimeMetrics.paper_queue_delivery_retries_total += 1;
  return true;
}

export function drainMarketShadowPaperEvents(limit = 100) {
  const rows = peekMarketShadowPaperEvents(limit);
  for (const row of rows) ackMarketShadowPaperEvent(row.event_id);
  return rows;
}
const runtimeMetrics = {
  scans_started: 0,
  scans_completed: 0,
  scans_failed: 0,
  last_scan_duration_ms: null,
  last_terminal_status: null,
  last_terminal_at: null,
  real_market_opportunities: [],
  paper_queue_overflow_total: 0,
  paper_queue_depth: 0,
  paper_queue_acked_total: 0,
  paper_queue_delivery_retries_total: 0,
  provider_rate_limit_events_total: 0,
  provider_cooldown_until_ms: 0,
  provider_backoff_ms: PROVIDER_BACKOFF_BASE_MS,
  last_rpc_provider_path: null,
  last_rpc_primary_health: null
};

function idleState() {
  return {
    status: 'IDLE',
    scan_id: null,
    started_at: null,
    completed_at: null,
    mode: 'SHADOW',
    min_expected_net_edge_bps: PAPER_MIN_EXPECTED_NET_EDGE_BPS,
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
    quote_mint: row?.quote_mint || null,
    buy_pool_address: row?.buy_pool_address || null,
    sell_pool_address: row?.sell_pool_address || null,
    buy_pool_pair_verified: row?.buy_pool_pair_verified === true,
    sell_pool_pair_verified: row?.sell_pool_pair_verified === true,
    notional_usdc: finite(row?.notional_usdc),
    risk_position_pct: finite(row?.risk_position_pct),
    analysis_latency_ms: finite(row?.analysis_latency_ms),
    analysis_sla_passed: row?.analysis_sla_passed === true,
    opportunity_age_ms: finite(row?.opportunity_age_ms),
    gross_profit_before_costs_usdc: finite(row?.gross_profit_before_costs_usdc),
    network_fee_usdc: finite(row?.network_fee_usdc),
    account_setup_usdc: finite(row?.account_setup_usdc),
    market_net_pnl_usdc: finite(row?.market_net_pnl_usdc),
    market_execution_cost_usdc: finite(row?.market_execution_cost_usdc),
    costs_verified: row?.costs_verified === true,
    observed_at: row?.observed_at || null,
    status: row?.status || null,
    buy_dex: row?.buy_dex || null,
    sell_dex: row?.sell_dex || null,
    buy_dex_family: row?.buy_dex_family || null,
    sell_dex_family: row?.sell_dex_family || null,
    gross_executable_spread_bps: finite(row?.gross_executable_spread_bps),
    expected_net_edge_bps: finite(row?.expected_net_edge_bps),
    estimated_price_impact_bps: finite(row?.estimated_price_impact_bps),
    net_edge_gate_passed: row?.net_edge_gate_passed === true,
    exact_roundtrip_fee_lamports: finite(row?.exact_roundtrip_fee_lamports),
    exact_transaction_fee_ready: row?.exact_transaction_fee_ready === true,
    simulation_attempted: row?.simulation_attempted === true,
    roundtrip_simulation_ok: row?.roundtrip_simulation_ok === true,
    atomic_two_leg: row?.atomic_two_leg === true,
    paper_approval_passed: row?.paper_approval_passed === true,
    transaction_built: row?.transaction_built === true,
    mode: row?.mode || 'SHADOW',
    execution_dispatched: row?.execution_dispatched === true,
    transaction_signed: row?.transaction_signed === true,
    network_submission_authorized: row?.network_submission_authorized === true,
    live_execution_authorized: row?.live_execution_authorized === true
  };
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
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
  const qualified = compact.filter(row =>
    row.paper_approval_passed === true &&
    row.analysis_sla_passed === true &&
    Number.isFinite(Number(row.analysis_latency_ms)) && Number(row.analysis_latency_ms) <= ANALYSIS_SLA_MS &&
    Number.isFinite(Number(row.opportunity_age_ms)) && Number(row.opportunity_age_ms) <= PAPER_EXECUTION_SLA_MS &&
    row.net_edge_gate_passed === true &&
    row.buy_pool_address && row.sell_pool_address && row.buy_pool_address !== row.sell_pool_address &&
    row.buy_pool_pair_verified === true && row.sell_pool_pair_verified === true &&
    row.transaction_built === true &&
    row.atomic_two_leg === true &&
    row.costs_verified === true &&
    row.exact_transaction_fee_ready === true &&
    row.roundtrip_simulation_ok === true
  );
  for (const row of compact) {
    const exact = row.expected_net_edge_bps !== null &&
      row.buy_pool_pair_verified === true && row.sell_pool_pair_verified === true &&
      row.transaction_built === true && row.atomic_two_leg === true &&
      row.costs_verified === true && row.exact_transaction_fee_ready === true &&
      row.roundtrip_simulation_ok === true;
    row.paper_expected_net_edge_bps = exact ? row.expected_net_edge_bps : null;
    row.paper_costs_verified = exact;
    row.paper_fee_evidence = exact ? 'EXACT' : 'NONE';
  }
  const measured = compact.filter(row => row.expected_net_edge_bps !== null)
    .sort((a, b) => b.expected_net_edge_bps - a.expected_net_edge_bps);
  const paperFloorBps = PAPER_MIN_EXPECTED_NET_EDGE_BPS;
  const rejection_breakdown = {
    total_rows: compact.length,
    measured: measured.length,
    unmeasured: Math.max(0, compact.length - measured.length),
    below_paper_net_edge: 0,
    cost_verification_failed: 0,
    exact_fee_not_ready: 0,
    simulation_failed_or_unavailable: 0,
    invalid_cross_dex_route: 0,
    invalid_two_pool_route: 0,
    pool_pair_verification_failed: 0,
    scanner_sla_rejected: 0,
    paper_approval_rejected: 0,
    paper_qualified: 0
  };
  for (const row of compact) {
    const crossDexRoute = Boolean(
      row.buy_dex && row.sell_dex &&
      row.buy_dex_family && row.sell_dex_family &&
      row.buy_dex_family !== row.sell_dex_family &&
      row.buy_pool_address && row.sell_pool_address &&
      row.buy_pool_address !== row.sell_pool_address
    );
    if (!crossDexRoute) {
      rejection_breakdown.invalid_two_pool_route += 1;
      rejection_breakdown.invalid_cross_dex_route += 1; // compatibility metric name
    }
    if (row.buy_pool_pair_verified !== true || row.sell_pool_pair_verified !== true) {
      rejection_breakdown.pool_pair_verification_failed += 1;
    }
    if (row.expected_net_edge_bps !== null && row.expected_net_edge_bps < paperFloorBps) rejection_breakdown.below_paper_net_edge += 1;
    if (row.costs_verified !== true) rejection_breakdown.cost_verification_failed += 1;
    if (row.exact_transaction_fee_ready !== true) rejection_breakdown.exact_fee_not_ready += 1;
    if (row.roundtrip_simulation_ok !== true) rejection_breakdown.simulation_failed_or_unavailable += 1;
    if (row.analysis_sla_passed !== true || !Number.isFinite(Number(row.analysis_latency_ms)) || Number(row.analysis_latency_ms) > ANALYSIS_SLA_MS) rejection_breakdown.scanner_sla_rejected += 1;
    if (row.paper_approval_passed !== true) rejection_breakdown.paper_approval_rejected += 1;
    if (
      crossDexRoute &&
      row.paper_approval_passed === true &&
      row.analysis_sla_passed === true &&
      Number.isFinite(Number(row.analysis_latency_ms)) && Number(row.analysis_latency_ms) <= ANALYSIS_SLA_MS &&
      Number.isFinite(Number(row.opportunity_age_ms)) && Number(row.opportunity_age_ms) <= PAPER_EXECUTION_SLA_MS &&
      row.expected_net_edge_bps !== null &&
      row.expected_net_edge_bps >= paperFloorBps &&
      row.buy_pool_pair_verified === true && row.sell_pool_pair_verified === true &&
      row.transaction_built === true &&
      row.atomic_two_leg === true &&
      row.costs_verified === true &&
      row.exact_transaction_fee_ready === true &&
      row.roundtrip_simulation_ok === true
    ) rejection_breakdown.paper_qualified += 1;
  }
  const funnel = Object.freeze({
    discovered: Number(result?.candidates_discovered || 0),
    scanned: Number(result?.candidates_scanned || 0),
    distinct_two_pool_route: compact.filter(row =>
      row.buy_dex && row.sell_dex &&
      row.buy_pool_address && row.sell_pool_address &&
      row.buy_pool_address !== row.sell_pool_address
    ).length,
    executable_edge_measured: measured.length,
    transaction_built: compact.filter(row => row.transaction_built === true).length,
    simulation_passed: compact.filter(row => row.roundtrip_simulation_ok === true).length,
    exact_fee_ready: compact.filter(row => row.exact_transaction_fee_ready === true).length,
    costs_verified: compact.filter(row => row.costs_verified === true).length,
    paper_qualified: rejection_breakdown.paper_qualified,
    provider_rate_limited: rows.filter(row =>
      /rate.?limit|too many requests|429/i.test(String(row?.status || '') + ' ' + String(row?.error || '') + ' ' + String(row?.broad_quote_error || ''))
    ).length
  });
  return {
    probe: result?.probe || 'AETHER_CROSS_VENUE_NET_EDGE_SHADOW',
    observed_at: result?.observed_at || null,
    discovery_views: Array.isArray(result?.discovery_views) ? result.discovery_views : [],
    candidates_discovered: Number(result?.candidates_discovered || 0),
    candidates_scanned: Number(result?.candidates_scanned || 0),
    funnel,
    rpc_provider_path: result?.rpc_provider_path || null,
    rpc_primary_health: result?.rpc_primary_health || null,
    provider_capacity_blocked: result?.provider_capacity_blocked === true,
    min_expected_net_edge_bps: Math.max(0, Number(result?.min_expected_net_edge_bps ?? PAPER_MIN_EXPECTED_NET_EDGE_BPS)),
    paper_min_expected_net_edge_bps: paperFloorBps,
    paper_qualified_count: rejection_breakdown.paper_qualified,
    rejection_breakdown,
    status_counts,
    qualified_count: qualified.length,
    qualified: qualified.slice(0, 10),
    measured: measured.slice(0, 20),
    best_expected_net_edge_bps: measured[0]?.expected_net_edge_bps ?? null
  };
}

function elapsedMs(startedAt, endedAt = new Date().toISOString()) {
  const start = Date.parse(String(startedAt || ''));
  const end = Date.parse(String(endedAt || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, end - start);
}

function appendRealMarketOpportunities(scanId, completedAt, durationMs, summary) {
  const measured = Array.isArray(summary?.measured) ? summary.measured : [];
  const paperFloorBps = Number(summary?.paper_min_expected_net_edge_bps ?? PAPER_MIN_EXPECTED_NET_EDGE_BPS);
  for (const row of measured) {
    const crossDexRoute = Boolean(
      row?.buy_dex && row?.sell_dex &&
      row?.buy_dex_family && row?.sell_dex_family &&
      row.buy_dex_family !== row.sell_dex_family &&
      row?.buy_pool_address && row?.sell_pool_address &&
      row.buy_pool_address !== row.sell_pool_address
    );
    const paperEdge = finite(row?.paper_expected_net_edge_bps);
    const fallbackEdge = finite(row?.expected_net_edge_bps);
    const effectiveEdge = paperEdge !== null ? paperEdge : fallbackEdge;
    const paperReady = Boolean(
      crossDexRoute &&
      row?.buy_pool_pair_verified === true &&
      row?.sell_pool_pair_verified === true &&
      row?.paper_approval_passed === true &&
      row?.analysis_sla_passed === true &&
      Number.isFinite(Number(row?.analysis_latency_ms)) && Number(row.analysis_latency_ms) <= ANALYSIS_SLA_MS &&
      Number.isFinite(Number(row?.opportunity_age_ms)) && Number(row.opportunity_age_ms) <= PAPER_EXECUTION_SLA_MS &&
      row?.transaction_built === true &&
      row?.atomic_two_leg === true &&
      row?.paper_costs_verified === true &&
      row?.roundtrip_simulation_ok === true &&
      Number.isFinite(effectiveEdge) && effectiveEdge >= paperFloorBps
    );
    runtimeMetrics.real_market_opportunities.unshift({
      scan_id: scanId,
      observed_at: row?.observed_at || completedAt,
      scan_completed_at: completedAt,
      scan_duration_ms: durationMs,
      symbol: row?.symbol || null,
      token_mint: row?.token_mint || null,
      quote_mint: row?.quote_mint || null,
      buy_dex: row?.buy_dex || null,
      sell_dex: row?.sell_dex || null,
      buy_dex_family: row?.buy_dex_family || null,
      sell_dex_family: row?.sell_dex_family || null,
      buy_pool_address: row?.buy_pool_address || null,
      sell_pool_address: row?.sell_pool_address || null,
      buy_pool_pair_verified: row?.buy_pool_pair_verified === true,
      sell_pool_pair_verified: row?.sell_pool_pair_verified === true,
      notional_usdc: row?.notional_usdc ?? null,
      gross_executable_spread_bps: row?.gross_executable_spread_bps ?? null,
      expected_net_edge_bps: row?.expected_net_edge_bps ?? null,
      paper_expected_net_edge_bps: row?.paper_expected_net_edge_bps ?? null,
      estimated_price_impact_bps: row?.estimated_price_impact_bps ?? null,
      network_fee_usdc: row?.network_fee_usdc ?? null,
      account_setup_usdc: row?.account_setup_usdc ?? null,
      roundtrip_simulation_ok: row?.roundtrip_simulation_ok === true,
      market_execution_cost_usdc: row?.market_execution_cost_usdc ?? null,
      paper_fee_evidence: row?.paper_fee_evidence || 'NONE',
      paper_qualified: paperReady,
      dry_order_status: paperReady ? 'DRY_QUALIFIED' : 'DRY_REJECTED',
      market_source: 'REAL_MARKET_SHADOW_NET_EDGE_PROBE',
      mode: 'SHADOW',
      execution_dispatched: false,
      transaction_signed: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }
  runtimeMetrics.real_market_opportunities = runtimeMetrics.real_market_opportunities.slice(0, 500);
}

function observabilitySnapshot() {
  return {
    runtime_session: true,
    scan_target_ms: 30_000,
    scans_started: runtimeMetrics.scans_started,
    scans_completed: runtimeMetrics.scans_completed,
    scans_failed: runtimeMetrics.scans_failed,
    current_scan_duration_ms: state.status === 'RUNNING' ? elapsedMs(state.started_at) : null,
    last_scan_duration_ms: runtimeMetrics.last_scan_duration_ms,
    last_terminal_status: runtimeMetrics.last_terminal_status,
    last_terminal_at: runtimeMetrics.last_terminal_at,
    real_market_opportunity_count: runtimeMetrics.real_market_opportunities.length,
    paper_queue_depth: runtimeMetrics.paper_queue_depth,
    paper_queue_capacity: 500,
    paper_queue_overflow_total: runtimeMetrics.paper_queue_overflow_total,
    paper_queue_acked_total: runtimeMetrics.paper_queue_acked_total,
    paper_queue_delivery_retries_total: runtimeMetrics.paper_queue_delivery_retries_total,
    paper_queue_fail_closed: true,
    provider_rate_limit_events_total: runtimeMetrics.provider_rate_limit_events_total,
    provider_cooldown_active: runtimeMetrics.provider_cooldown_until_ms > Date.now(),
    provider_cooldown_remaining_ms: Math.max(0, runtimeMetrics.provider_cooldown_until_ms - Date.now()),
    provider_backoff_ms: runtimeMetrics.provider_backoff_ms,
    last_rpc_provider_path: runtimeMetrics.last_rpc_provider_path,
    last_rpc_primary_health: runtimeMetrics.last_rpc_primary_health,
    mode: 'SHADOW',
    min_expected_net_edge_bps: PAPER_MIN_EXPECTED_NET_EDGE_BPS,
    live_execution_authorized: false
  };
}

function snapshot() {
  return {
    ...JSON.parse(JSON.stringify(state)),
    observability: observabilitySnapshot(),
    real_market_feed: JSON.parse(JSON.stringify(runtimeMetrics.real_market_opportunities))
  };
}

function finishError(scanId, error) {
  if (state.scan_id !== scanId || state.status === 'ERROR' || state.status === 'COMPLETE') return;
  const completedAt = new Date().toISOString();
  const durationMs = elapsedMs(state.started_at, completedAt);
  runtimeMetrics.scans_failed += 1;
  runtimeMetrics.last_scan_duration_ms = durationMs;
  runtimeMetrics.last_terminal_status = 'ERROR';
  runtimeMetrics.last_terminal_at = completedAt;
  state = {
    ...state,
    status: 'ERROR',
    completed_at: completedAt,
    duration_ms: durationMs,
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

export function startMarketShadowRuntimeScan({ quoteUsdcRaw } = {}) {
  if (child) return snapshot();
  // The scheduler may tick every ~800 ms, but a provider 429 is an explicit
  // capacity signal. Preserve the fast cadence when healthy; during a cooldown
  // skip spawning another probe instead of turning provider saturation into
  // thousands of false market rejections.
  if (runtimeMetrics.provider_cooldown_until_ms > Date.now()) return snapshot();

  const scanId = randomUUID();
  runtimeMetrics.scans_started += 1;
  state = {
    status: 'RUNNING',
    scan_id: scanId,
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
    mode: 'SHADOW',
    min_expected_net_edge_bps: PAPER_MIN_EXPECTED_NET_EDGE_BPS,
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
    SIGNAL_MIN_EXPECTED_NET_EDGE_BPS: String(PAPER_MIN_EXPECTED_NET_EDGE_BPS),
    AETHER_ANALYSIS_SLA_MS: String(ANALYSIS_SLA_MS),
    AETHER_MAX_OPPORTUNITY_AGE_MS: String(PAPER_EXECUTION_SLA_MS),
    AETHER_PAPER_EXECUTION_SLA_MS: String(PAPER_EXECUTION_SLA_MS),
    SIGNAL_MIN_LIQUIDITY_USD: String(process.env.AUTOTRADE_PAPER_MIN_LIQUIDITY_USD || process.env.SIGNAL_MIN_LIQUIDITY_USD || '2000'),
    SIGNAL_MIN_VOLUME_24H_USD: String(process.env.AUTOTRADE_PAPER_MIN_VOLUME_24H_USD || process.env.SIGNAL_MIN_VOLUME_24H_USD || '2000'),
    SIGNAL_MAX_TOP10_HOLDER_PCT: String(process.env.AUTOTRADE_PAPER_MAX_TOP10_HOLDER_PCT || process.env.SIGNAL_MAX_TOP10_HOLDER_PCT || '100'),
    SIGNAL_MAX_PRICE_IMPACT_BPS: String(process.env.AUTOTRADE_PAPER_MAX_PRICE_IMPACT_BPS || '1000'),
    AETHER_JUPITER_QUOTE_USDC_RAW: String(quoteUsdcRaw || process.env.AUTOTRADE_PAPER_QUOTE_USDC_RAW || '10000000'),
    AETHER_JUPITER_UNIVERSE_ENABLED: 'true',
    AETHER_JUPITER_UNIVERSE_LIMIT: String(process.env.AUTOTRADE_PAPER_JUPITER_UNIVERSE_LIMIT || '8'),
    AETHER_MARKET_VIEWS: String(process.env.AETHER_MARKET_VIEWS || 'trending,gainers,volume,new'),
    // Each spawned probe is short-lived. Pass a monotonic scan sequence so
    // native pool-pair/quote-asset coverage rotates across cycles instead of
    // re-testing the same top-ranked pair forever.
    AETHER_SCAN_SEQUENCE: String(runtimeMetrics.scans_started),
    // Default 0 removes the token-count cap. Candidate approval remains post-cost NET edge.
    AETHER_CROSS_VENUE_CANDIDATE_LIMIT: String(process.env.AUTOTRADE_PAPER_CANDIDATE_LIMIT ?? '0'),
    AETHER_CROSS_VENUE_DEX_PAIR_ATTEMPTS: String(process.env.AUTOTRADE_PAPER_DEX_PAIR_ATTEMPTS || '12'),
    // Jupiter is fallback/enrichment only. A zero delay caused bursty 429s and
    // made broad-provider availability look like a market rejection.
    AETHER_JUPITER_INTER_QUOTE_DELAY_MS: String(Math.max(
      50,
      Number(process.env.AETHER_JUPITER_INTER_QUOTE_DELAY_MS || 80) || 80
    )),
    AETHER_JUPITER_PREFER_PUBLIC: String(process.env.AETHER_JUPITER_PREFER_PUBLIC || 'true')
  };

  let stdout = '';
  let stderr = '';
  let eventBuffer = '';
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
    const text = chunk.toString('utf8');
    stderr = (stderr + text).slice(-MAX_STDERR_BYTES);
    eventBuffer += text;
    const lines = eventBuffer.split('\n');
    eventBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('AETHER_EVENT ')) continue;
      try {
        const row = JSON.parse(line.slice('AETHER_EVENT '.length));
        const compact = compactResult(row);
        const exactEdge = finite(compact.expected_net_edge_bps);
        const effectiveEdge = exactEdge;
        const paperCostsVerified = exactEdge !== null && compact.atomic_two_leg === true && compact.costs_verified === true && compact.exact_transaction_fee_ready === true && compact.roundtrip_simulation_ok === true;
        const paperReady = Boolean(
          compact.buy_dex && compact.sell_dex &&
          compact.buy_dex_family && compact.sell_dex_family &&
          compact.buy_dex_family !== compact.sell_dex_family &&
          compact.buy_pool_address && compact.sell_pool_address &&
          compact.buy_pool_address !== compact.sell_pool_address &&
          compact.buy_pool_pair_verified === true &&
          compact.sell_pool_pair_verified === true &&
          compact.paper_approval_passed === true &&
          compact.analysis_sla_passed === true &&
          Number.isFinite(Number(compact.analysis_latency_ms)) && Number(compact.analysis_latency_ms) <= ANALYSIS_SLA_MS &&
          Number.isFinite(Number(compact.opportunity_age_ms)) && Number(compact.opportunity_age_ms) <= PAPER_EXECUTION_SLA_MS &&
          compact.transaction_built === true &&
          compact.atomic_two_leg === true &&
          compact.roundtrip_simulation_ok === true &&
          paperCostsVerified &&
          effectiveEdge !== null && effectiveEdge >= PAPER_MIN_EXPECTED_NET_EDGE_BPS
        );
        runtimeMetrics.real_market_opportunities.unshift({
          scan_id: scanId,
          observed_at: compact.observed_at || new Date().toISOString(),
          scan_completed_at: null,
          scan_duration_ms: elapsedMs(state.started_at),
          ...compact,
          paper_expected_net_edge_bps: effectiveEdge,
          paper_qualified: paperReady,
          dry_order_status: paperReady ? 'DRY_QUALIFIED' : 'DRY_REJECTED',
          market_source: 'REAL_MARKET_SHADOW_NET_EDGE_PROBE',
          mode: 'SHADOW',
          execution_dispatched: false,
          transaction_signed: false,
          network_submission_authorized: false,
          live_execution_authorized: false
        });
        runtimeMetrics.real_market_opportunities = runtimeMetrics.real_market_opportunities.slice(0, 500);
        if (paperReady && compact.costs_verified === true && compact.exact_transaction_fee_ready === true && compact.roundtrip_simulation_ok === true && compact.transaction_built === true && Number.isFinite(Number(compact.opportunity_age_ms)) && Number(compact.opportunity_age_ms) >= 0 && Number(compact.opportunity_age_ms) <= PAPER_EXECUTION_SLA_MS && compact.buy_dex && compact.sell_dex && compact.buy_dex_family && compact.sell_dex_family && compact.buy_dex_family !== compact.sell_dex_family && compact.buy_pool_address && compact.sell_pool_address && compact.buy_pool_address !== compact.sell_pool_address && compact.transaction_built === true && Number.isFinite(Number(compact.gross_executable_spread_bps)) && Number.isFinite(Number(compact.notional_usdc))) {
          const queued = enqueueMarketShadowPaperEvent({
            scanId,
            receivedAt: new Date().toISOString(),
            candidate: compact
          });
          if (queued.overflow) {
            finishError(scanId, new Error('market_shadow_paper_queue_overflow_fail_closed'));
            runningChild.kill('SIGTERM');
          }
        }
      } catch {}
    }
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
      const completedAt = new Date().toISOString();
      const durationMs = elapsedMs(state.started_at, completedAt);
      runtimeMetrics.scans_completed += 1;
      runtimeMetrics.last_scan_duration_ms = durationMs;
      runtimeMetrics.last_terminal_status = 'COMPLETE';
      runtimeMetrics.last_terminal_at = completedAt;
      const summary = summarize(result);
      runtimeMetrics.last_rpc_provider_path = summary.rpc_provider_path;
      runtimeMetrics.last_rpc_primary_health = summary.rpc_primary_health;
      const providerRateLimited = summary.provider_capacity_blocked === true ||
        summary.rpc_primary_health === 'RATE_LIMITED' ||
        Number(summary.funnel?.provider_rate_limited || 0) > 0;
      if (providerRateLimited) {
        runtimeMetrics.provider_rate_limit_events_total += 1;
        runtimeMetrics.provider_cooldown_until_ms = Date.now() + runtimeMetrics.provider_backoff_ms;
        runtimeMetrics.provider_backoff_ms = Math.min(
          PROVIDER_BACKOFF_MAX_MS,
          Math.max(PROVIDER_BACKOFF_BASE_MS, runtimeMetrics.provider_backoff_ms * 2)
        );
      } else {
        runtimeMetrics.provider_cooldown_until_ms = 0;
        runtimeMetrics.provider_backoff_ms = PROVIDER_BACKOFF_BASE_MS;
      }
      appendRealMarketOpportunities(scanId, completedAt, durationMs, summary);
      state = {
        ...state,
        status: 'COMPLETE',
        completed_at: completedAt,
        duration_ms: durationMs,
        summary,
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