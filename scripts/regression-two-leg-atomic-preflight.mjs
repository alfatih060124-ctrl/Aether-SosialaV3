import assert from 'node:assert/strict';
import {
  runTwoLegAtomicPreflight,
  TWO_LEG_ATOMIC_PREFLIGHT
} from '../services/api/src/two-leg-atomic-preflight.mjs';

const now = Date.parse('2026-09-07T04:30:00.000Z');
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
  notional_usdc: 50,
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM'
});

const plan = Object.freeze({
  schema: 'aether.two_leg_atomic_unsigned_plan.v1',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  atomic: true,
  leg_count: 2,
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  notional_usdc: 50,
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  unsigned_transaction_base64: Buffer.from('unsigned-v0-transaction').toString('base64'),
  transaction_hash: 'txhash',
  signed: false,
  transaction_signed: false,
  signer_requested: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

assert.equal(TWO_LEG_ATOMIC_PREFLIGHT.fail_closed, true);
assert.equal(TWO_LEG_ATOMIC_PREFLIGHT.transaction_signing_authorized, false);
assert.equal(TWO_LEG_ATOMIC_PREFLIGHT.network_submission_authorized, false);
assert.equal(TWO_LEG_ATOMIC_PREFLIGHT.fund_movement_authorized, false);

let simulateCalls = 0;
const blocked = [];
await assert.rejects(
  runTwoLegAtomicPreflight({
    decision: { ...decision, expected_net_edge_bps: 19 },
    plan,
    simulateUnsignedTransaction: async () => { simulateCalls += 1; },
    auditWrite: async event => blocked.push(event),
    now
  }),
  /two_leg_preflight_net_edge_below_floor/
);
assert.equal(simulateCalls, 0);
assert.equal(blocked.at(-1)?.event_type, 'TWO_LEG_ATOMIC_PREFLIGHT_BLOCKED');

await assert.rejects(
  runTwoLegAtomicPreflight({
    decision,
    plan: { ...plan, token_mint: 'OTHER' },
    simulateUnsignedTransaction: async () => { simulateCalls += 1; },
    auditWrite: async () => {},
    now
  }),
  /two_leg_preflight_plan_token_mint_mismatch/
);
assert.equal(simulateCalls, 0);

await assert.rejects(
  runTwoLegAtomicPreflight({
    decision,
    plan,
    simulateUnsignedTransaction: async () => {
      simulateCalls += 1;
      return {
        ok: false,
        err: { InstructionError: [1, 'Custom'] },
        slot: 123,
        units_consumed: 100000,
        observed_at: '2026-09-07T04:29:59.000Z',
        sig_verify: false,
        network_submission_performed: false,
        fund_movement_performed: false
      };
    },
    auditWrite: async () => {},
    now
  }),
  /two_leg_preflight_simulation_failed/
);
assert.equal(simulateCalls, 1);

await assert.rejects(
  runTwoLegAtomicPreflight({
    decision,
    plan,
    simulateUnsignedTransaction: async () => {
      simulateCalls += 1;
      return {
        ok: true,
        err: null,
        slot: 123,
        units_consumed: 100000,
        observed_at: '2026-09-07T04:00:00.000Z',
        sig_verify: false,
        network_submission_performed: false,
        fund_movement_performed: false
      };
    },
    auditWrite: async () => {},
    now
  }),
  /two_leg_preflight_simulation_stale/
);
assert.equal(simulateCalls, 2);

const events = [];
const result = await runTwoLegAtomicPreflight({
  decision,
  plan,
  simulateUnsignedTransaction: async ({ transaction_base64, sig_verify, replace_recent_blockhash }) => {
    simulateCalls += 1;
    assert.equal(transaction_base64, plan.unsigned_transaction_base64);
    assert.equal(sig_verify, false);
    assert.equal(replace_recent_blockhash, true);
    return {
      ok: true,
      err: null,
      slot: 456,
      units_consumed: 175000,
      observed_at: '2026-09-07T04:29:59.500Z',
      sig_verify: false,
      network_submission_performed: false,
      fund_movement_performed: false
    };
  },
  auditWrite: async event => events.push(event),
  now
});

assert.equal(result.preflight_verified, true);
assert.equal(result.simulation_ok, true);
assert.equal(result.transaction_signing_authorized, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.fund_movement_authorized, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(events.at(-1)?.event_type, 'TWO_LEG_ATOMIC_PREFLIGHT_VERIFIED');
assert.equal(simulateCalls, 3);

console.log('two-leg atomic preflight regression: PASS');
