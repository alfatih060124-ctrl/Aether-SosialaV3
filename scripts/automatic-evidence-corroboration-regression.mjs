import assert from 'node:assert/strict';
import { corroborateAutomaticEvidence, verifyAutomaticEvidenceCorroboration } from '../services/api/src/automatic-evidence-corroboration.mjs';
import { collectSolscanTransactionDetailEvidence } from '../services/api/src/solscan-transaction-detail-evidence.mjs';

// SYNTHETIC / TEST-ONLY FIXTURES. NEVER USE THESE IDENTIFIERS AS PRODUCTION EVIDENCE.
const SIGNATURE = '1'.repeat(64);
const OTHER_SIGNATURE = '2'.repeat(64);
const WALLET = '1'.repeat(32);
const SLOT = 123456;
const OBSERVED_AT = '2026-01-02T00:00:00.000Z';
const CORROBORATED_AT = '2026-01-02T00:00:01.000Z';

function rpcEvidence(overrides = {}) {
  const source_reference = `solana_rpc:${SIGNATURE}@${SLOT}`;
  return {
    source_type: 'SOLANA_RPC', source_reference, collection_status: 'PENDING_DATA', metrics_available: false,
    trades_count: null, total_return_bps: null, win_rate_bps: null, drawdown_bps: null, reputation_score: null,
    calculation_hash: null, verified: false, published: false, live_execution_authorized: false,
    provenance: {
      newest_signature: SIGNATURE, newest_slot: SLOT, recorded_source_reference: source_reference,
      source_reference_policy: 'SOLANA_RPC_SIGNATURE_SLOT', source_hash: 'a'.repeat(64),
    },
    ...overrides,
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
        token_bal_change: [],
      },
    }),
  });
}

async function rejects(code, mutateRpc, mutateSolscan, observedAt = CORROBORATED_AT) {
  const rpc = rpcEvidence();
  const solscan = await solscanEvidence();
  if (mutateRpc) mutateRpc(rpc);
  if (mutateSolscan) mutateSolscan(solscan);
  assert.throws(() => corroborateAutomaticEvidence({ rpcEvidence: rpc, solscanEvidence: solscan, observedAt }), e => e?.code === code);
}

const solscan = await solscanEvidence();
const receipt = corroborateAutomaticEvidence({ rpcEvidence: rpcEvidence(), solscanEvidence: solscan, observedAt: CORROBORATED_AT });
assert.equal(receipt.schema, 'aether.automatic_evidence.cross_source_corroboration.v1');
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
assert.match(receipt.provenance_hash, /^[0-9a-f]{64}$/);
assert.equal(verifyAutomaticEvidenceCorroboration(receipt), true);
assert.deepEqual(corroborateAutomaticEvidence({ rpcEvidence: rpcEvidence(), solscanEvidence: solscan, observedAt: CORROBORATED_AT }), receipt);

await rejects('cross_source_signature_mismatch', rpc => {
  rpc.source_reference = `solana_rpc:${OTHER_SIGNATURE}@${SLOT}`;
  rpc.provenance.newest_signature = OTHER_SIGNATURE;
  rpc.provenance.recorded_source_reference = rpc.source_reference;
});
await rejects('cross_source_slot_mismatch', rpc => {
  rpc.source_reference = `solana_rpc:${SIGNATURE}@${SLOT + 1}`;
  rpc.provenance.newest_slot = SLOT + 1;
  rpc.provenance.recorded_source_reference = rpc.source_reference;
});
await rejects('unsafe_rpc_evidence', rpc => { rpc.trades_count = 1; });
await rejects('unsafe_rpc_evidence', rpc => { rpc.verified = true; });
await rejects('unsafe_rpc_evidence', rpc => { rpc.published = true; });
await rejects('unsafe_rpc_evidence', rpc => { rpc.live_execution_authorized = true; });
await rejects('rpc_provenance_binding_invalid', rpc => { rpc.provenance.recorded_source_reference = `solana_rpc:${SIGNATURE}@1`; });
await rejects('unsafe_solscan_evidence', null, evidence => { evidence.total_return_bps = 42; });
await rejects('unsafe_solscan_evidence', null, evidence => { evidence.verified = true; });
await rejects('solscan_row_binding_invalid', null, evidence => { evidence.row.slot += 1; });
await rejects('invalid_solscan_source_hash', null, evidence => { evidence.source_hash = 'not-a-hash'; });
await rejects('invalid_corroboration_chronology', null, null, '2026-01-01T23:59:58.000Z');

for (const mutate of [
  x => { x.source_reference = 'solana_rpc:forged@1'; },
  x => { x.corroborated_slot += 1; },
  x => { x.metrics_available = true; },
  x => { x.trades_count = 1; },
  x => { x.verified = true; },
  x => { x.published = true; },
  x => { x.live_execution_authorized = true; },
  x => { x.provenance.solscan_source_reference = `solscan:transaction:${SIGNATURE}@${SLOT + 1}`; },
  x => { x.provenance_hash = '0'.repeat(64); },
]) {
  const tampered = structuredClone(receipt);
  mutate(tampered);
  assert.equal(verifyAutomaticEvidenceCorroboration(tampered), false);
}

console.log('automatic evidence cross-source corroboration regression: ok');
