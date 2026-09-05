import assert from 'node:assert/strict';
import { buildSolanaRpcProvenance, collectSolanaRpcEvidence } from '../services/api/src/solana-evidence-source.mjs';

// Synthetic/test-only fixtures. These values are not production wallets, signatures, or trader performance.
const wallet = '11111111111111111111111111111111';
const signature = '5'.repeat(87);
const finalizedRow = {
  signature,
  slot: 300,
  blockTime: 1788190200,
  err: null,
  confirmationStatus: 'finalized'
};

const confirmedQuery = buildSolanaRpcProvenance({
  walletAddress: wallet,
  commitment: 'confirmed',
  signatures: [finalizedRow]
});
assert.equal(confirmedQuery.schema_version, 9);
assert.equal(confirmedQuery.rpc_commitment, 'confirmed');
assert.equal(confirmedQuery.signatures_observed, 1);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  commitment: 'finalized',
  signatures: [{ ...finalizedRow, confirmationStatus: 'confirmed' }]
}), /rpc_confirmation_below_commitment/);

assert.throws(() => buildSolanaRpcProvenance({
  walletAddress: wallet,
  commitment: 'confirmed',
  signatures: [{ ...finalizedRow, confirmationStatus: 'processed' }]
}), /rpc_confirmation_below_commitment/);

await assert.rejects(
  collectSolanaRpcEvidence({
    walletAddress: wallet,
    commitment: 'finalized',
    rpcCall: async () => [{ ...finalizedRow, confirmationStatus: 'confirmed' }]
  }),
  /rpc_confirmation_below_commitment/
);

const pending = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  commitment: 'finalized',
  endpointLabel: 'synthetic-rpc-finality-test-only',
  rpcCall: async () => [finalizedRow]
});
assert.equal(pending.verification_status, 'PENDING_DATA');
assert.equal(pending.verified, false);
assert.equal(pending.published, false);
assert.equal(pending.reason, 'reconciled_trade_performance_required');
assert.equal('trades_count' in pending, false);
assert.equal('total_return_bps' in pending, false);
assert.equal('win_rate_bps' in pending, false);
assert.equal('drawdown_bps' in pending, false);
assert.equal('reputation_score' in pending, false);

console.log('solana rpc finality regression: PASS');
