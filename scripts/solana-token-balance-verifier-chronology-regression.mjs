import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  collectSolanaTokenBalanceEvidence,
  verifySolanaTokenBalanceEvidence
} from '../services/api/src/solana-token-balance-evidence-source.mjs';

// SYNTHETIC / TEST-ONLY fixtures. No production wallet, signature, key, or secret material.
const signature = '1'.repeat(64);
const wallet = '1'.repeat(32);
const mint = '2'.repeat(44);
let tick = 0;
const times = ['2026-09-02T22:00:00.000Z', '2026-09-02T22:00:00.100Z'];

const evidence = await collectSolanaTokenBalanceEvidence({
  signature,
  walletAddress: wallet,
  endpointLabel: 'test-rpc',
  rpcCall: async () => ({
    slot: 222222,
    blockTime: 1788360000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 2, mint, owner: wallet, uiTokenAmount: { decimals: 6, amount: '2' } }],
      postTokenBalances: [{ accountIndex: 2, mint, owner: wallet, uiTokenAmount: { decimals: 6, amount: '1' } }]
    },
    transaction: { signatures: [signature] }
  }),
  clock: () => times[Math.min(tick++, times.length - 1)]
});

assert.equal(verifySolanaTokenBalanceEvidence(evidence), true);

const impossible = structuredClone(evidence);
impossible.provenance.block_time = Math.floor(Date.parse(impossible.provenance.observed_at) / 1000) + 1;
const payload = structuredClone(impossible.provenance);
delete payload.source_hash;
impossible.provenance.source_hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
assert.equal(
  verifySolanaTokenBalanceEvidence(impossible),
  false,
  'verifier must reject self-consistent evidence observed before its claimed block time'
);

assert.equal(impossible.verified, false);
assert.equal(impossible.published, false);
assert.equal(impossible.live_execution_authorized, false);

console.log('solana token balance verifier chronology regression: ok');
