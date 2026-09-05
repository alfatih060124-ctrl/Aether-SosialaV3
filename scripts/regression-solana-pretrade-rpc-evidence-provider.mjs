import assert from 'node:assert/strict';
import { createSolanaPretradeRpcEvidenceProvider } from '../services/api/src/solana-pretrade-rpc-evidence-provider.mjs';

const NOW = Date.parse('2026-09-05T16:58:00.000Z');
const calls = [];
const fetchImpl = async (_url, options) => {
  const body = JSON.parse(options.body);
  calls.push(body.method);
  const responses = {
    getFeeForMessage: { jsonrpc: '2.0', id: 1, result: { context: { slot: 500 }, value: 5000 } },
    simulateTransaction: { jsonrpc: '2.0', id: 1, result: { context: { slot: 501 }, value: { err: null, unitsConsumed: 300000 } } },
    getRecentPrioritizationFees: { jsonrpc: '2.0', id: 1, result: [
      { slot: 500, prioritizationFee: 1000 },
      { slot: 501, prioritizationFee: 2000 },
      { slot: 502, prioritizationFee: 3000 },
      { slot: 503, prioritizationFee: 4000 }
    ] }
  };
  return { ok: true, status: 200, json: async () => responses[body.method] };
};

const provider = createSolanaPretradeRpcEvidenceProvider({
  rpcUrl: 'https://rpc.example.test',
  fetchImpl,
  now: () => NOW,
  priorityPercentile: 0.75,
  loadCurrentSolUsdPrice: async ({ source_slot }) => ({
    verified: true,
    sol_usd: 200,
    source_slot: source_slot + 2,
    source_reference: 'PRICE:SOLUSD:CURRENT',
    observed_at: '2026-09-05T16:57:55.000Z'
  })
});

const fee = await provider.getFeeForMessage({ message_base64: 'bWVzc2FnZQ==', source_slot: 500 });
assert.equal(fee.verified, true);
assert.equal(fee.base_fee_lamports, 5000);
assert.equal(fee.source_slot, 500);

const simulation = await provider.simulateUnsignedTransaction({ transaction_base64: 'dHJhbnNhY3Rpb24=', source_slot: 500 });
assert.equal(simulation.compute_units_consumed, 300000);
assert.equal(simulation.transaction_signed, false);
assert.equal(simulation.network_submission_authorized, false);

const priority = await provider.loadPriorityFeeEvidence({ account_keys: ['A', 'B', 'A'], source_slot: 500 });
assert.equal(priority.verified, true);
assert.equal(priority.micro_lamports_per_compute_unit, 4000);
assert.equal(priority.sample_count, 4);
assert.equal(priority.source_slot, 503);

const price = await provider.loadCurrentSolUsdEvidence({ source_slot: 500 });
assert.equal(price.verified, true);
assert.equal(price.sol_usd, 200);
assert.equal(price.source_slot, 502);
assert.deepEqual(calls, ['getFeeForMessage', 'simulateTransaction', 'getRecentPrioritizationFees']);

await assert.rejects(
  createSolanaPretradeRpcEvidenceProvider({ rpcUrl: 'http://insecure.test', fetchImpl, loadCurrentSolUsdPrice: async () => ({}) }),
  /pretrade_rpc_https_required/
);

const failingSimulation = createSolanaPretradeRpcEvidenceProvider({
  rpcUrl: 'https://rpc.example.test',
  now: () => NOW,
  loadCurrentSolUsdPrice: async () => ({ verified: true, sol_usd: 200, source_slot: 500, source_reference: 'x', observed_at: '2026-09-05T16:57:55.000Z' }),
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'simulateTransaction') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { context: { slot: 500 }, value: { err: { InstructionError: [0, 'Custom'] }, unitsConsumed: 100 } } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
  }
});
await assert.rejects(failingSimulation.simulateUnsignedTransaction({ transaction_base64: 'dHg=', source_slot: 500 }), /pretrade_rpc_simulation_failed/);

console.log('solana pretrade rpc evidence provider regression ok');
