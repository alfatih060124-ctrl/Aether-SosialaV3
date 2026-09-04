import { createHash } from 'node:crypto';
import { verifySolanaRpcProvenance } from './solana-evidence-source.mjs';
import { verifySolscanTransactionDetailEvidence } from './solscan-transaction-detail-evidence.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_SET = new Set(B58);
const METRICS = ['trades_count','total_return_bps','win_rate_bps','drawdown_bps','reputation_score'];

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (plain(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function hash(v) { return createHash('sha256').update(stable(v)).digest('hex'); }
function b58len(text) {
  if (typeof text !== 'string' || !text.length) return -1;
  let n = 0n;
  for (const ch of text) { if (!B58_SET.has(ch)) return -1; n = n * 58n + BigInt(B58.indexOf(ch)); }
  let bytes = 0; for (let x = n; x > 0n; x >>= 8n) bytes += 1;
  let leading = 0; while (leading < text.length && text[leading] === '1') leading += 1;
  return bytes + leading;
}
function signature(value, code) { if (b58len(value) !== 64) fail(code); return value; }
function slot(value, code) { if (!Number.isSafeInteger(value) || value < 0) fail(code); return value; }
function iso(value, code) {
  if (typeof value !== 'string') fail(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(code);
  return ms;
}
function parseReference(value, prefix, code) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) fail(code);
  const body = value.slice(prefix.length);
  const at = body.lastIndexOf('@');
  if (at < 1) fail(code);
  const sig = signature(body.slice(0, at), code);
  const slotText = body.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(slotText)) fail(code);
  const parsedSlot = Number(slotText);
  slot(parsedSlot, code);
  if (String(parsedSlot) !== slotText) fail(code);
  return { signature: sig, slot: parsedSlot };
}
function assertPending(evidence, code) {
  if (!plain(evidence) || evidence.collection_status !== 'PENDING_DATA' || evidence.metrics_available !== false || evidence.verified !== false || evidence.published !== false || evidence.live_execution_authorized !== false) fail(code);
  for (const metric of METRICS) if (evidence[metric] !== null) fail(code);
  if ('calculation_hash' in evidence && evidence.calculation_hash !== null) fail(code);
}
function normalizeRpc(evidence) {
  assertPending(evidence, 'unsafe_rpc_evidence');
  if (evidence.source_type !== 'SOLANA_RPC') fail('invalid_rpc_source_type');
  const ref = parseReference(evidence.source_reference, 'solana_rpc:', 'invalid_rpc_source_reference');
  const p = evidence.provenance;
  if (!plain(p) || p.recorded_source_reference !== evidence.source_reference || p.source_reference_policy !== 'SOLANA_RPC_SIGNATURE_SLOT' || p.newest_signature !== ref.signature || p.newest_slot !== ref.slot) fail('rpc_provenance_binding_invalid');
  if (!verifySolanaRpcProvenance(p)) fail('rpc_provenance_verification_failed');
  return { source_reference: evidence.source_reference, signature: ref.signature, slot: ref.slot, upstream_source_hash: p.source_hash };
}
function normalizeSolscan(evidence) {
  assertPending(evidence, 'unsafe_solscan_evidence');
  if (evidence.schema !== 'aether.solscan.transaction_detail_evidence.v1' || evidence.reconciliation_required !== true) fail('invalid_solscan_evidence_schema');
  if (!verifySolscanTransactionDetailEvidence(evidence)) fail('solscan_evidence_verification_failed');
  const ref = parseReference(evidence.source_reference, 'solscan:transaction:', 'invalid_solscan_source_reference');
  if (!plain(evidence.row) || evidence.row.found !== true || evidence.row.signature !== ref.signature || evidence.row.slot !== ref.slot || evidence.row.source_reference !== evidence.source_reference) fail('solscan_row_binding_invalid');
  if (!plain(evidence.provenance) || evidence.provenance.row?.source_reference !== evidence.source_reference || evidence.provenance.requested_signature !== ref.signature) fail('solscan_provenance_binding_invalid');
  if (typeof evidence.source_hash !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.source_hash)) fail('invalid_solscan_source_hash');
  return { source_reference: evidence.source_reference, signature: ref.signature, slot: ref.slot, upstream_source_hash: evidence.source_hash };
}
function envelope(provenance) {
  return {
    schema: 'aether.automatic_evidence.cross_source_corroboration.v4',
    source_type: 'INTERNAL_RECONCILIATION',
    source_reference: null,
    collection_status: 'PENDING_DATA',
    reason: 'CHAIN_EVIDENCE_CORROBORATED_PERFORMANCE_RECONCILIATION_REQUIRED',
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
    reconciliation_required: true,
    corroborated_signature: provenance.signature,
    corroborated_slot: provenance.slot,
    provenance,
    provenance_hash: hash(provenance)
  };
}

