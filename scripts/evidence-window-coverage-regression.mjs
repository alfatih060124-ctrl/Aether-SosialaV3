import assert from 'node:assert/strict';
import { buildEvidenceWindowCoverage, verifyEvidenceWindowCoverage } from '../services/api/src/evidence-window-coverage.mjs';

// SYNTHETIC / TEST-ONLY fixture. No production signature, tx hash, source reference, or trader metric.
const fixture = {
  window_start_at: '2026-09-01T00:00:00.000Z',
  window_end_at: '2026-09-01T01:00:00.000Z',
  observed_at: '2026-09-01T01:00:05.000Z',
  sources: [
    {
      source_type: 'SOLANA_RPC',
      earliest_block_time: 1788220800,
      latest_block_time: 1788224400,
      complete: true,
      terminal_reason: 'WINDOW_REACHED',
    },
    {
      source_type: 'INTERNAL_RECONCILIATION',
      earliest_block_time: 1788220700,
      latest_block_time: 1788224500,
      complete: true,
      terminal_reason: 'SOURCE_EXHAUSTED',
    },
  ],
};

const first = buildEvidenceWindowCoverage(fixture);
const second = buildEvidenceWindowCoverage({ ...fixture, sources: [...fixture.sources].reverse() });
assert.equal(first.coverage_hash, second.coverage_hash, 'source ordering must not affect deterministic hash');
assert.equal(verifyEvidenceWindowCoverage(first), true);
assert.equal(first.collection_status, 'PENDING_DATA');
assert.equal(first.metrics_available, false);
assert.equal(first.trades_count, null);
assert.equal(first.total_return_bps, null);
assert.equal(first.win_rate_bps, null);
assert.equal(first.drawdown_bps, null);
assert.equal(first.reputation_score, null);
assert.equal(first.verified, false);
assert.equal(first.published, false);
assert.equal(first.live_execution_authorized, false);

for (const [name, mutate] of [
  ['incomplete source', (x) => { x.sources[0].complete = false; }],
  ['missing window start', (x) => { x.sources[0].earliest_block_time = 1788220801; }],
  ['missing window end', (x) => { x.sources[0].latest_block_time = 1788224399; }],
  ['observation before end', (x) => { x.observed_at = '2026-09-01T00:59:59.000Z'; }],
  ['duplicate source', (x) => { x.sources[1].source_type = 'SOLANA_RPC'; }],
  ['unsafe block time', (x) => { x.sources[0].latest_block_time = Number.MAX_SAFE_INTEGER + 1; }],
]) {
  const candidate = structuredClone(fixture);
  mutate(candidate);
  assert.throws(() => buildEvidenceWindowCoverage(candidate), undefined, name);
}

const subsecondEnd = structuredClone(fixture);
subsecondEnd.window_end_at = '2026-09-01T01:00:00.999Z';
subsecondEnd.observed_at = '2026-09-01T01:00:05.000Z';
assert.throws(
  () => buildEvidenceWindowCoverage(subsecondEnd),
  /source_does_not_cover_window_end/,
  'second-resolution source evidence must cover the full subsecond end instant',
);
subsecondEnd.sources[0].latest_block_time = 1788224401;
assert.equal(verifyEvidenceWindowCoverage(buildEvidenceWindowCoverage(subsecondEnd)), true);

const tampered = structuredClone(first);
tampered.sources[0].latest_block_time += 1;
assert.equal(verifyEvidenceWindowCoverage(tampered), false, 'tampered coverage must fail verification');

console.log('Evidence Window Coverage Regression: PASS');
