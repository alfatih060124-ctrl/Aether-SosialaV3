import assert from 'node:assert/strict';
import { authorizeTwoLegSignerRequest, TWO_LEG_SIGNER_BOUNDARY } from '../services/api/src/two-leg-signer-boundary.mjs';

const now = Date.parse('2026-09-07T06:45:00.000Z');
const decision = Object.freeze({
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  action: 'ARBITRAGE_SETTLE',
  qualified: true,
  expected_net_edge_bps: 25,
  risk_verified: true,
  costs_verified: true,
  freshness_verified: true,
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  notional_usdc: '50.000000',
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM'
});
const preflight = Object.freeze({
  schema: 'aether.two_leg_atomic_preflight.v1',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  atomic: true,
  leg_count: 2,
  preflight_verified: true,
  simulation_ok: true,
  transaction_hash: 'txhash',
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false
});
const authority = Object.freeze({
  authority_id: 'authority-1',
  wallet_address: 'wallet-1',
  status: 'ACTIVE',
  allowed_strategy: 'TWO_LEG_ARBITRAGE',
  allowed_dex_pair: 'ORCA_RAYDIUM',
  min_net_edge_bps: 20,
  max_notional_usdc_atomic: '100000000',
  expires_at: '2026-09-08T06:45:00.000Z',
  live_execution_authorized: false,
  private_key_stored: false,
  signer_material_stored: false
});
const gateState = Object.freeze({
  execution_mode: 'LIVE',
  live_enabled: true,
  readiness_passed: true,
  admin_live_approved: true,
  signer_unlocked: true,
  network_submission_enabled: false,
  fund_movement_enabled: false,
  emergency_kill_switch: false
});

assert.equal(TWO_LEG_SIGNER_BOUNDARY.fail_closed, true);
assert.equal(TWO_LEG_SIGNER_BOUNDARY.transaction_signing_performed, false);
assert.equal(TWO_LEG_SIGNER_BOUNDARY.network_submission_authorized, false);
assert.equal(TWO_LEG_SIGNER_BOUNDARY.fund_movement_authorized, false);

const blocked = [];
await assert.rejects(
  authorizeTwoLegSignerRequest({
    decision: { ...decision, expected_net_edge_bps: 19 }, preflight, authority, gateState,
    unsignedTransactionBase64: 'dW5zaWduZWQ=', auditWrite: async event => blocked.push(event), now
  }),
  /two_leg_signer_net_edge_below_floor/
);
assert.equal(blocked.at(-1)?.event_type, 'TWO_LEG_SIGNER_REQUEST_BLOCKED');

await assert.rejects(
  authorizeTwoLegSignerRequest({
    decision, preflight, authority: { ...authority, max_notional_usdc_atomic: '49000000' }, gateState,
    unsignedTransactionBase64: 'dW5zaWduZWQ=', auditWrite: async () => {}, now
  }),
  /two_leg_signer_authority_notional_limit/
);

await assert.rejects(
  authorizeTwoLegSignerRequest({
    decision, preflight, authority, gateState: { ...gateState, signer_unlocked: false },
    unsignedTransactionBase64: 'dW5zaWduZWQ=', auditWrite: async () => {}, now
  }),
  /two_leg_signer_locked/
);

await assert.rejects(
  authorizeTwoLegSignerRequest({
    decision, preflight, authority, gateState: { ...gateState, emergency_kill_switch: true },
    unsignedTransactionBase64: 'dW5zaWduZWQ=', auditWrite: async () => {}, now
  }),
  /two_leg_signer_emergency_kill_switch_active/
);

const events = [];
const result = await authorizeTwoLegSignerRequest({
  decision, preflight, authority, gateState,
  unsignedTransactionBase64: 'dW5zaWduZWQ=', auditWrite: async event => events.push(event), now
});
assert.equal(result.signer_request_authorized, true);
assert.equal(result.transaction_signing_performed, false);
assert.equal(result.private_key_requested, false);
assert.equal(result.seed_phrase_requested, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.network_submission_performed, false);
assert.equal(result.fund_movement_authorized, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.transaction_hash, 'txhash');
assert.equal(events.at(-1)?.event_type, 'TWO_LEG_SIGNER_REQUEST_AUTHORIZED');

console.log('two-leg signer boundary regression: PASS');
