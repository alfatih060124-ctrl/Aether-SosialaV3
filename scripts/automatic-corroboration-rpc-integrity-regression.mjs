import assert from 'node:assert/strict';
import { corroborateAutomaticEvidence } from '../services/api/src/automatic-evidence-corroboration.mjs';
import { collectSolscanTransactionDetailEvidence } from '../services/api/src/solscan-transaction-detail-evidence.mjs';

// SYNTHETIC / TEST-ONLY. This fixture deliberately models a tampered persisted RPC row.
const SIGNATURE = '1'.repeat(64);
const WALLET = '1'.repeat(32);
const SLOT = 123456;
const sourceReference = `solana_rpc:${SIGNATURE}@${SLOT}`;

const solscanEvidence = await collectSolscanTransactionDetailEvidence({
  transactionSignature: SIGNATURE,
  traderWallet: WALLET,
  requestedAt: '2026-01-01T23:59:59.000Z',
  observedAt: '2026-01-02T00:00:00.000Z',
  query: async () => ({
    success: true,
    data: {
      block_id: SLOT,
      block_time: 1767311990,
      fee: 5000,
      status: 1,
      signer: [WALLET],
      programs_involved: [],
      sol_bal_change: [],
      token_bal_change: [],
    },
  }),
});

const forgedRpcEvidence = {
  source_type: 'SOLANA_RPC',
  source_reference: sourceReference,
  collection_status: 'PENDING_DATA',
  metrics_available: false,
  trades_count: null,
  total_return_bps: null,
  win_rate_bps: null,
  drawdown_bps: null,
  reputation_score: null,
  calculation_hash: null,
  verified: false,
  published: false,
  live_execution_authorized: false,
  provenance: {
    newest_signature: SIGNATURE,
    newest_slot: SLOT,
    recorded_source_reference: sourceReference,
    source_reference_policy: 'SOLANA_RPC_SIGNATURE_SLOT',
    // Well-shaped but untrusted/tampered value: corroboration must not accept format alone as integrity proof.
    source_hash: 'b'.repeat(64),
  },
};

assert.throws(
  () => corroborateAutomaticEvidence({
    rpcEvidence: forgedRpcEvidence,
    solscanEvidence,
    observedAt: '2026-01-02T00:00:01.000Z',
  }),
  error => error?.code === 'rpc_evidence_verification_failed' || error?.code === 'rpc_evidence_integrity_invalid',
  'cross-source corroboration must independently verify persisted RPC evidence integrity before accepting it',
);

console.log('automatic corroboration RPC integrity regression: ok');
