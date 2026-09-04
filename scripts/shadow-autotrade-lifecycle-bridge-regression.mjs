import assert from 'node:assert/strict';
import { createShadowAutoTradeLifecycleBridge } from '../services/api/src/shadow-autotrade-lifecycle-bridge.mjs';

const calls = [];
const lifecycle = {
  async openPosition(input) { calls.push(['open', input]); return { position_id:'p1', mode:'SHADOW', live_execution_authorized:false }; },
  async markPosition(input) { calls.push(['mark', input]); return { position_id:input.position_id, mode:'SHADOW', live_execution_authorized:false }; },
  async closePosition(input) { calls.push(['close', input]); return { position_id:input.position_id, realized_pnl_usdc:1, mode:'SHADOW', live_execution_authorized:false }; }
};
const bridge = createShadowAutoTradeLifecycleBridge({}, { lifecycle });
const assessment = { token_mint:'TOKEN', quote_mint:'USDC', quality_score:90, snapshot:{ current_price_usdc:2, expected_net_edge_bps:20, costs_verified:true } };
const mandate = { follower_user_id:'u1', policy_id:'m1', trader_id:'t1' };

await bridge.applyDecision({ decision:{action:'BUY',mode:'SHADOW',live_execution_authorized:false,requested_amount_usd:100,reason_codes:['STRICT_SIGNAL_QUALIFIED']}, assessment, mandate, context:{executionMode:'SHADOW',liveEnabled:false,source_id:'a1'} });
assert.equal(calls[0][0],'open');
assert.equal(calls[0][1].amount_usdc,100);

await bridge.applyDecision({ decision:{action:'HOLD',mode:'SHADOW',live_execution_authorized:false,reason_codes:['POSITION_HEALTHY']}, assessment, mandate, position:{position_id:'p1'}, context:{executionMode:'SHADOW',liveEnabled:false,source_id:'a2'} });
assert.equal(calls[1][0],'mark');

await bridge.applyDecision({ decision:{action:'SELL',mode:'SHADOW',live_execution_authorized:false,reason_codes:['TRAILING_STOP']}, assessment, mandate, position:{position_id:'p1'}, context:{executionMode:'SHADOW',liveEnabled:false,source_id:'a3'} });
assert.equal(calls[2][0],'close');

await assert.rejects(() => bridge.applyDecision({ decision:{action:'BUY',mode:'SHADOW',live_execution_authorized:false,requested_amount_usd:100}, assessment, mandate, context:{executionMode:'LIVE',liveEnabled:true} }), /shadow_lifecycle_live_blocked/);
console.log('shadow autotrade lifecycle bridge regression: ok');
