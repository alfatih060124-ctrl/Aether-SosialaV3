import assert from 'node:assert/strict';
import {
  collectSolanaTransactionCostEvidence,
  verifySolanaTransactionCostEvidence,
} from '../services/api/src/solana-transaction-cost-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never use as production evidence.
const SIG = '1'.repeat(64);
const WALLET = '1'.repeat(32);
const OTHER = `${'1'.repeat(31)}2`;
const STARTED = '2026-01-01T00:00:10.000Z';
const OBSERVED = '2026-01-01T00:00:12.000Z';
const SLOT = 123456;
const BLOCK_TIME = 1767225611;

function rpcResult({ fee = 5000, computeUnitsConsumed = 12345, err = null, accountKeys = [WALLET, OTHER] } = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      slot: SLOT,
      blockTime: BLOCK_TIME,
      meta: { err, fee, computeUnitsConsumed },
      transaction: {
        signatures: [SIG],
        message: { accountKeys },
      },
    },
  };
}

async function collect({ response = rpcResult(), endpoint = 'synthetic_rpc', traderWallet = WALLET } = {}) {
  const calls = [];
  const evidence = await collectSolanaTransactionCostEvidence({
    rpcRequest: async (method, params) => { calls.push({ method, params }); return response; },
    signature: SIG,
    traderWallet,
    rpcEndpointLabel: endpoint,
    commitment: 'confirmed',
    requestStartedAt: STARTED,
    observedAt: OBSERVED,
  });
  return { evidence, calls };
}

{
  const { evidence, calls } = await collect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'getTransaction');
  assert.deepEqual(calls[0].params, [SIG, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  assert.equal(evidence.collection_status, 'PENDING_DATA');
  assert.equal(evidence.metrics_available, false);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.published, false);
  assert.equal(evidence.live_execution_authorized, false);
  assert.equal(evidence.reconciliation_required, true);
  assert.equal(evidence.fee_lamports, 5000);
  assert.equal(evidence.compute_units_consumed, 12345);
  assert.equal(evidence.source_reference, `solana_rpc:${SIG}@${SLOT}`);
  for (const field of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) assert.equal(evidence[field], null);
  assert.equal(verifySolanaTransactionCostEvidence(evidence), true);
}

{
  const { evidence } = await collect({ response: rpcResult({ computeUnitsConsumed: null }) });
  assert.equal(evidence.compute_units_consumed, null);
  assert.equal(verifySolanaTransactionCostEvidence(evidence), true);
}

{
  const { evidence } = await collect({ response: { jsonrpc: '2.0', id: 1, result: null } });
  assert.equal(evidence.source_reference, null);
  assert.equal(evidence.fee_lamports, null);
  assert.equal(evidence.compute_units_consumed, null);
  assert.equal(verifySolanaTransactionCostEvidence(evidence), true);
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.provenance.fee_lamports = 1;
  assert.throws(() => verifySolanaTransactionCostEvidence(tampered));
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.provenance.transaction_err = 'synthetic-error';
  tampered.source_hash = await import('node:crypto').then(({ default: crypto }) => {
    const canonical = (value) => {
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
      if (typeof value === 'number') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    };
    return crypto.createHash('sha256').update(canonical(tampered.provenance)).digest('hex');
  });
  assert.throws(() => verifySolanaTransactionCostEvidence(tampered), /transaction_err/);
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.trades_count = 1;
  assert.throws(() => verifySolanaTransactionCostEvidence(tampered));
}

await assert.rejects(() => collect({ endpoint: 'https://rpc.example/?api-key=TEST_ONLY' }));
await assert.rejects(() => collect({ traderWallet: `${'1'.repeat(30)}23` }));
await assert.rejects(() => collect({ response: rpcResult({ fee: Number.MAX_SAFE_INTEGER + 1 }) }));
await assert.rejects(() => collect({ response: rpcResult({ computeUnitsConsumed: Number.MAX_SAFE_INTEGER + 1 }) }));
await assert.rejects(() => collect({ response: rpcResult({ accountKeys: [OTHER] }) }));
await assert.rejects(() => collect({ response: rpcResult({ accountKeys: [WALLET, WALLET] }) }));
await assert.rejects(() => collect({
  response: {
    ...rpcResult(),
    result: { ...rpcResult().result, blockTime: Math.floor(Date.parse(OBSERVED) / 1000) + 1 },
  },
}));
await assert.rejects(() => collect({
  response: {
    ...rpcResult(),
    result: {
      ...rpcResult().result,
      transaction: { ...rpcResult().result.transaction, signatures: [`${'1'.repeat(63)}2`] },
    },
  },
}));

console.log('Solana transaction cost evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
