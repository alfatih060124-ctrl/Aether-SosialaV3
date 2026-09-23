import assert from 'node:assert/strict';
import { observeJitoStyleShadowEvent, getJitoStyleShadowIntelligence, resetJitoStyleShadowIntelligenceForTest } from '../services/api/src/jito-style-shadow-intelligence.mjs';

resetJitoStyleShadowIntelligenceForTest();
const row=observeJitoStyleShadowEvent({
  bundle_id:'bundle-test', transaction_count:2, status:'LANDED',
  dexes:['ORCA','RAYDIUM'], gross_edge_bps:8, estimated_cost_bps:2, expected_net_edge_bps:6
});
assert.equal(row.bundle_candidate,true);
assert.equal(row.arbitrage_candidate,true);
assert.equal(row.non_custodial,true);
assert.equal(row.signer_required,false);
assert.equal(row.transaction_signed,false);
assert.equal(row.execution_dispatched,false);
assert.equal(row.network_submission_authorized,false);
assert.equal(row.live_execution_authorized,false);
const state=getJitoStyleShadowIntelligence();
assert.equal(state.model,'AETHER_JITO_STYLE_OBSERVABILITY_V1');
assert.equal(state.counters.observed,1);
assert.equal(state.counters.bundle_candidates,1);
assert.equal(state.counters.arbitrage_candidates,1);
assert.equal(state.safety.private_key_stored,false);
assert.equal(state.safety.seed_phrase_stored,false);
console.log('PASS jito-style shadow intelligence regression');