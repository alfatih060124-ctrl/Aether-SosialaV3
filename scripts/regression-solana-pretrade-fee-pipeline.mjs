import assert from 'node:assert/strict';
import { createSolanaPretradeFeePipeline } from '../services/api/src/solana-pretrade-fee-pipeline.mjs';

const NOW = Date.parse('2026-09-05T17:15:00.000Z');
const observed = '2026-09-05T17:14:55.000Z';
const calls = [];

const unsignedInstructionEvidence = Object.freeze({
  verified: true,
  unsigned: true,
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  recent_blockhash: '11111111111111111111111111111111',
  source_slot: 900,
  observed_at: observed,
  transaction_signed: false,
  signer_requested: false,
  private_key_present: false,
  signature_present: false,
  network_submission_authorized: false,
  live_execution_authorized: false,
  instructions: [
    {
      program_id: '11111111111111111111111111111111',
      accounts: [
        { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
        { pubkey: 'So11111111111111111111111111111111111111112', isSigner: false, isWritable: true }
      ],
      data_base64: 'AQID'
    }
  ]
});

const rpcEvidenceProvider = Object.freeze({
  async getFeeForMessage(input) {
    calls.push(['fee', input]);
    assert.equal(input.source_slot, 900);
    assert.ok(typeof input.message_base64 === 'string' && input.message_base64.length > 0);
    return { verified: true, base_fee_lamports: 5000, source_slot: 900, source_reference: 'RPC:FEE:900', observed_at: observed };
  },
  async simulateUnsignedTransaction(input) {
    calls.push(['simulation', input]);
    assert.equal(input.source_slot, 900);
    assert.ok(typeof input.transaction_base64 === 'string' && input.transaction_base64.length > 0);
    return { verified: true, compute_units_consumed: 300000, source_slot: 901, source_reference: 'RPC:SIM:901', observed_at: observed };
  },
  async loadPriorityFeeEvidence(input) {
    calls.push(['priority', input]);
    assert.equal(input.source_slot, 900);
    assert.ok(Array.isArray(input.account_keys));
    assert.ok(input.account_keys.includes('11111111111111111111111111111111'));
    return { verified: true, micro_lamports_per_compute_unit: 1000, source_slot: 902, source_reference: 'RPC:PRIORITY:902', observed_at: observed };
  },
  async loadCurrentSolUsdEvidence(input) {
    calls.push(['solusd', input]);
    assert.equal(input.source_slot, 900);
    return { verified: true, sol_usd: 200, source_slot: 903, source_reference: 'PRICE:SOLUSD:903', observed_at: observed };
  }
});

const pipeline = createSolanaPretradeFeePipeline({
  loadUnsignedInstructionEvidence: async context => {
    assert.equal(context.read_only, true);
    assert.equal(context.strategy, 'TWO_LEG_ARBITRAGE');
    return unsignedInstructionEvidence;
  },
  feePayer: 'Vote111111111111111111111111111111111111111',
  rpcEvidenceProvider,
  now: () => NOW,
  maxEvidenceAgeMs: 15_000
});

const result = await pipeline.estimate({ read_only: true, opportunity_id: 'opp-fee-1' });
assert.equal(result.verified, true);
assert.equal(result.network_fee_verified, true);
assert.equal(result.base_fee_lamports, 5000);
assert.equal(result.priority_fee_lamports, 300);
assert.equal(result.total_roundtrip_fee_lamports, 5300);
assert.equal(result.network_fee_usdc, 0.00106);
assert.equal(result.message_source_slot, 900);
assert.equal(result.transaction_signed, false);
assert.equal(result.signer_requested, false);
assert.equal(result.network_submission_authorized, false);
assert.equal(result.live_execution_authorized, false);
assert.deepEqual(calls.map(([name]) => name).sort(), ['fee', 'priority', 'simulation', 'solusd']);

await assert.rejects(() => pipeline.estimate({ read_only: false }), /pretrade_pipeline_read_only_required/);
await assert.rejects(() => pipeline.estimate({ read_only: true, live_execution_authorized: true }), /pretrade_pipeline_live_boundary_violation/);

const stalePipeline = createSolanaPretradeFeePipeline({
  loadUnsignedInstructionEvidence: async () => ({ ...unsignedInstructionEvidence, observed_at: '2026-09-05T17:14:00.000Z' }),
  feePayer: 'Vote111111111111111111111111111111111111111',
  rpcEvidenceProvider,
  now: () => NOW,
  maxEvidenceAgeMs: 15_000
});
await assert.rejects(() => stalePipeline.estimate({ read_only: true }), /pretrade_message_observed_at_stale/);

console.log('solana pretrade fee pipeline regression ok');
