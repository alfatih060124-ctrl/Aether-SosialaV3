import assert from 'node:assert/strict';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { createNativeRoundTripSimulationService } from './native-roundtrip-simulation.mjs';

const payer = new PublicKey('7YttLkHDo9dBf8hKk9B2x2u9sx4u7wkfJTQ8yxnZJ3yS');
const destA = new PublicKey('11111111111111111111111111111111');
const destB = new PublicKey('SysvarRent111111111111111111111111111111111');
const duplicateAta = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ataProgram = new PublicKey(duplicateAta);
const fakeAta = new PublicKey('So11111111111111111111111111111111111111112');
const ataIx = {
  programId: ataProgram,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: fakeAta, isSigner: false, isWritable: true }
  ],
  data: Buffer.from([1])
};
const buyIx = SystemProgram.transfer({ fromPubkey: payer, toPubkey: destA, lamports: 1 });
const sellIx = SystemProgram.transfer({ fromPubkey: payer, toPubkey: destB, lamports: 1 });
const prepare = instruction => async () => ({
  payer,
  instructions: [ataIx, instruction],
  missing_ata_addresses: [fakeAta.toBase58()],
  token_account_rent_lamports: 2_039_280
});
const connection = {
  async getLatestBlockhash(){ return { blockhash:'11111111111111111111111111111111', lastValidBlockHeight:1 }; },
  async getFeeForMessage(){ return { value:5000 }; },
  async simulateTransaction(){ return { value:{ err:null, unitsConsumed:43210, logs:['ok'] } }; }
};
const service = createNativeRoundTripSimulationService({
  connection,
  simulationPublicKey: payer.toBase58()
});
const result = await service.observe({
  buyService:{ prepareUnsignedLeg:prepare(buyIx) }, buyQuote:{},
  sellService:{ prepareUnsignedLeg:prepare(sellIx) }, sellQuote:{}
});
assert.equal(result.transaction_built,true);
assert.equal(result.atomic_two_leg,true);
assert.equal(result.instruction_count,3);
assert.equal(result.ata_creations_required,1);
assert.equal(result.rent_lamports_required,2_039_280);
assert.equal(result.exact_fee_lamports,5000);
assert.equal(result.exact_execution_cost_lamports,2_044_280);
assert.equal(result.exact_transaction_fee_ready,true);
assert.equal(result.simulation_ok,true);
assert.equal(result.transaction_signed,false);
assert.equal(result.network_submission_authorized,false);
assert.equal(result.live_execution_authorized,false);
console.log('native roundtrip simulation regression: PASS');