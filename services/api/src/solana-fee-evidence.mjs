function rpcUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('solana_rpc_url_required');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('solana_rpc_https_required');
  return url.href;
}

async function rpc(fetchImpl, endpoint, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`solana_rpc_http_${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`solana_rpc_${method}_error`);
    if (!Array.isArray(body?.result)) throw new Error(`solana_rpc_${method}_invalid_result`);
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function createSolanaFeeEvidenceService({
  fetchImpl = globalThis.fetch,
  endpoint = process.env.SOLANA_RPC_URL,
  timeoutMs = 8000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const url = rpcUrl(endpoint);

  return Object.freeze({
    async getRecentFeeEvidence() {
      const rows = await rpc(fetchImpl, url, 'getRecentPrioritizationFees', [], timeoutMs);
      const fees = rows
        .map(row => Number(row?.prioritizationFee))
        .filter(value => Number.isSafeInteger(value) && value >= 0)
        .sort((a, b) => a - b);
      if (!fees.length) throw new Error('solana_priority_fee_observation_missing');
      return Object.freeze({
        samples: fees.length,
        prioritization_fee_rpc_p50: percentile(fees, 0.50),
        prioritization_fee_rpc_p75: percentile(fees, 0.75),
        prioritization_fee_rpc_p90: percentile(fees, 0.90),
        base_fee_lamports_per_signature_reference: 5000,
        exact_transaction_fee_ready: false,
        compute_units_simulated: false,
        transaction_message_built: false,
        note: 'Recent prioritization-fee RPC observations are context only. Exact transaction cost remains fail-closed until an actual unsigned transaction message is built and simulated, because priority cost depends on the requested compute budget.',
        source: 'SOLANA_RPC',
        read_only: true,
        mode: 'SHADOW',
        execution_ready: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}
