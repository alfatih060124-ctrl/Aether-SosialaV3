import assert from 'node:assert/strict';
import { createOrcaRaydiumShadowNetworkFeeSource } from '../services/api/src/orca-raydium-shadow-network-fee-source.mjs';

const calls = [];
const fetchImpl = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.method);
  if (body.method === 'getLatestBlockhash') return { ok: true, json: async () => ({ result: { value: { blockhash: '11111111111111111111111111111111' } } }) };
  if (body.method === 'getRecentPrioritizationFees') return { ok: true, json: async () => ({ result: [{ prioritizationFee: 1000 }, { prioritizationFee: 2000 }, { prioritizationFee: 3000 }] }) };
  if (body.method === 'getFeeForMessage') {
    assert.equal(typeof body.params[0], 'string');
    assert.ok(body.params[0].length > 20);
    return { ok: true, json: async () => ({ result: { value: 10000 } }) };
  }
  throw new Error(`unexpected_rpc_method:${body.method}`);
};

const scannerRuntime = {
  async scanPair({ token_mint, quote_mint }) {
    assert.equal(token_mint, 'So11111111111111111111111111111111111111112');
    assert.equal(quote_mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    return {
      read_only: true,
      live_execution_authorized: false,
      pools: [
        { dex_id: 'orca', buy_price_usd: 150, sell_price_usd: 149.9, quote_verified: true, costs_verified: true },
        { dex_id: 'raydium', buy_price_usd: 150.2, sell_price_usd: 149.8, quote_verified: true, costs_verified: true }
      ]
    };
  }
};

const load = createOrcaRaydiumShadowNetworkFeeSource({ rpcUrl: 'https://rpc.example.test', scannerRuntime, fetchImpl });
const result = await load({});
assert.equal(result.network_fee_verified, true);
assert.equal(result.fee_lamports, 10000);
assert.equal(result.compute_unit_limit, 1400000);
assert.equal(result.sol_usd_price, 150.2);
assert.ok(result.network_fee_usdc > 0);
assert.equal(result.signer_requested, false);
assert.equal(result.transaction_submitted, false);
assert.equal(result.live_execution_authorized, false);
assert.deepEqual(calls.sort(), ['getFeeForMessage', 'getLatestBlockhash', 'getRecentPrioritizationFees'].sort());

const badScanner = { async scanPair() { return { read_only: true, live_execution_authorized: false, pools: [] }; } };
const failClosed = createOrcaRaydiumShadowNetworkFeeSource({ rpcUrl: 'https://rpc.example.test', scannerRuntime: badScanner, fetchImpl });
await assert.rejects(failClosed({}), /shadow_network_fee_sol_usd_evidence_required/);

console.log('ORCA Raydium SHADOW network fee source regression: PASS');
