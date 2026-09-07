import assert from 'node:assert/strict';
import {
  collectSolanaTransactionFeePayerEvidence,
  verifySolanaTransactionFeePayerEvidence,
} from '../services/api/src/solana-transaction-fee-payer-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never use as production evidence.
const SIG = '1'.repeat(64);
const WALLET_A = '1'.repeat(32);
const WALLET_B = `${'1'.repeat(31)}2`;
const STARTED = '2026-01-01T00:00:10.000Z';
const OBSERVED = '2026-01-01T00:00:12.000Z';
const SLOT = 123456;
const BLOCK_TIME = 1767225611;

function rpcResult({ feePayer = WALLET_A, second = WALLET_B, err = null } = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      slot: SLOT,
      blockTime: BLOCK_TIME,
      meta: { err },
      transaction: {
        signatures: [SIG],
        message: {
          accountKeys: [
            { pubkey: feePayer, signer: true, writable: true, source: 'transaction' },
            { pubkey: second, signer: false, writable: true, source: 'transaction' },
          ],
        },
      },
    },
  };
}

async function collect({ traderWallet = WALLET_A, response = rpcResult(), endpoint = 'synthetic_rpc' } = {}) {
  const calls = [];
  const evidence = await collectSolanaTransactionFeePayerEvidence({
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
  assert.equal(evidence.trader_is_fee_payer, true);
  assert.equal(evidence.fee_payer, WALLET_A);
  assert.equal(evidence.source_reference, `solana_rpc:${SIG}@${SLOT}`);
  for (const field of ['trades_count', 'total_return_bps', 'win_rate_bps', 'drawdown_bps', 'reputation_score']) assert.equal(evidence[field], null);
  assert.equal(verifySolanaTransactionFeePayerEvidence(evidence), true);
}

{
  const { evidence } = await collect({ traderWallet: WALLET_B });
  assert.equal(evidence.trader_is_fee_payer, false);
  assert.equal(evidence.source_reference, null);
  assert.equal(verifySolanaTransactionFeePayerEvidence(evidence), true);
}

{
  const { evidence } = await collect({ response: { jsonrpc: '2.0', id: 1, result: null } });
  assert.equal(evidence.source_reference, null);
  assert.equal(evidence.fee_payer, null);
  assert.equal(evidence.trader_is_fee_payer, false);
  assert.equal(verifySolanaTransactionFeePayerEvidence(evidence), true);
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.provenance.account_keys[0].pubkey = WALLET_B;
  assert.throws(() => verifySolanaTransactionFeePayerEvidence(tampered));
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.provenance.trader_is_fee_payer = false;
  tampered.trader_is_fee_payer = false;
  assert.throws(() => verifySolanaTransactionFeePayerEvidence(tampered));
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.source_reference = null;
  assert.throws(() => verifySolanaTransactionFeePayerEvidence(tampered));
}

{
  const { evidence } = await collect();
  const tampered = structuredClone(evidence);
  tampered.trades_count = 1;
  assert.throws(() => verifySolanaTransactionFeePayerEvidence(tampered));
}

await assert.rejects(() => collect({ endpoint: 'https://rpc.example/?api-key=TEST_ONLY' }));

await assert.rejects(() => collect({
  response: rpcResult({ feePayer: WALLET_A, second: WALLET_A }),
}));

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

console.log('Solana transaction fee payer evidence regression: PASS (SYNTHETIC / TEST-ONLY)');
