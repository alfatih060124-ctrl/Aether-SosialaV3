import assert from 'node:assert/strict';
import { createMemberAutoTradeRealMarketRuntime } from '../services/api/src/member-autotrade-real-market-runtime.mjs';

const QUOTE = 'USDC';
const discoveryService = Object.freeze({
  async getDiscovery(view) {
    assert.equal(view, 'trending');
    return Object.freeze({
      source: 'GECKOTERMINAL_PUBLIC',
      freshness: Object.freeze({ stale: false, execution_ready: false }),
      items: Object.freeze([
        Object.freeze({ base_token: Object.freeze({ mint: 'TOKEN_A' }), quote_token: Object.freeze({ mint: QUOTE }) }),
        Object.freeze({ base_token: Object.freeze({ mint: 'TOKEN_B' }), quote_token: Object.freeze({ mint: QUOTE }) }),
        Object.freeze({ base_token: Object.freeze({ mint: 'OTHER' }), quote_token: Object.freeze({ mint: 'PAIR' }) })
      ])
    });
  }
});

const calls = [];
const qualificationRuntime = Object.freeze({
  async scanAndQualifyPair(input) {
    calls.push(input);
    const edge = input.token_mint === 'TOKEN_A' ? 31 : 47;
    return Object.freeze({
      mode: 'SHADOW',
      strategy: 'TWO_LEG_ARBITRAGE',
      live_execution_authorized: false,
      results: Object.freeze([
        Object.freeze({
          qualified: true,
          assessment: Object.freeze({ arbitrage: Object.freeze({ expected_net_edge_bps: edge }) }),
          settlement: Object.freeze({ settlement_status: 'ARBITRAGE_CLOSED' })
        })
      ])
    });
  }
});

const runtime = createMemberAutoTradeRealMarketRuntime({
  discoveryService,
  qualificationRuntime,
  quoteMint: QUOTE
});
const result = await runtime.runNextOpportunity({ demo_account: { cash_balance_usdc: 100, open_position: {} } });
assert.equal(calls.length, 2);
assert.equal(result.candidate_count, 2);
assert.equal(result.qualified_count, 2);
assert.equal(result.selected.assessment.arbitrage.expected_net_edge_bps, 47);
assert.equal(result.discovery_execution_ready, false);
assert.equal(result.mode, 'SHADOW');
assert.equal(result.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(result.execution_dispatched, false);
assert.equal(result.funds_moved, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.live_execution_authorized, false);

const staleRuntime = createMemberAutoTradeRealMarketRuntime({
  discoveryService: { async getDiscovery() { return { freshness: { stale: true }, items: [] }; } },
  qualificationRuntime,
  quoteMint: QUOTE
});
await assert.rejects(
  () => staleRuntime.runNextOpportunity({ demo_account: { cash_balance_usdc: 100, open_position: {} } }),
  /member_real_market_discovery_stale/
);

console.log('member auto trade real-market runtime regression: PASS');
