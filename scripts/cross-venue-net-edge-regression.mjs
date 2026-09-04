import assert from 'node:assert/strict';
import {
  computeExactNetworkFeeBps,
  computeExecutableRoundTripEdgeBps,
  finalizeExpectedNetEdge
} from '../services/api/src/cross-venue-net-edge.mjs';

assert.equal(computeExecutableRoundTripEdgeBps('100000000', '100250000'), 25);
assert.equal(computeExecutableRoundTripEdgeBps('100000000', '99900000'), -10);
assert.equal(computeExactNetworkFeeBps({ exactRoundtripFeeLamports: 10000, solUsd: 200, notionalUsdc: 100 }), 0.2);

const ready = finalizeExpectedNetEdge({
  grossExecutableSpreadBps: 25,
  exactRoundtripFeeLamports: 10000,
  solUsd: 200,
  notionalUsdc: 100
});
assert.equal(ready.net_edge_costs_included, true);
assert.equal(ready.expected_net_edge_bps, 24.8);

const incomplete = finalizeExpectedNetEdge({
  grossExecutableSpreadBps: 25,
  exactRoundtripFeeLamports: null,
  solUsd: null,
  notionalUsdc: 100
});
assert.equal(incomplete.net_edge_costs_included, false);
assert.equal(incomplete.expected_net_edge_bps, null);
assert.equal(incomplete.net_edge_gate_passed, false);

console.log('cross venue net edge regression: PASS');
