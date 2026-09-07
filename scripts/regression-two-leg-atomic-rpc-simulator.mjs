import assert from 'node:assert/strict';
import {
  createTwoLegAtomicRpcSimulator,
  TWO_LEG_ATOMIC_RPC_SIMULATOR
} from '../services/api/src/two-leg-atomic-rpc-simulator.mjs';

assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.rpc_method, 'simulateTransaction');
assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.sig_verify, false);
assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.replace_recent_blockhash, true);
assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.network_submission_authorized, false);
assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.fund_movement_authorized, false);
assert.equal(TWO_LEG_ATOMIC_RPC_SIMULATOR.live_execution_authorized, false);

const decision = Object.freeze({ strategy: 'TWO_LEG_ARBITRAGE', dex_pair: 'ORCA_RAYDIUM' });
const plan = Object.freeze({
  schema: 'aether.two_leg_atomic_unsigned_plan.v1',
  atomic: true,
  leg_count: 2,
  signed: false,
  transaction_signed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

const requests = [];
const simulator = createTwoLegAtomicRpcSimulator({
  rpcUrl: 'https://rpc.example.invalid',
  now: () => Date.parse('2026-09-07T05:00:00.000Z'),
  fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: { err: null, unitsConsumed: 234567, logs: [] }
          }
        };
      }
    };
  }
});

await assert.rejects(
  simulator({
    transaction_base64: 'dGVzdA==',
    sig_verify: true,
    replace_recent_blockhash: true,
    decision,
    plan
  }),
  /two_leg_rpc_simulator_sig_verify_must_be_false/
);
assert.equal(requests.length, 0);

const result = await simulator({
  transaction_base64: 'dGVzdA==',
  sig_verify: false,
  replace_recent_blockhash: true,
  decision,
  plan
});

assert.equal(result.ok, true);
assert.equal(result.err, null);
assert.equal(result.slot, 123456);
assert.equal(result.units_consumed, 234567);
assert.equal(result.observed_at, '2026-09-07T05:00:00.000Z');
assert.equal(result.sig_verify, false);
assert.equal(result.network_submission_performed, false);
assert.equal(result.fund_movement_performed, false);
assert.equal(result.transaction_signed, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(requests.length, 1);

const body = JSON.parse(requests[0].options.body);
assert.equal(body.method, 'simulateTransaction');
assert.equal(body.params[0], 'dGVzdA==');
assert.deepEqual(body.params[1], {
  encoding: 'base64',
  sigVerify: false,
  replaceRecentBlockhash: true,
  commitment: 'confirmed'
});
assert.equal(requests[0].options.redirect, 'error');

const failing = createTwoLegAtomicRpcSimulator({
  rpcUrl: 'https://rpc.example.invalid',
  now: () => Date.now(),
  fetchImpl: async () => ({
    ok: true,
    async json() {
      return {
        result: {
          context: { slot: 99 },
          value: { err: { InstructionError: [0, 'Custom'] }, unitsConsumed: 100 }
        }
      };
    }
  })
});
const failedResult = await failing({
  transaction_base64: 'dGVzdA==',
  sig_verify: false,
  replace_recent_blockhash: true,
  decision,
  plan
});
assert.equal(failedResult.ok, false);
assert.deepEqual(failedResult.err, { InstructionError: [0, 'Custom'] });

console.log('two-leg atomic RPC simulator regression: PASS');
