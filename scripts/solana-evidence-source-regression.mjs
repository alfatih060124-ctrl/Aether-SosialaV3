import assert from 'node:assert/strict';
import { collectSolanaRpcEvidence, buildSolanaRpcProvenance } from '../services/api/src/solana-evidence-source.mjs';

const wallet = '11111111111111111111111111111111';
const signature = '5'.repeat(64);
const calls = [];
const result = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  endpointLabel: 'synthetic-rpc-test-only',
  rpcCall: async (method, params) => {
    calls.push({ method, params });
    return [{ signature, slot: 123, blockTime: 1788190000, err: null }];
  }
});
assert.equal(calls[0].method, 'getSignaturesForAddress');
assert.equal(result.verification_status, 'PENDING_DATA');
assert.equal(result.verified, false);
assert.equal(result.published, false);
assert.equal(result.evidence_status, 'NOT_RECORDED');
assert.equal(result.reason, 'reconciled_trade_performance_required');
assert.equal(result.source_reference, signature);
assert.equal('trades_count' in result, false);
assert.equal('total_return_bps' in result, false);
assert.equal('win_rate_bps' in result, false);
assert.equal('drawdown_bps' in result, false);
assert.equal('reputation_score' in result, false);
assert.match(result.provenance.source_hash, /^[a-f0-9]{64}$/);

const empty = await collectSolanaRpcEvidence({ walletAddress: wallet, rpcCall: async () => [] });
assert.equal(empty.reason, 'no_verifiable_chain_activity');
assert.equal(empty.source_reference, null);
assert.throws(() => buildSolanaRpcProvenance({ walletAddress: 'bad', signatures: [] }), /invalid_solana_wallet/);
console.log('solana evidence source regression: PASS');
