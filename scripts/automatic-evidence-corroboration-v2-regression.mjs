import assert from 'node:assert/strict';
import { collectSolanaRpcEvidence, verifySolanaRpcProvenance } from '../services/api/src/solana-evidence-source.mjs';
import { collectSolscanTransactionDetailEvidence } from '../services/api/src/solscan-transaction-detail-evidence.mjs';
import { corroborateAutomaticEvidenceV2, verifyAutomaticEvidenceCorroborationV2 } from '../services/api/src/automatic-evidence-corroboration-v2.mjs';

// SYNTHETIC / TEST-ONLY FIXTURES. NEVER USE THESE IDENTIFIERS AS PRODUCTION EVIDENCE.
const SIGNATURE = '1'.repeat(64);
const OTHER_SIGNATURE = `${'1'.repeat(63)}2`;
const WALLET = '1'.repeat(32);
const SLOT = 123456;
const OBSERVED_AT = '2026-01-02T00:00:00.000Z';
const CORROBORATED_AT = '2026-01-02T00:00:01.000Z';

async function rpcEvidence() {
  const collected = await collectSolanaRpcEvidence({
    walletAddress: WALLET,
    limit: 10,
    maxPages: 1,
    endpointLabel: 'synthetic-test-rpc',
    commitment: 'finalized',
    rpcCall: async (method, params) => {
      assert.equal(method, 'getSignaturesForAddress');
      assert.equal(params[0], WALLET);
      return [{ signature: SIGNATURE, slot: SLOT, blockTime: 1767311990, err: null, confirmationStatus: 'finalized' }];
    }
  });
  assert.equal(verifySolanaRpcProvenance(collected.provenance), true);
  const source_reference = `solana_rpc:${SIGNATURE}@${SLOT}`;
  return {
    ...collected,
    source_reference,
    provenance: {
      ...collected.provenance,
      recorded_source_reference: source_reference,
      source_reference_policy: 'SOLANA_RPC_SIGNATURE_SLOT'
    }
  };
}

async function solscanEvidence() {
  return collectSolscanTransactionDetailEvidence({
    transactionSignature: SIGNATURE,
    traderWallet: WALLET,
    requestedAt: '2026-01-01T23:59:59.000Z',
    observedAt: OBSERVED_AT,
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
        token_bal_change: []
      }
    })
  });
}

async function rejects(code, mutateRpc, mutateSolscan, observedAt = CORROBORATED_AT) {
  const rpc = await rpcEvidence();
  const solscan = await solscanEvidence();
  if (mutateRpc) mutateRpc(rpc);
  if (mutateSolscan) mutateSolscan(solscan);
  assert.throws(() => corroborateAutomaticEvidenceV2({ rpcEvidence: rpc, solscanEvidence: solscan, observedAt }), e => e?.code === code);
}

const rpc = await rpcEvidence();
const solscan = await solscanEvidence();
const receipt = corroborateAutomaticEvidenceV2({ rpcEvidence: rpc, solscanEvidence: solscan, observedAt: CORROBORATED_AT });
assert.equal(receipt.schema, 'aether.automatic_evidence.cross_source_corroboration.v2');
assert.equal(receipt.source_type, 'INTERNAL_RECONCILIATION');
assert.equal(receipt.source_reference, null);
assert.equal(receipt.collection_status, 'PENDING_DATA');
assert.equal(receipt.metrics_available, false);
for (const metric of ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score']) assert.equal(receipt[metric], null);
assert.equal(receipt.calculation_hash, null);
assert.equal(receipt.verified, false);
assert.equal(receipt.published, false);
assert.equal(receipt.live_execution_authorized, false);
assert.equal(receipt.reconciliation_required, true);
assert.equal(receipt.corroborated_signature, SIGNATURE);
assert.equal(receipt.corroborated_slot, SLOT);
assert.equal(receipt.provenance.rpc_source_reference, `solana_rpc:${SIGNATURE}@${SLOT}`);
assert.equal(receipt.provenance.solscan_source_reference, `solscan:transaction:${SIGNATURE}@${SLOT}`);
assert.equal(receipt.provenance.rpc_upstream_source_hash, rpc.provenance.source_hash);
assert.match(receipt.provenance_hash, /^[0-9a-f]{64}$/);
assert.equal(verifyAutomaticEvidenceCorroborationV2(receipt), true);

await rejects('rpc_provenance_verification_failed', rpcEvidence => { rpcEvidence.provenance.source_hash = 'a'.repeat(64); });
await rejects('rpc_provenance_verification_failed', rpcEvidence => { rpcEvidence.provenance.signature_rows[0].slot = SLOT + 10; });
await rejects('rpc_provenance_verification_failed', rpcEvidence => { rpcEvidence.provenance.signatures_observed = 999; });
await rejects('rpc_provenance_verification_failed', rpcEvidence => { delete rpcEvidence.provenance.signature_rows; });
await rejects('rpc_provenance_binding_invalid', rpcEvidence => { rpcEvidence.provenance.recorded_source_reference = `solana_rpc:${SIGNATURE}@1`; });
await rejects('cross_source_signature_mismatch', rpcEvidence => {
  rpcEvidence.source_reference = `solana_rpc:${OTHER_SIGNATURE}@${SLOT}`;
  rpcEvidence.provenance.newest_signature = OTHER_SIGNATURE;
  rpcEvidence.provenance.recorded_source_reference = rpcEvidence.source_reference;
});
await rejects('unsafe_rpc_evidence', rpcEvidence => { rpcEvidence.trades_count = 1; });
await rejects('unsafe_rpc_evidence', rpcEvidence => { rpcEvidence.verified = true; });
await rejects('unsafe_rpc_evidence', rpcEvidence => { rpcEvidence.published = true; });
await rejects('unsafe_rpc_evidence', rpcEvidence => { rpcEvidence.live_execution_authorized = true; });
await rejects('unsafe_solscan_evidence', null, evidence => { evidence.total_return_bps = 42; });
await rejects('solscan_evidence_verification_failed', null, evidence => { evidence.row.slot += 1; });
await rejects('invalid_corroboration_chronology', null, null, '2026-01-01T23:59:58.000Z');

for (const mutate of [
  x => { x.source_reference = 'solana_rpc:forged@1'; },
  x => { x.corroborated_slot += 1; },
  x => { x.metrics_available = true; },
  x => { x.trades_count = 1; },
  x => { x.verified = true; },
  x => { x.published = true; },
  x => { x.live_execution_authorized = true; },
  x => { x.provenance.rpc_upstream_source_hash = '0'.repeat(64); },
  x => { x.provenance_hash = '0'.repeat(64); }
]) {
  const tampered = structuredClone(receipt);
  mutate(tampered);
  assert.equal(verifyAutomaticEvidenceCorroborationV2(tampered), false);
}

console.log('automatic evidence cross-source corroboration v2 regression: ok');
