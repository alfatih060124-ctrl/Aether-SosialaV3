import assert from 'node:assert/strict';
import {
  collectSolanaNetworkFeeObservation,
  valueSolanaNetworkFeeObservation,
  verifySolanaNetworkFeeObservation
} from '../packages/reconciliation-accounting/solana-network-fee.mjs';

// SYNTHETIC / TEST-ONLY fixture. Never use as production evidence.
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
assert.equal(observation.schema_version,2);
assert.equal(observation.source_type,'SOLANA_TRANSACTION_FEE_LAMPORTS_V1');
assert.equal(observation.source_slot,SLOT);
assert.equal(observation.block_time_unix,BLOCK_TIME);
assert.equal(observation.network_fee_lamports,5000);
assert.equal(observation.status,'PENDING_SOL_USD_VALUATION');
assert.equal(observation.promoter_ready,false);
assert.equal(observation.reconciliation_ready,false);
assert.equal(observation.evidence_ready,false);
assert.equal(observation.verified,false);
assert.equal(observation.published,false);
assert.equal(observation.live_execution_authorized,false);
assert.deepEqual(observation.provenance,{
  rpc_endpoint_label:'fixture-solana-rpc',
  rpc_method:'getTransaction',
  commitment:'confirmed',
  max_supported_transaction_version:0
});
assert.match(observation.source_hash,/^[a-f0-9]{64}$/);
assert.doesNotThrow(()=>verifySolanaNetworkFeeObservation(observation));

const priceSnapshot={
  source_type:'SOL_USD_PRICE_V1',
  source_reference:'fixture-sol-usd-price-0001',
  source_hash:'a'.repeat(64),
  anchor_slot:SLOT,
  transaction_block_time_unix:BLOCK_TIME,
  candle_timestamp_unix:BLOCK_TIME,
  candle_interval_seconds:60,
  observed_at:'2030-01-01T00:00:00.000Z',
  price_usd_micro_per_sol:150_000_000,
  currency:'USD_MICRO_PER_SOL',
  read_only:true,
  reconciliation_ready:false,
  evidence_ready:false,
  verified:false,
  published:false,
  live_execution_authorized:false
};
const valued=valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:priceSnapshot});
assert.equal(valued.schema_version,2);
assert.equal(valued.source_type,'SOLANA_NETWORK_FEE_USD_V1');
assert.equal(valued.network_fee_lamports,5000);
assert.equal(valued.network_fee_minor,750);
assert.equal(valued.transaction_block_time_unix,BLOCK_TIME);
assert.equal(valued.candle_timestamp_unix,BLOCK_TIME);
assert.equal(valued.candle_interval_seconds,60);
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
assert.deepEqual(valued.provenance.solana_rpc_provenance,observation.provenance);
assert.match(valued.source_hash,/^[a-f0-9]{64}$/);
assert.deepEqual(valued,valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:priceSnapshot}));

const tampered={...observation,network_fee_lamports:5001};
assert.throws(()=>verifySolanaNetworkFeeObservation(tampered),/solana_fee_source_hash_mismatch/);
assert.throws(()=>verifySolanaNetworkFeeObservation({...observation,schema_version:1}),/invalid_solana_fee_schema_version/);
assert.throws(()=>verifySolanaNetworkFeeObservation({
  ...observation,
  provenance:{...observation.provenance,rpc_endpoint_label:'tampered-rpc'}
}),/solana_fee_source_hash_mismatch/);
assert.throws(()=>verifySolanaNetworkFeeObservation({
  ...observation,
  provenance:{...observation.provenance,rpc_method:'getBlock'}
}),/invalid_solana_fee_rpc_method/);
assert.throws(()=>verifySolanaNetworkFeeObservation({
  ...observation,
  provenance:{...observation.provenance,commitment:'processed'}
}),/invalid_solana_fee_rpc_commitment/);
assert.throws(()=>verifySolanaNetworkFeeObservation({
  ...observation,
  provenance:{...observation.provenance,max_supported_transaction_version:1}
}),/invalid_solana_fee_transaction_version/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation}),/sol_usd_snapshot_required/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,anchor_slot:SLOT+1}}),/sol_usd_anchor_slot_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,transaction_block_time_unix:BLOCK_TIME+1}}),/sol_usd_transaction_time_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,candle_timestamp_unix:BLOCK_TIME+1}}),/sol_usd_candle_time_mismatch/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,candle_interval_seconds:300}}),/sol_usd_candle_interval_invalid/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,read_only:false}}),/sol_usd_boundary_violation/);
assert.throws(()=>valueSolanaNetworkFeeObservation({observation,solUsdSnapshot:{...priceSnapshot,source_hash:'bad'}}),/invalid_sol_usd_source_hash/);

const noBlockTime=await collectSolanaNetworkFeeObservation({
  signature:SIGNATURE,
  rpcCall:async()=>({slot:SLOT,blockTime:null,meta:{err:null,fee:5000}}),
  clock:()=>new Date(OBSERVED)
});
assert.throws(()=>valueSolanaNetworkFeeObservation({observation:noBlockTime,solUsdSnapshot:priceSnapshot}),/solana_fee_block_time_required_for_valuation/);

await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:'not-base58',rpcCall}),/invalid_solana_signature/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>null}),/solana_transaction_not_found/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>({slot:SLOT,blockTime:BLOCK_TIME,meta:{err:{InstructionError:[0,'Custom']},fee:5000}})}),/solana_transaction_failed/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,expectedSlot:SLOT+1,rpcCall}),/solana_fee_slot_mismatch/);
await assert.rejects(()=>collectSolanaNetworkFeeObservation({signature:SIGNATURE,rpcCall:async()=>({slot:SLOT,blockTime:BLOCK_TIME,meta:{err:null}})}),/invalid_network_fee_lamports/);

console.log('solana network fee regression: PASS');
