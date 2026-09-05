const text = (value, code) => { const v = String(value || '').trim(); if (!v) throw new Error(code); return v; };
const safeInt = (value, code, min = 0) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min) throw new Error(code); return n; };

function endpointUrl(value) {
  const raw = text(value, 'pretrade_rpc_url_required');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('pretrade_rpc_https_required');
  return url.href;
}

function percentile(values, p) {
  if (!values.length) throw new Error('pretrade_priority_fee_samples_required');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
  return sorted[index];
}

export function createSolanaPretradeRpcEvidenceProvider({
  rpcUrl = process.env.SOLANA_RPC_URL,
  fetchImpl = globalThis.fetch,
  loadCurrentSolUsdPrice,
  timeoutMs = 8000,
  now = () => Date.now(),
  priorityPercentile = 0.75
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('pretrade_rpc_fetch_required');
  if (typeof loadCurrentSolUsdPrice !== 'function') throw new Error('pretrade_current_sol_usd_loader_required');
  const endpoint = endpointUrl(rpcUrl);
  const pct = Number(priorityPercentile);
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) throw new Error('pretrade_priority_percentile_invalid');

  async function rpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15000, Number(timeoutMs) || 8000)));
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal, redirect: 'error'
      });
      if (!response.ok) throw new Error(`pretrade_rpc_http_${response.status}`);
      const body = await response.json();
      if (body?.error) throw new Error(`pretrade_rpc_${method}_error`);
      if (body?.result === undefined || body?.result === null) throw new Error(`pretrade_rpc_${method}_missing_result`);
      return body.result;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('pretrade_rpc_timeout');
      throw error;
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async getFeeForMessage({ message_base64, source_slot } = {}) {
      const message = text(message_base64, 'pretrade_rpc_message_required');
      const minSlot = safeInt(source_slot, 'pretrade_rpc_source_slot_required', 0);
      const result = await rpc('getFeeForMessage', [message, { commitment: 'confirmed', minContextSlot: minSlot }]);
      const slot = safeInt(result?.context?.slot, 'pretrade_rpc_fee_context_slot_required', minSlot);
      const fee = safeInt(result?.value, 'pretrade_rpc_base_fee_required', 0);
      return Object.freeze({ verified: true, base_fee_lamports: fee, source_slot: slot, source_reference: `SOLANA_RPC:getFeeForMessage:${slot}`, observed_at: new Date(now()).toISOString(), read_only: true, live_execution_authorized: false });
    },

    async simulateUnsignedTransaction({ transaction_base64, source_slot } = {}) {
      const transaction = text(transaction_base64, 'pretrade_rpc_transaction_required');
      const minSlot = safeInt(source_slot, 'pretrade_rpc_source_slot_required', 0);
      const result = await rpc('simulateTransaction', [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', minContextSlot: minSlot }]);
      const slot = safeInt(result?.context?.slot, 'pretrade_rpc_simulation_context_slot_required', minSlot);
      if (result?.value?.err !== null && result?.value?.err !== undefined) throw new Error('pretrade_rpc_simulation_failed');
      const units = safeInt(result?.value?.unitsConsumed, 'pretrade_rpc_compute_units_required', 1);
      return Object.freeze({ verified: true, compute_units_consumed: units, source_slot: slot, source_reference: `SOLANA_RPC:simulateTransaction:${slot}`, observed_at: new Date(now()).toISOString(), read_only: true, transaction_signed: false, network_submission_authorized: false, live_execution_authorized: false });
    },

    async loadPriorityFeeEvidence({ account_keys = [], source_slot } = {}) {
      const minSlot = safeInt(source_slot, 'pretrade_rpc_source_slot_required', 0);
      const keys = Array.isArray(account_keys) ? [...new Set(account_keys.map(String).filter(Boolean))].slice(0, 128) : [];
      const result = await rpc('getRecentPrioritizationFees', [keys]);
      const rows = Array.isArray(result) ? result : [];
      const eligible = rows.map(row => ({ slot: Number(row?.slot), fee: Number(row?.prioritizationFee) }))
        .filter(row => Number.isSafeInteger(row.slot) && row.slot >= minSlot && Number.isSafeInteger(row.fee) && row.fee >= 0);
      if (!eligible.length) throw new Error('pretrade_priority_fee_samples_required');
      const rate = percentile(eligible.map(row => row.fee), pct);
      const slot = Math.max(...eligible.map(row => row.slot));
      return Object.freeze({ verified: true, micro_lamports_per_compute_unit: rate, source_slot: slot, sample_count: eligible.length, percentile: pct, source_reference: `SOLANA_RPC:getRecentPrioritizationFees:${slot}:p${pct}`, observed_at: new Date(now()).toISOString(), read_only: true, live_execution_authorized: false });
    },

    async loadCurrentSolUsdEvidence({ source_slot } = {}) {
      const minSlot = safeInt(source_slot, 'pretrade_rpc_source_slot_required', 0);
      const raw = await loadCurrentSolUsdPrice(Object.freeze({ source_slot: minSlot, read_only: true }));
      if (!raw || typeof raw !== 'object' || raw.verified !== true) throw new Error('pretrade_current_sol_usd_unverified');
      const price = Number(raw.sol_usd);
      if (!(price > 0)) throw new Error('pretrade_current_sol_usd_invalid');
      const slot = safeInt(raw.source_slot, 'pretrade_current_sol_usd_source_slot_required', minSlot);
      return Object.freeze({ verified: true, sol_usd: price, source_slot: slot, source_reference: text(raw.source_reference, 'pretrade_current_sol_usd_reference_required'), observed_at: text(raw.observed_at, 'pretrade_current_sol_usd_observed_at_required'), read_only: true, live_execution_authorized: false });
    }
  });
}

export const SOLANA_PRETRADE_RPC_EVIDENCE_PROVIDER = Object.freeze({
  mode: 'SHADOW', read_only: true, rpc_methods: Object.freeze(['getFeeForMessage', 'simulateTransaction', 'getRecentPrioritizationFees']),
  simulation_sig_verify: false, network_submission_authorized: false, transaction_signing_authorized: false, live_execution_authorized: false
});
