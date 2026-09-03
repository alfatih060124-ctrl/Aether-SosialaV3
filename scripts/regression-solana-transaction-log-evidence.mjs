import assert from 'node:assert/strict';
import { collectSolanaTransactionLogEvidence, verifySolanaTransactionLogEvidence } from '../services/api/src/solana-transaction-log-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never use as production evidence.
const SIG = '1'.repeat(64);
const WALLET = '1'.repeat(32);
const OTHER = `${'1'.repeat(31)}2`;
const STARTED = '2026-01-01T00:00:10.000Z';
const OBSERVED = '2026-01-01T00:00:12.000Z';
const SLOT = 123456;
const BLOCK_TIME = 1767225611;
const LOGS = ['Program 11111111111111111111111111111111 invoke [1]', 'Program log: synthetic-test-only', 'Program 11111111111111111111111111111111 success'];

function rpcResult({ err = null, logMessages = LOGS, accountKeys = [WALLET, OTHER] } = {}) {
  return { jsonrpc: '2.0', id: 1, result: { slot: SLOT, blockTime: BLOCK_TIME, meta: { err, logMessages }, transaction: { signatures: [SIG], message: { accountKeys } } } };
}
async function collect({ response = rpcResult(), endpoint = 'synthetic_rpc', traderWallet = WALLET } = {}) {
  const calls = [];
  const evidence = await collectSolanaTransactionLogEvidence({ rpcRequest: async (method, params) => { calls.push({ method, params }); return response; }, signature: SIG, traderWallet, rpcEndpointLabel: endpoint, commitment: 'confirmed', requestStartedAt: STARTED, observedAt: OBSERVED });
  return { evidence, calls };
}

{
  const { evidence, calls } = await collect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'getTransaction');
  assert.deepEqual(calls[0].params, [SIG, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  assert.deepEqual(evidence.log_messages, LOGS);
  assert.equal(typeof evidence.log_messages_sha256, 'string');
  assert.equal(evidence.source_reference, `solana_rpc:${SIG}@${SLOT}`);
  assert.equal(evidence.collection_status, 'PENDING_DATA');
  assert.equal(evidence.metrics_available, false);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.published, false);
  assert.equal(evidence.live_execution_authorized, false);
  for (const field of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) assert.equal(evidence[field], null);
  assert.equal(verifySolanaTransactionLogEvidence(evidence), true);
}

{
  const { evidence } = await collect({ response: rpcResult({ logMessages: null }) });
  assert.equal(evidence.log_messages, null);
  assert.equal(evidence.log_messages_sha256, null);
  assert.equal(verifySolanaTransactionLogEvidence(evidence), true);
}

{
  const { evidence } = await collect({ response: { jsonrpc: '2.0', id: 1, result: null } });
  assert.equal(evidence.source_reference, null);
  assert.equal(evidence.log_messages, null);
  assert.equal(verifySolanaTransactionLogEvidence(evidence), true);
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence); tampered.provenance.log_messages[1] = 'Program log: tampered';
  assert.throws(() => verifySolanaTransactionLogEvidence(tampered));
}
{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence); tampered.trades_count = 1;
  assert.throws(() => verifySolanaTransactionLogEvidence(tampered));
}

await assert.rejects(() => collect({ endpoint: 'https://rpc.example/?api-key=TEST_ONLY' }));
await assert.rejects(() => collect({ traderWallet: `${'1'.repeat(30)}23` }));
await assert.rejects(() => collect({ response: rpcResult({ accountKeys: [OTHER] }) }));
await assert.rejects(() => collect({ response: rpcResult({ accountKeys: [WALLET, WALLET] }) }));
await assert.rejects(() => collect({ response: { ...rpcResult(), result: { ...rpcResult().result, meta: { logMessages: LOGS } } } }), /meta.err is required/);
await assert.rejects(() => collect({ response: { ...rpcResult(), result: { ...rpcResult().result, meta: { err: null } } } }), /meta.logMessages is required/);
await assert.rejects(() => collect({ response: rpcResult({ err: 'synthetic-error' }) }));
await assert.rejects(() => collect({ response: rpcResult({ logMessages: [123] }) }));
await assert.rejects(() => collect({ response: rpcResult({ logMessages: ['x'.repeat(8193)] }) }));
await assert.rejects(() => collect({ response: { ...rpcResult(), result: { ...rpcResult().result, blockTime: Math.floor(Date.parse(OBSERVED) / 1000) + 1 } } }));
await assert.rejects(() => collect({ response: { ...rpcResult(), result: { ...rpcResult().result, transaction: { ...rpcResult().result.transaction, signatures: [`${'1'.repeat(63)}2`] } } } }));

console.log('Solana transaction log evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
