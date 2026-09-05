import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createOrcaRaydiumSdkPretradeFeeRuntime } from '../services/api/src/orca-raydium-sdk-pretrade-fee-runtime.mjs';

const requireFromApi = createRequire(new URL('../services/api/package.json', import.meta.url));
const { PublicKey } = requireFromApi('@solana/web3.js');
const addr = seed => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) % 256)).toBase58();
const A = Array.from({ length: 48 }, (_, i) => addr(i + 1));
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const NOW = Date.parse('2026-09-05T18:30:00.000Z');
const observedAt = '2026-09-05T18:29:55.000Z';
const calls = [];

const resolveLegRequest = async ({ side, dex }) => {
  if (dex === 'ORCA') {
    return {
      pool_address: A[2],
      token_mint: A[0],
      quote_mint: A[1],
      source_slot: 1000,
      observed_at: observedAt,
      token_program: TOKEN_PROGRAM,
      token_authority: A[3],
      token_owner_account_a: A[4],
      token_vault_a: A[5],
      token_owner_account_b: A[6],
      token_vault_b: A[7],
      tick_array_0: A[8],
      tick_array_1: A[9],
      tick_array_2: A[10],
      oracle: A[11],
      amount: '1000000',
      other_amount_threshold: '990000',
      sqrt_price_limit: '0',
      amount_specified_is_input: true,
      a_to_b: side === 'BUY'
    };
  }
  return {
    pool_type: 'CPMM',
    pool_address: A[12],
    token_mint: A[0],
    quote_mint: A[1],
    source_slot: 1000,
    observed_at: observedAt,
    program_id: A[13],
    payer: A[14],
    authority: A[15],
    config_id: A[16],
    user_input_account: A[17],
    user_output_account: A[18],
    input_vault: A[19],
    output_vault: A[20],
    input_token_program: TOKEN_PROGRAM,
    output_token_program: TOKEN_PROGRAM,
    input_mint: A[0],
    output_mint: A[1],
    observation_id: A[21],
    amount_in: '1000000',
    amount_out_min: '990000'
  };
};

const rpcEvidenceProvider = Object.freeze({
  async getFeeForMessage(input) {
    calls.push('fee');
    assert.equal(input.source_slot, 1000);
    assert.ok(input.message_base64?.length > 0);
    return { verified: true, base_fee_lamports: 5000, source_slot: 1000, source_reference: 'RPC:FEE:1000', observed_at: observedAt };
  },
  async simulateUnsignedTransaction(input) {
    calls.push('simulation');
    assert.equal(input.source_slot, 1000);
    assert.ok(input.transaction_base64?.length > 0);
    return { verified: true, compute_units_consumed: 300000, source_slot: 1001, source_reference: 'RPC:SIM:1001', observed_at: observedAt };
  },
  async loadPriorityFeeEvidence(input) {
    calls.push('priority');
    assert.equal(input.source_slot, 1000);
    assert.ok(Array.isArray(input.account_keys) && input.account_keys.length > 0);
    return { verified: true, micro_lamports_per_compute_unit: 1000, source_slot: 1002, source_reference: 'RPC:PRIORITY:1002', observed_at: observedAt };
  },
  async loadCurrentSolUsdEvidence(input) {
    calls.push('solusd');
    assert.equal(input.source_slot, 1000);
    return { verified: true, sol_usd: 200, source_slot: 1003, source_reference: 'SOLUSD:1003', observed_at: observedAt };
  }
});

const runtime = createOrcaRaydiumSdkPretradeFeeRuntime({
  resolveLegRequest,
  loadRecentBlockhash: async () => ({
    verified: true,
    blockhash: '11111111111111111111111111111111',
    slot: 1000
  }),
  feePayer: 'Vote111111111111111111111111111111111111111',
  rpcEvidenceProvider,
  now: () => NOW,
  maxEvidenceAgeMs: 15_000
});

const result = await runtime.estimate({
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  live_execution_authorized: false
});
assert.equal(result.verified, true);
assert.equal(result.network_fee_verified, true);
assert.equal(result.network_fee_usdc, 0.00106);
assert.equal(result.message_source_slot, 1000);
assert.equal(result.transaction_signed, false);
assert.equal(result.signer_requested, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.live_execution_authorized, false);
assert.deepEqual(calls.sort(), ['fee', 'priority', 'simulation', 'solusd']);

await assert.rejects(
  () => runtime.estimate({ read_only: false, buy_dex: 'ORCA', sell_dex: 'RAYDIUM' }),
  /sdk_pretrade_read_only_required/
);
await assert.rejects(
  () => runtime.estimate({ read_only: true, buy_dex: 'ORCA', sell_dex: 'RAYDIUM', live_execution_authorized: true }),
  /sdk_pretrade_live_boundary_violation/
);

console.log('orca raydium SDK pretrade fee runtime regression ok');
