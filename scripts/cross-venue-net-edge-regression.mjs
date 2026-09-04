import assert from 'node:assert/strict';
import {
  computeExactNetworkFeeBps,
  computeExecutableRoundTripEdgeBps,
  finalizeExpectedNetEdge,
  rankCrossVenueReportPairs
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

const ranked = rankCrossVenueReportPairs({
  buy: {
    in_amount: '100',
    provider_quote_response: {
      routePlan: [{ swapInfo: { ammKey: 'BUY_ROUTE_AMM' } }],
      mostReliableAmmsQuoteReport: {
        info: {
          BUY_ROUTE_AMM: '120',
          BUY_HIGH_SPREAD_AMM: '130'
        }
      }
    }
  },
  sell: {
    in_amount: '100',
    provider_quote_response: {
      routePlan: [{ swapInfo: { ammKey: 'SELL_ROUTE_AMM' } }],
      mostReliableAmmsQuoteReport: {
        info: {
          SELL_ROUTE_AMM: '90',
          SELL_HIGH_SPREAD_AMM: '95'
        }
      }
    }
  }
});
assert.equal(ranked[0].buy_amm_address, 'BUY_ROUTE_AMM');
assert.equal(ranked[0].sell_amm_address, 'SELL_ROUTE_AMM');
assert.equal(ranked[0].routability_score, 2);
assert.equal(ranked[0].buy_route_observed, true);
assert.equal(ranked[0].sell_route_observed, true);

console.log('cross venue net edge regression: PASS');