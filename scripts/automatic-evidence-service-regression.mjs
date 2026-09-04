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

// SYNTHETIC / TEST-ONLY identifiers and rows. Never production signatures, wallets, trades, metrics, or source references.
const wallet = base58(new Uint8Array(32).fill(7));
const signature = base58(new Uint8Array(64).fill(9));
const canonicalReference = `solana_rpc:${signature}@123`;
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
        metrics_available: false, trades_count: null, total_return_bps: null, win_rate_bps: null,
        drawdown_bps: null, reputation_score: null, calculation_hash: null, verified: false, published: false,
        live_execution_authorized: false, created_at: new Date('2026-09-01T00:00:00.000Z')
      };
      inserted.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM trader_evidence_collection_runs')) {
      const rows = sql.includes("source_type='SOLANA_RPC'")
        ? inserted.filter((row) => row.source_type === 'SOLANA_RPC')
        : inserted;
      return { rows: rows.slice(0, params[1] ?? rows.length) };
    }
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
assert.equal(collection.source_reference, canonicalReference);
assert.equal(collection.collection_status, 'PENDING_DATA');
assert.equal(collection.reason, 'reconciled_trade_performance_required');
assert.equal(collection.metrics_available, false);
assert.equal(collection.trades_count, null);
assert.equal(collection.total_return_bps, null);
assert.equal(collection.win_rate_bps, null);
assert.equal(collection.drawdown_bps, null);
assert.equal(collection.reputation_score, null);
assert.equal(collection.calculation_hash, null);
assert.equal(collection.verified, false);
assert.equal(collection.published, false);
assert.equal(collection.live_execution_authorized, false);
assert.equal(collection.provenance.signatures_observed, 1);
assert.equal(collection.provenance.newest_signature, signature);
assert.equal(collection.provenance.newest_slot, 123);
assert.equal(collection.provenance.recorded_source_reference, canonicalReference);
assert.equal(collection.provenance.source_reference_policy, 'SOLANA_RPC_SIGNATURE_SLOT');
assert.equal(collection.provenance.rpc_endpoint_label, 'test-rpc');
assert.ok(!JSON.stringify(collection).includes('rpc.example.invalid'), 'RPC URL must not be exposed in provenance');

const listed = await service.listCollections(trader.trader_id, 20);
assert.equal(listed.length, 1);
assert.equal(listed[0].collection_id, collection.collection_id);
assert.equal(listed[0].source_reference, canonicalReference);
assert.equal(listed[0].verified, false);
assert.equal(listed[0].published, false);

const pristine = structuredClone(inserted[0]);
const reconciliationRow = {
  ...pristine,
  collection_id: '22222222-2222-4222-8222-222222222222',
  source_type: 'INTERNAL_RECONCILIATION',
  source_reference: null,
  collection_status: 'RECORDED',
  metrics_available: true,
  trades_count: 2,
  total_return_bps: 50,
  win_rate_bps: 5000,
  drawdown_bps: 25,
  reputation_score: 10,
  calculation_hash: 'a'.repeat(64)
};
inserted.push(reconciliationRow);
const automaticOnly = await service.listCollections(trader.trader_id, 20);
assert.equal(automaticOnly.length, 1, 'automatic listing must exclude INTERNAL_RECONCILIATION rows');
assert.equal(automaticOnly[0].collection_id, pristine.collection_id);
assert.equal(automaticOnly[0].source_type, 'SOLANA_RPC');
inserted.pop();

const unsafeCases = [
  ['metrics_available', true, /automatic_evidence_safety_invariant_violation/],
  ['trades_count', 7, /automatic_evidence_safety_invariant_violation/],
  ['total_return_bps', 123, /automatic_evidence_safety_invariant_violation/],
  ['win_rate_bps', 5000, /automatic_evidence_safety_invariant_violation/],
  ['drawdown_bps', 250, /automatic_evidence_safety_invariant_violation/],
  ['reputation_score', 99, /automatic_evidence_safety_invariant_violation/],
  ['calculation_hash', '0'.repeat(64), /automatic_evidence_safety_invariant_violation/],
  ['verified', true, /automatic_evidence_safety_invariant_violation/],
  ['published', true, /automatic_evidence_safety_invariant_violation/],
  ['live_execution_authorized', true, /automatic_evidence_safety_invariant_violation/],
  ['collection_status', 'VERIFIED', /automatic_evidence_status_invalid/]
];
for (const [field, value, expected] of unsafeCases) {
  inserted[0] = { ...pristine, [field]: value };
  await assert.rejects(() => service.listCollections(trader.trader_id, 20), expected, `must fail closed for ${field}`);
}
inserted[0] = pristine;

assert.throws(() => createSolanaJsonRpcCaller({ rpcUrl: '' }), /solana_rpc_unconfigured/);
assert.throws(() => createSolanaJsonRpcCaller({ rpcUrl: 'file:///tmp/rpc' }), /invalid_solana_rpc_url/);

const nonShadowPool = {
  async query() { return { rows: [{ ...trader, mode: 'LIVE' }] }; }
};
const nonShadowService = createAutomaticEvidenceService(nonShadowPool, { rpcUrl: 'https://rpc.example.invalid', fetchImpl });
await assert.rejects(() => nonShadowService.collectSolana(trader.trader_id), /trader_not_shadow/);

console.log('automatic evidence service regression: PASS');
