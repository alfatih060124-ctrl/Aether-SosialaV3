import assert from 'node:assert/strict';
import {
  ackMarketShadowPaperEvent,
  enqueueMarketShadowPaperEvent,
  getMarketShadowRuntimeState,
  peekMarketShadowPaperEvents,
  retryMarketShadowPaperEvent
} from '../services/api/src/market-shadow-runtime.mjs';

const candidate = Object.freeze({
  observed_at: '2026-09-19T08:00:00.000Z',
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  buy_pool_address: 'BUY_POOL',
  sell_pool_address: 'SELL_POOL',
  buy_pool_pair_verified: true,
  sell_pool_pair_verified: true,
  notional_usdc: 5,
  gross_executable_spread_bps: 12,
  expected_net_edge_bps: 5,
  exact_roundtrip_fee_lamports: 5000,
  analysis_latency_ms: 120,
  analysis_sla_passed: true,
  opportunity_age_ms: 450,
  transaction_built: true,
  atomic_two_leg: true,
  exact_transaction_fee_ready: true,
  costs_verified: true,
  roundtrip_simulation_ok: true,
  paper_approval_passed: true,
  mode: 'SHADOW',
  execution_dispatched: false,
  transaction_signed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

assert.equal(getMarketShadowRuntimeState().observability.paper_queue_depth, 0);

const first = enqueueMarketShadowPaperEvent({
  scanId: 'scan-queue-1',
  receivedAt: '2026-09-19T08:00:00.100Z',
  candidate
});
assert.equal(first.queued, true);
assert.equal(first.duplicate, false);
assert.ok(first.event_id);

const duplicate = enqueueMarketShadowPaperEvent({
  scanId: 'scan-queue-1',
  receivedAt: '2026-09-19T08:00:00.200Z',
  candidate: { ...candidate }
});
assert.equal(duplicate.queued, false);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.event_id, first.event_id);

let queued = peekMarketShadowPaperEvents(10);
assert.equal(queued.length, 1);
assert.equal(queued[0].event_id, first.event_id);
assert.equal(queued[0].delivery_attempts, 0);

assert.equal(retryMarketShadowPaperEvent(first.event_id), true);
queued = peekMarketShadowPaperEvents(10);
assert.equal(queued[0].delivery_attempts, 1);
assert.ok(queued[0].last_delivery_attempt_at);

let metrics = getMarketShadowRuntimeState().observability;
assert.equal(metrics.paper_queue_depth, 1);
assert.equal(metrics.paper_queue_delivery_retries_total, 1);
assert.equal(metrics.paper_queue_fail_closed, true);

assert.equal(ackMarketShadowPaperEvent(first.event_id), true);
assert.equal(ackMarketShadowPaperEvent(first.event_id), false);
metrics = getMarketShadowRuntimeState().observability;
assert.equal(metrics.paper_queue_depth, 0);
assert.equal(metrics.paper_queue_acked_total, 1);

const secondScan = enqueueMarketShadowPaperEvent({
  scanId: 'scan-queue-2',
  receivedAt: '2026-09-19T08:01:00.000Z',
  candidate
});
assert.equal(secondScan.queued, true);
assert.notEqual(secondScan.event_id, first.event_id);
assert.equal(ackMarketShadowPaperEvent(secondScan.event_id), true);
assert.equal(getMarketShadowRuntimeState().observability.paper_queue_depth, 0);

const capacityIds = [];
for (let index = 0; index < 500; index += 1) {
  const queuedAtCapacity = enqueueMarketShadowPaperEvent({
    scanId: 'scan-capacity',
    receivedAt: '2026-09-19T08:02:00.000Z',
    candidate: { ...candidate, observed_at: `2026-09-19T08:02:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z` }
  });
  assert.equal(queuedAtCapacity.queued, true);
  capacityIds.push(queuedAtCapacity.event_id);
}
const overflow = enqueueMarketShadowPaperEvent({
  scanId: 'scan-capacity',
  receivedAt: '2026-09-19T08:03:00.000Z',
  candidate: { ...candidate, observed_at: '2026-09-19T08:03:00.000Z' }
});
assert.equal(overflow.queued, false);
assert.equal(overflow.overflow, true);
metrics = getMarketShadowRuntimeState().observability;
assert.equal(metrics.paper_queue_depth, 500);
assert.equal(metrics.paper_queue_capacity, 500);
assert.equal(metrics.paper_queue_overflow_total, 1);
assert.equal(metrics.paper_queue_fail_closed, true);

for (const eventId of capacityIds) assert.equal(ackMarketShadowPaperEvent(eventId), true);
assert.equal(getMarketShadowRuntimeState().observability.paper_queue_depth, 0);

console.log('step8 PAPER queue reliability regression: PASS');