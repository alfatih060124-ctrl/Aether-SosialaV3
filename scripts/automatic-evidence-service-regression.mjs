import assert from 'node:assert/strict';
import { createAutomaticEvidenceService, createSolanaJsonRpcCaller } from '../services/api/src/automatic-evidence-service.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let out = '';
  while (value > 0n) {
    const rem = Number(value % 58n);
    value /= 58n;
    out = ALPHABET[rem] + out;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return '1'.repeat(zeroes) + (out || '1');
}

const wallet = base58(new Uint8Array(32).fill(7));
const signature = base58(new Uint8Array(64).fill(9));
const trader = {
  trader_id: '11111111-1111-4111-8111-111111111111',
  wallet_address: wallet,
  onboarding_status: 'APPROVED',
  verification_status: 'PENDING_DATA',
  published: false,
  verified: false,
  mode: 'SHADOW',
  status: 'PENDING_VERIFICATION'
};

const inserted = [];
const pool = {
  async query(sql, params = []) {
    if (sql.includes('FROM traders WHERE trader_id=$1')) return { rows: [trader] };
    if (sql.includes('INSERT INTO trader_evidence_collection_runs')) {
      const row = {
        collection_id: params[0], trader_id: params[1], source_type: params[2], source_reference: params[3],
        observed_at: params[4], collection_status: 'PENDING_DATA', reason: params[5], provenance: JSON.parse(params[6]),
        metrics_available: false, verified: false, published: false, live_execution_authorized: false,
        created_at: new Date('2026-09-01T00:00:00.000Z')
      };
      inserted.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM trader_evidence_collection_runs')) return { rows: inserted };
    throw new Error(`unexpected_sql:${sql}`);
  }
};

let rpcCalls = 0;
const fetchImpl = async (_url, options) => {
  rpcCalls += 1;
  const request = JSON.parse(options.body);
  assert.equal(request.method, 'getSignaturesForAddress');
  assert.equal(request.params[0], wallet);
  return {
    ok: true,
    async json() {
      return {
        jsonrpc: '2.0', id: request.id,
        result: [{ signature, slot: 123, blockTime: 1788235200, err: null, confirmationStatus: 'finalized' }]
      };
    }
  };
};

const service = createAutomaticEvidenceService(pool, {
  rpcUrl: 'https://rpc.example.invalid', endpointLabel: 'test-rpc', fetchImpl
});
const collection = await service.collectSolana(trader.trader_id, { limit: 10, max_pages: 2 });
assert.equal(rpcCalls, 1);
assert.equal(collection.source_type, 'SOLANA_RPC');
assert.equal(collection.source_reference, signature);
assert.equal(collection.collection_status, 'PENDING_DATA');
assert.equal(collection.reason, 'reconciled_trade_performance_required');
assert.equal(collection.metrics_available, false);
assert.equal(collection.verified, false);
assert.equal(collection.published, false);
assert.equal(collection.live_execution_authorized, false);
assert.equal(collection.provenance.signatures_observed, 1);
assert.equal(collection.provenance.rpc_endpoint_label, 'test-rpc');
assert.ok(!JSON.stringify(collection).includes('rpc.example.invalid'), 'RPC URL must not be exposed in provenance');

const listed = await service.listCollections(trader.trader_id, 20);
assert.equal(listed.length, 1);
assert.equal(listed[0].collection_id, collection.collection_id);

assert.throws(() => createSolanaJsonRpcCaller({ rpcUrl: '' }), /solana_rpc_unconfigured/);
assert.throws(() => createSolanaJsonRpcCaller({ rpcUrl: 'file:///tmp/rpc' }), /invalid_solana_rpc_url/);

const nonShadowPool = {
  async query() { return { rows: [{ ...trader, mode: 'LIVE' }] }; }
};
const nonShadowService = createAutomaticEvidenceService(nonShadowPool, { rpcUrl: 'https://rpc.example.invalid', fetchImpl });
await assert.rejects(() => nonShadowService.collectSolana(trader.trader_id), /trader_not_shadow/);

console.log('automatic evidence service regression: PASS');
