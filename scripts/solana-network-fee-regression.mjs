import assert from 'node:assert/strict';
import {
  collectSolanaNetworkFeeObservation,
  valueSolanaNetworkFeeObservation,
  verifySolanaNetworkFeeObservation
} from '../packages/reconciliation-accounting/solana-network-fee.mjs';

const SIGNATURE='1'.repeat(64);
const SLOT=123456789;
const OBSERVED='2026-09-01T05:15:00.000Z';
const BLOCK_TIME=1788239700;

let rpcCalls=[];
async function rpcCall(method, params) {
  rpcCalls.push({method,params});
  return {
    slot:SLOT,
    blockTime:BLOCK_TIME,
    meta:{err:null,fee:5000}
  };
}

const observation=await collectSolanaNetworkFeeObservation({
  signature:SIGNATURE,
  rpcCall,
  expectedSlot:SLOT,
  endpointLabel:'fixture-solana-rpc',
  clock:()=>new Date(OBSERVED)
});
assert.equal(rpcCalls.length,1);
assert.equal(rpcCalls[0].method,'getTransaction');
assert.equal(rpcCalls[0].params[0],SIGNATURE);
assert.equal(rpcCalls[0].params[1].commitment,'confirmed');
assert.equal(observation.source_type,'SOLANA_TRANSACTION_FEE_LAMPORTS_V1');
assert.equal(observation.source_slot,SLOT);
assert.equal(observation.network_fee_lamports,5000);
assert.equal(observation.status,'PENDING_SOL_USD_VALUATION');
assert.equal(observation.promoter_ready,false);
assert.equal(observation.reconciliation_ready,false);
assert.equal(observation.evidence_ready,false);
assert.equal(observation.verified,false);
assert.equal(observation.published,false);
assert.equal(observation.live_execution_authorized,false);
assert.match(observation.source_hash,/^[a-f0-9]{64}$/);
assert.doesNotThrow(()=>verifySolanaNetworkFeeObservation(observation));

const priceSnapshot={
  source_type:'SOL_USD_PRICE_V1',
  source_reference:'fixture-sol-usd-price-0001',
  source_hash:'a'.repeat(64),
  anchor_slot:SLOT,
  observed_at:'2026-09-01T05:15:30.000Z',
  price_usd_micro_per_sol:150_000_000,
  currency:'USD_MICRO_PER_SOL'
};
const valued=valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:priceSnapshot});
assert.equal(valued.source_type,'SOLANA_NETWORK_FEE_USD_V1');
assert.equal(valued.network_fee_lamports,5000);
assert.equal(valued.network_fee_minor,750);
assert.equal(valued.currency,'USD_MICRO');
assert.equal(valued.status,'NETWORK_FEE_VALUED_PENDING_ADDITIONAL_FEES');
assert.equal(valued.complete_additional_fee_set,false);
assert.equal(valued.additional_fee_minor,null);
assert.equal(valued.promoter_ready,false);
assert.equal(valued.reconciliation_ready,false);
assert.equal(valued.evidence_ready,false);
assert.equal(valued.verified,false);
assert.equal(valued.published,false);
assert.equal(valued.live_execution_authorized,false);
assert.match(valued.source_hash,/^[a-f0-9]{64}$/);
assert.deepEqual(valued,valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:priceSnapshot}));

const tampered={...observation,network_fee_lamports:5001};
assert.throws(()=>verifySolanaNetworkFeeObservation(tampered),/solana_fee_source_hash_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation}),/sol_usd_snapshot_required/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,anchor_slot:SLOT+1}}),/sol_usd_anchor_slot_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,observed_at:'2026-09-01T05:21:00.001Z'}}),/sol_usd_time_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,source_hash:'bad'}}),/invalid_sol_usd_source_hash/);

await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:'not-base58',rpcCall}),/invalid_solana_signature/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>null}),/solana_transaction_not_found/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>({slot:SLOT,blockTime:BLOCK_TIME,meta:{err:{InstructionError:[0,'Custom']},fee:5000}})}),/solana_transaction_failed/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,expectedSlot:SLOT+1,rpcCall}),/solana_fee_slot_mismatch/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>({slot:SLOT,blockTime:BLOCK_TIME,meta:{err:null}})}),/invalid_network_fee_lamports/);

console.log('solana network fee regression: PASS');
