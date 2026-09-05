import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createOrcaSdkInstructionEvidenceBuilder,
  createRaydiumSdkInstructionEvidenceBuilder
} from '../services/api/src/orca-raydium-sdk-instruction-evidence-builder.mjs';
import { createOrcaRaydiumUnsignedMessageEvidenceBuilder } from '../services/api/src/orca-raydium-unsigned-message-evidence-builder.mjs';

const requireFromApi = createRequire(new URL('../services/api/package.json', import.meta.url));
const { PublicKey } = requireFromApi('@solana/web3.js');
const addr = seed => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) % 256)).toBase58();
const A = Array.from({ length: 40 }, (_, i) => addr(i + 1));
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const observedAt = '2026-09-05T17:50:00.000Z';

const common = {
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  private_key_present: false,
  signature_present: false,
  transaction_signed: false,
  signer_requested: false,
  network_submission_authorized: false,
  live_execution_authorized: false,
  side: 'BUY',
  token_mint: A[0],
  quote_mint: A[1],
  source_slot: 1000,
  observed_at: observedAt
};

const orca = createOrcaSdkInstructionEvidenceBuilder();
const orcaEvidence = await orca({
  ...common,
  pool_address: A[2],
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
  a_to_b: true
});
assert.equal(orcaEvidence.dex, 'ORCA');
assert.equal(orcaEvidence.instructions.length, 1);
assert.equal(orcaEvidence.instructions[0].accounts.length, 11);
assert.deepEqual(orcaEvidence.account_metas, orcaEvidence.instructions[0].accounts);
assert.ok(orcaEvidence.instructions[0].accounts.some(meta => meta.pubkey === A[3] && meta.isSigner === true && meta.isWritable === false));
assert.equal(orcaEvidence.instruction_building_authorized, true);
assert.equal(orcaEvidence.transaction_building_authorized, false);
assert.equal(orcaEvidence.transaction_signed, false);
assert.equal(orcaEvidence.signer_requested, false);
assert.equal(orcaEvidence.private_key_present, false);
assert.equal(orcaEvidence.network_submission_authorized, false);
assert.equal(orcaEvidence.live_execution_authorized, false);
assert.ok(orcaEvidence.instructions[0].data_base64.length > 0);

const raydium = createRaydiumSdkInstructionEvidenceBuilder();
const cpmm = await raydium({
  ...common,
  pool_type: 'CPMM',
  pool_address: A[12],
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
});
assert.equal(cpmm.dex, 'RAYDIUM');
assert.equal(cpmm.instructions.length, 1);
assert.equal(cpmm.instructions[0].accounts.length, 13);
assert.deepEqual(cpmm.account_metas, cpmm.instructions[0].accounts);
assert.ok(cpmm.instructions[0].accounts.some(meta => meta.pubkey === A[14] && meta.isSigner === true));
assert.equal(cpmm.transaction_building_authorized, false);
assert.ok(cpmm.instructions[0].data_base64.length > 0);

const clmm = await raydium({
  ...common,
  pool_type: 'CLMM',
  pool_address: A[22],
  program_id: A[23],
  payer: A[24],
  amm_config: A[25],
  user_input_account: A[26],
  user_output_account: A[27],
  input_vault: A[28],
  output_vault: A[29],
  input_mint: A[0],
  output_mint: A[1],
  tick_arrays: [A[30], A[31], A[32]],
  observation_id: A[33],
  amount_in: '1000000',
  amount_out_min: '990000',
  sqrt_price_limit_x64: '0',
  tick_array_bitmap_extension: A[34]
});
assert.equal(clmm.dex, 'RAYDIUM');
assert.deepEqual(clmm.account_metas, clmm.instructions[0].accounts);
assert.ok(clmm.instructions[0].accounts.some(meta => meta.pubkey === A[24] && meta.isSigner === true));
assert.ok(clmm.instructions[0].accounts.some(meta => meta.pubkey === A[30] && meta.isWritable === true));
assert.ok(clmm.instructions[0].data_base64.length > 0);

const sellCpmm = Object.freeze({ ...cpmm, side: 'SELL' });
const unsignedBuilder = createOrcaRaydiumUnsignedMessageEvidenceBuilder({
  buildBuyLeg: async () => orcaEvidence,
  buildSellLeg: async () => sellCpmm,
  loadRecentBlockhash: async () => ({
    verified: true,
    blockhash: '11111111111111111111111111111111',
    slot: 1001
  }),
  now: () => Date.parse(observedAt)
});
const unsignedEvidence = await unsignedBuilder.build({
  strategy: 'TWO_LEG_ARBITRAGE',
  read_only: true,
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  live_execution_authorized: false
});
assert.equal(unsignedEvidence.verified, true);
assert.equal(unsignedEvidence.buy_leg.dex, 'ORCA');
assert.equal(unsignedEvidence.sell_leg.dex, 'RAYDIUM');
assert.equal(unsignedEvidence.instructions.length, 2);
assert.equal(unsignedEvidence.transaction_signed, false);
assert.equal(unsignedEvidence.signer_requested, false);
assert.equal(unsignedEvidence.network_submission_authorized, false);
assert.equal(unsignedEvidence.live_execution_authorized, false);

await assert.rejects(
  () => orca({ ...common, pool_address: A[2], live_execution_authorized: true }),
  /sdk_instruction_live_boundary_violation/
);
await assert.rejects(
  () => raydium({ ...common, pool_type: 'AMM', pool_address: A[12] }),
  /raydium_instruction_pool_type_unsupported/
);
await assert.rejects(
  () => raydium({ ...common, pool_type: 'CPMM', pool_address: A[12], private_key_present: true }),
  /sdk_instruction_signing_boundary_violation/
);

console.log('orca raydium SDK instruction evidence builder regression ok');
