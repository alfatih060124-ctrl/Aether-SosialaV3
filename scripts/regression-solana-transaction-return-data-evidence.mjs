import assert from 'node:assert/strict';
import { collectSolanaTransactionReturnDataEvidence, verifySolanaTransactionReturnDataEvidence } from '../services/api/src/solana-transaction-return-data-evidence.mjs';

const SIGNATURE = '1'.repeat(64);
const OTHER_SIGNATURE = `${'1'.repeat(63)}2`;
const WALLET = '1'.repeat(32);
const OTHER_WALLET = `${'1'.repeat(31)}2`;
const PROGRAM = OTHER_WALLET;
const START = '2026-09-03T06:00:00.000Z';
const OBSERVED = '2026-09-03T06:00:02.000Z';

function rpcResult(overrides = {}) {
  return {
    jsonrpc: '2.0',
    result: {
      slot: 123,
      blockTime: 1788415201,
      transaction: { signatures: [SIGNATURE], message: { accountKeys: [{ pubkey: WALLET }] } },
      meta: { err: null, returnData: { programId: PROGRAM, data: [Buffer.from('synthetic-test-only').toString('base64'), 'base64'] } },
      ...overrides,
    },
  };
}

async function collect(response) {
  return collectSolanaTransactionReturnDataEvidence({
    rpcRequest: async (method, params) => { assert.equal(method, 'getTransaction'); assert.equal(params[0], SIGNATURE); return response; },
    signature: SIGNATURE,
    traderWallet: WALLET,
    rpcEndpointLabel: 'synthetic-test-rpc',
    requestStartedAt: START,
    observedAt: OBSERVED,
  });
}

const evidence = await collect(rpcResult());
assert.equal(evidence.collection_status, 'PENDING_DATA');
assert.equal(evidence.verified, false);
assert.equal(evidence.published, false);
assert.equal(evidence.metrics_available, false);
for (const key of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) assert.equal(evidence[key], null);
assert.equal(evidence.source_reference, `${'solana_rpc:' + SIGNATURE}@123`);
assert.equal(evidence.return_data.program_id, PROGRAM);
assert.equal(verifySolanaTransactionReturnDataEvidence(evidence), true);

const noReturn = await collect(rpcResult({ meta: { err: null, returnData: null } }));
assert.equal(noReturn.source_reference, null);
assert.equal(noReturn.return_data, null);
assert.equal(verifySolanaTransactionReturnDataEvidence(noReturn), true);

const notFound = await collect({ jsonrpc: '2.0', result: null });
assert.equal(notFound.source_reference, null);
assert.equal(notFound.return_data, null);
assert.equal(verifySolanaTransactionReturnDataEvidence(notFound), true);

const tampered = structuredClone(evidence);
tampered.provenance.return_data.data_base64 = Buffer.from('tampered').toString('base64');
assert.throws(() => verifySolanaTransactionReturnDataEvidence(tampered), /return data mismatch|provenance hash mismatch/);

const metricInjected = structuredClone(evidence);
metricInjected.win_rate_bps = 9000;
assert.throws(() => verifySolanaTransactionReturnDataEvidence(metricInjected), /win_rate_bps must remain null/);

await assert.rejects(() => collect(rpcResult({ transaction: { signatures: [OTHER_SIGNATURE], message: { accountKeys: [{ pubkey: WALLET }] } } })), /returned primary signature/);
await assert.rejects(() => collect(rpcResult({ transaction: { signatures: [SIGNATURE], message: { accountKeys: [{ pubkey: OTHER_WALLET }] } } })), /requested trader wallet must participate/);
await assert.rejects(() => collect(rpcResult({ meta: { err: 'bad', returnData: null } })), /transaction err/);
await assert.rejects(() => collect(rpcResult({ meta: { err: null, returnData: { programId: PROGRAM, data: ['%%%not-base64%%%', 'base64'] } } })), /base64/);
await assert.rejects(() => collect(rpcResult({ meta: { err: null, returnData: { programId: PROGRAM, data: [Buffer.from('x').toString('base64'), 'utf8'] } } })), /returnData.data/);
await assert.rejects(() => collect(rpcResult({ blockTime: 2000000000 })), /blockTime cannot be after observedAt/);

await assert.rejects(() => collectSolanaTransactionReturnDataEvidence({ rpcRequest: async () => rpcResult(), signature: SIGNATURE, traderWallet: WALLET, rpcEndpointLabel: 'https://secret.example', requestStartedAt: START, observedAt: OBSERVED }), /opaque and credential-free/);

console.log('Solana transaction return-data evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
