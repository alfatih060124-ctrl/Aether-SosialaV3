import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { collectAutomaticNetworkFeeSnapshot } from '../services/api/src/reconciliation-network-fee-source.mjs';
import { createReconciliationRuntimeService } from '../services/api/src/reconciliation-runtime-service.mjs';

// Synthetic/test-only fixtures. These are not production transactions, trader performance,
// wallet balances, verification decisions, publication approvals, or LIVE execution data.
const signature = `${'1'.repeat(63)}3`;
const slot = 201;
const blockTime = 1_788_220_860;
const candleTimestamp = blockTime - (blockTime % 60);
const poolAddress = '1'.repeat(32);
const wsolMint = 'So11111111111111111111111111111111111111112';
const quoteMint = '2'.repeat(32);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

const fetchCalls = [];
const fetchImpl = async urlValue => {
  const url = String(urlValue);
  fetchCalls.push(url);
  if (url.includes('/ohlcv/minute')) {
    return jsonResponse({
      data: {
        attributes: {
          ohlcv_list: [[candleTimestamp, 199, 201, 198, 200, 12345]]
        }
      }
    });
  }
  return jsonResponse({
    data: {
      attributes: { address: poolAddress },
      relationships: {
        base_token: { data: { id: `solana_${wsolMint}` } },
        quote_token: { data: { id: `solana_${quoteMint}` } }
      }
    }
  });
};

const rpcCalls = [];
const rpcCall = async (method, params) => {
  rpcCalls.push({ method, params });
  assert.equal(method, 'getTransaction');
  assert.equal(params[0], signature);
  return {
    slot,
    blockTime,
    meta: { err: null, fee: 5000 }
  };
};

const ready = await collectAutomaticNetworkFeeSnapshot({
  sourceSignature: signature,
  expectedSlot: slot,
  rpcCall,
  solUsdPoolAddress: poolAddress,
  fetchImpl,
  clock: () => new Date('2026-09-01T08:00:00.000Z')
});
assert.equal(ready.status, 'NETWORK_FEE_READY');
assert.equal(ready.network_fee_ready, true);
assert.equal(ready.reconciliation_ready, false);
assert.equal(ready.evidence_ready, false);
assert.equal(ready.verification_authorized, false);
assert.equal(ready.publication_authorized, false);
assert.equal(ready.verified, false);
assert.equal(ready.published, false);
assert.equal(ready.live_execution_authorized, false);
assert.equal(ready.network_fee_snapshot.source_reference, signature);
assert.equal(ready.network_fee_snapshot.source_slot, slot);
assert.equal(ready.network_fee_snapshot.network_fee_lamports, 5000);
assert.equal(ready.network_fee_snapshot.network_fee_minor, 1000);
assert.equal(ready.network_fee_snapshot.currency, 'USD_MICRO');
assert.equal(ready.network_fee_snapshot.complete_additional_fee_set, false);
assert.equal(rpcCalls.length, 1);
assert.equal(fetchCalls.length, 2);
assert.ok(fetchCalls.every(url => url.startsWith('https://api.geckoterminal.com/')));

const noRpc = await collectAutomaticNetworkFeeSnapshot({
  sourceSignature: signature,
  expectedSlot: slot,
  rpcUrl: '',
  solUsdPoolAddress: poolAddress,
  fetchImpl
});
assert.equal(noRpc.status, 'PENDING_CONFIGURATION');
assert.deepEqual(noRpc.missing_sources, ['SOLANA_RPC_URL']);
assert.equal(noRpc.network_fee_ready, false);

const noPool = await collectAutomaticNetworkFeeSnapshot({
  sourceSignature: signature,
  expectedSlot: slot,
  rpcCall,
  solUsdPoolAddress: '',
  fetchImpl
});
assert.equal(noPool.status, 'PENDING_CONFIGURATION');
assert.deepEqual(noPool.missing_sources, ['RECONCILIATION_SOL_USD_POOL_ADDRESS']);
assert.equal(noPool.network_fee_ready, false);

const transient = await collectAutomaticNetworkFeeSnapshot({
  sourceSignature: signature,
  expectedSlot: slot,
  rpcCall: async () => { throw new Error('solana_rpc_timeout'); },
  solUsdPoolAddress: poolAddress,
  fetchImpl
});
assert.equal(transient.status, 'PENDING_SOURCE_COMPLETENESS');
assert.deepEqual(transient.missing_sources, ['SOLANA_NETWORK_FEE_USD']);
assert.ok(transient.blockers.includes('solana_rpc_timeout'));
assert.equal(transient.network_fee_ready, false);

const mismatch = await collectAutomaticNetworkFeeSnapshot({
  sourceSignature: signature,
  expectedSlot: slot,
  rpcCall: async () => ({ slot: slot + 1, blockTime, meta: { err: null, fee: 5000 } }),
  solUsdPoolAddress: poolAddress,
  fetchImpl
});
assert.equal(mismatch.status, 'BLOCKED_INVALID_SOURCE');
assert.ok(mismatch.blockers.includes('solana_fee_slot_mismatch'));
assert.equal(mismatch.network_fee_ready, false);

// Caller-supplied network-fee snapshots must be rejected before any DB access.
const runtime = createReconciliationRuntimeService({}, {
  quoteMints: [quoteMint],
  networkFeeCollector: async () => ready
});
await assert.rejects(
  runtime.coordinateAndRecord('00000000-0000-0000-0000-000000000001', {
    trade_event_id: 'synthetic-event',
    network_fee_snapshot: ready.network_fee_snapshot
  }),
  /reconciliation_caller_network_fee_snapshot_forbidden/
);

const runtimeSource = await fs.readFile(new URL('../services/api/src/reconciliation-runtime-service.mjs', import.meta.url), 'utf8');
const sourceModule = await fs.readFile(new URL('../services/api/src/reconciliation-network-fee-source.mjs', import.meta.url), 'utf8');
const envExample = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
assert.ok(runtimeSource.includes('collectAutomaticNetworkFeeSnapshot'));
assert.ok(runtimeSource.includes('reconciliation_caller_network_fee_snapshot_forbidden'));
assert.ok(runtimeSource.includes('networkFeeSnapshot: automaticNetworkFee.network_fee_snapshot'));
assert.equal(runtimeSource.includes('networkFeeSnapshot: input.network_fee_snapshot'), false);
assert.ok(sourceModule.includes("sourceSignature: sourceSignature" ) || sourceModule.includes('signature: sourceSignature'));
assert.ok(envExample.includes('RECONCILIATION_SOL_USD_POOL_ADDRESS='));
for (const forbidden of [
  'verification_authorized: true',
  'publication_authorized: true',
  'live_execution_authorized: true'
]) {
  assert.equal(runtimeSource.includes(forbidden), false);
  assert.equal(sourceModule.includes(forbidden), false);
}

console.log('automatic network fee runtime regression: PASS');
