import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  collectSolanaTransactionFeePayerEvidence,
  verifySolanaTransactionFeePayerEvidence,
} from '../services/api/src/solana-transaction-fee-payer-evidence.mjs';

// SYNTHETIC / TEST-ONLY identifiers. Never use as production evidence.
const SIG = '1'.repeat(64);
const WALLET = '1'.repeat(32);
const OTHER = `${'1'.repeat(31)}2`;

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sourceHash(provenance) {
  return crypto.createHash('sha256').update(canonicalJson(provenance)).digest('hex');
}

const evidence = await collectSolanaTransactionFeePayerEvidence({
  rpcRequest: async () => ({
    jsonrpc: '2.0',
    id: 1,
    result: {
      slot: 123456,
      blockTime: 1767225611,
      meta: { err: null },
      transaction: {
        signatures: [SIG],
        message: {
          accountKeys: [
            { pubkey: WALLET, signer: true, writable: true, source: 'transaction' },
            { pubkey: OTHER, signer: false, writable: true, source: 'transaction' },
          ],
        },
      },
    },
  }),
  signature: SIG,
  traderWallet: WALLET,
  rpcEndpointLabel: 'synthetic_rpc',
  commitment: 'confirmed',
  requestStartedAt: '2026-01-01T00:00:10.000Z',
  observedAt: '2026-01-01T00:00:12.000Z',
});

assert.equal(verifySolanaTransactionFeePayerEvidence(evidence), true);

for (const invalidErr of ['TEST_ONLY_ERROR', 1, false, []]) {
  const tampered = structuredClone(evidence);
  tampered.provenance.transaction_err = invalidErr;
  tampered.source_hash = sourceHash(tampered.provenance);
  assert.throws(
    () => verifySolanaTransactionFeePayerEvidence(tampered),
    undefined,
    `verifier must reject non-object transaction_err: ${JSON.stringify(invalidErr)}`,
  );
}

const notFound = await collectSolanaTransactionFeePayerEvidence({
  rpcRequest: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
  signature: SIG,
  traderWallet: WALLET,
  rpcEndpointLabel: 'synthetic_rpc',
  commitment: 'confirmed',
  requestStartedAt: '2026-01-01T00:00:10.000Z',
  observedAt: '2026-01-01T00:00:12.000Z',
});
const tamperedNotFound = structuredClone(notFound);
tamperedNotFound.provenance.transaction_err = { TEST_ONLY: true };
tamperedNotFound.source_hash = sourceHash(tamperedNotFound.provenance);
assert.throws(
  () => verifySolanaTransactionFeePayerEvidence(tamperedNotFound),
  undefined,
  'not-found provenance must keep transaction_err null',
);

console.log('Solana fee payer transaction_err verifier contract regression: PASS (SYNTHETIC / TEST-ONLY)');
