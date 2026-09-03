import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  collectSolanaTransactionInnerInstructionEvidence,
  verifySolanaTransactionInnerInstructionEvidence,
} from '../services/api/src/solana-transaction-inner-instruction-evidence.mjs';

const SIGNATURE = '6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbhiKjrKokLb9o111kxTD5KkPVd7UBSCcFcnWFkrJ82Hu6';
const WALLET = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const PROGRAM = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const STARTED = '2026-09-03T00:00:00.000Z';
const OBSERVED = '2026-09-03T00:00:10.000Z';

const fetchFn = async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.method, 'getTransaction');
  assert.equal(request.params[0], SIGNATURE);
  return {
    ok: true,
    async json() {
      return {
        jsonrpc: '2.0',
        id: 1,
        result: {
          slot: 123456789,
          blockTime: 1788393605,
          transaction: {
            signatures: [SIGNATURE],
            message: {
              accountKeys: [WALLET, PROGRAM],
              instructions: [{ programIdIndex: 1, accounts: [0], data: '2' }],
            },
          },
          meta: {
            err: null,
            loadedAddresses: { writable: [], readonly: [] },
            innerInstructions: [
              { index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: '2', stackHeight: 2 }] },
            ],
          },
        },
      };
    },
  };
};

const evidence = await collectSolanaTransactionInnerInstructionEvidence({
  rpc_url: 'https://synthetic.invalid',
  rpc_endpoint_label: 'synthetic-test-only',
  signature: SIGNATURE,
  trader_wallet: WALLET,
  commitment: 'confirmed',
  request_started_at: STARTED,
  observed_at: OBSERVED,
  fetch_fn: fetchFn,
});

assert.equal(verifySolanaTransactionInnerInstructionEvidence(evidence), true);

// TEST-ONLY self-consistent provenance rewrite: the transaction has exactly one
// outer instruction, so any inner group outer_index > 0 is impossible. The
// independent verifier must reject this even when source_hash is recomputed.
const tampered = structuredClone(evidence);
tampered.provenance.inner_topology[0].outer_index = 999;
tampered.source_hash = createHash('sha256')
  .update(JSON.stringify(tampered.provenance))
  .digest('hex');

assert.equal(
  verifySolanaTransactionInnerInstructionEvidence(tampered),
  false,
  'verifier must bind inner outer_index to the original outer instruction count',
);

console.log('solana inner instruction outer-index binding regression: PASS');
