import { createHash } from 'node:crypto';

const SCHEMA = 'aether.evidence_window_coverage.v1';
const ALLOWED_SOURCES = new Set(['SOLANA_RPC', 'SOLSCAN', 'INTERNAL_RECONCILIATION']);
const TERMINAL_REASONS = new Set(['WINDOW_REACHED', 'SOURCE_EXHAUSTED']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonicalIso(value, field) {
  if (typeof value !== 'string' || value.trim() !== value) fail(`invalid_${field}`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(`invalid_${field}`);
  return { value, ms };
}

function canonicalBlockTime(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid_${field}`);
  return value;
}

function canonicalSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('invalid_source_coverage');
  const sourceType = source.source_type;
  if (!ALLOWED_SOURCES.has(sourceType)) fail('unsupported_source_type');
  if (source.complete !== true) fail('source_coverage_incomplete');
  if (!TERMINAL_REASONS.has(source.terminal_reason)) fail('invalid_terminal_reason');

  const earliest = canonicalBlockTime(source.earliest_block_time, 'earliest_block_time');
  const latest = canonicalBlockTime(source.latest_block_time, 'latest_block_time');
  if (earliest > latest) fail('source_block_time_order_invalid');

  return {
    source_type: sourceType,
    earliest_block_time: earliest,
    latest_block_time: latest,
    complete: true,
    terminal_reason: source.terminal_reason,
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

export function buildEvidenceWindowCoverage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_coverage_input');
  const start = canonicalIso(input.window_start_at, 'window_start_at');
  const end = canonicalIso(input.window_end_at, 'window_end_at');
  const observed = canonicalIso(input.observed_at, 'observed_at');

  if (start.ms >= end.ms) fail('invalid_evidence_window');
  if (observed.ms < end.ms) fail('coverage_observed_before_window_end');

  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 3) {
    fail('invalid_source_coverage_count');
  }

  const sources = input.sources.map(canonicalSource).sort((a, b) => a.source_type.localeCompare(b.source_type));
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1].source_type === sources[index].source_type) fail('duplicate_source_coverage');
  }

  const windowStartSec = Math.floor(start.ms / 1000);
  const windowEndSec = Math.ceil(end.ms / 1000);
  for (const source of sources) {
    if (source.earliest_block_time > windowStartSec) fail('source_does_not_cover_window_start');
    if (source.latest_block_time < windowEndSec) fail('source_does_not_cover_window_end');
  }

  const canonical = {
    schema: SCHEMA,
    window_start_at: start.value,
    window_end_at: end.value,
    observed_at: observed.value,
    sources,
  };
  const coverageHash = createHash('sha256').update(stableJson(canonical)).digest('hex');

  return Object.freeze({
    ...canonical,
    coverage_hash: coverageHash,
    collection_status: 'PENDING_DATA',
    metrics_available: false,
    trades_count: null,
    total_return_bps: null,
    win_rate_bps: null,
    drawdown_bps: null,
    reputation_score: null,
    verified: false,
    published: false,
    live_execution_authorized: false,
  });
}

export function verifyEvidenceWindowCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return false;
  if (coverage.schema !== SCHEMA) return false;
  if (!/^[0-9a-f]{64}$/.test(coverage.coverage_hash ?? '')) return false;
  if (coverage.collection_status !== 'PENDING_DATA' || coverage.metrics_available !== false) return false;
  if (coverage.trades_count !== null || coverage.total_return_bps !== null || coverage.win_rate_bps !== null || coverage.drawdown_bps !== null || coverage.reputation_score !== null) return false;
  if (coverage.verified !== false || coverage.published !== false || coverage.live_execution_authorized !== false) return false;

  try {
    const rebuilt = buildEvidenceWindowCoverage({
      window_start_at: coverage.window_start_at,
      window_end_at: coverage.window_end_at,
      observed_at: coverage.observed_at,
      sources: coverage.sources,
    });
    return rebuilt.coverage_hash === coverage.coverage_hash;
  } catch {
    return false;
  }
}