export function corroborateAutomaticEvidenceV4({ rpcEvidence, solscanEvidence, observedAt }) {
  const observedMs = iso(observedAt, 'invalid_corroboration_observed_at');
  const rpc = normalizeRpc(rpcEvidence);
  const solscan = normalizeSolscan(solscanEvidence);
  if (rpc.signature !== solscan.signature) fail('cross_source_signature_mismatch');
  if (rpc.slot !== solscan.slot) fail('cross_source_slot_mismatch');
  const solscanObservedMs = iso(solscanEvidence.provenance.observed_at, 'invalid_solscan_observed_at');
  if (observedMs < solscanObservedMs) fail('invalid_corroboration_chronology');
  return envelope({
    schema: 'aether.automatic_evidence.cross_source_corroboration.provenance.v4',
    algorithm: 'EXACT_SIGNATURE_SLOT_MATCH_WITH_INDEPENDENT_UPSTREAM_VERIFICATION_V1',
    signature: rpc.signature,
    slot: rpc.slot,
    rpc_source_reference: rpc.source_reference,
    solscan_source_reference: solscan.source_reference,
    rpc_upstream_source_hash: rpc.upstream_source_hash,
    solscan_upstream_source_hash: solscan.upstream_source_hash,
    observed_at: observedAt
  });
}

export function verifyAutomaticEvidenceCorroborationV4(evidence) {
  if (!plain(evidence) || evidence.schema !== 'aether.automatic_evidence.cross_source_corroboration.v4') return false;
  try {
    assertPending(evidence, 'unsafe_corroboration');
    if (evidence.source_type !== 'INTERNAL_RECONCILIATION' || evidence.source_reference !== null || evidence.calculation_hash !== null || evidence.reconciliation_required !== true) return false;
    const p = evidence.provenance;
    if (!plain(p) || p.schema !== 'aether.automatic_evidence.cross_source_corroboration.provenance.v4' || p.algorithm !== 'EXACT_SIGNATURE_SLOT_MATCH_WITH_INDEPENDENT_UPSTREAM_VERIFICATION_V1') return false;
    const rpc = parseReference(p.rpc_source_reference, 'solana_rpc:', 'bad_rpc_ref');
    const solscan = parseReference(p.solscan_source_reference, 'solscan:transaction:', 'bad_solscan_ref');
    if (rpc.signature !== solscan.signature || rpc.slot !== solscan.slot || p.signature !== rpc.signature || p.slot !== rpc.slot) return false;
    iso(p.observed_at, 'bad_observed_at');
    if (typeof p.rpc_upstream_source_hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.rpc_upstream_source_hash)) return false;
    if (typeof p.solscan_upstream_source_hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.solscan_upstream_source_hash)) return false;
    if (evidence.corroborated_signature !== p.signature || evidence.corroborated_slot !== p.slot) return false;
    return evidence.provenance_hash === hash(p);
  } catch { return false; }
}
