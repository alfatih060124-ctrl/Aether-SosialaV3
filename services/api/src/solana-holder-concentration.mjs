function rpcUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('solana_rpc_url_required');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('solana_rpc_https_required');
  return url.href;
}

function positiveBigInt(value, label) {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error(label);
    return n;
  } catch {
    throw new Error(label);
  }
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
    if (!body?.result) throw new Error(`solana_rpc_${method}_missing_result`);
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createSolanaHolderConcentrationService({
  fetchImpl = globalThis.fetch,
  endpoint = process.env.SOLANA_RPC_URL,
  timeoutMs = 8000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const url = rpcUrl(endpoint);

  return Object.freeze({
    async getTop10HolderPct(tokenMint) {
      const mint = String(tokenMint || '').trim();
      if (!mint) throw new Error('token_mint_required');
      const [supplyResult, largestResult] = await Promise.all([
        rpc(fetchImpl, url, 'getTokenSupply', [mint, { commitment: 'confirmed' }], timeoutMs),
        rpc(fetchImpl, url, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], timeoutMs)
      ]);
      const supply = positiveBigInt(supplyResult?.value?.amount, 'token_supply_invalid');
      const rows = Array.isArray(largestResult?.value) ? largestResult.value.slice(0, 10) : [];
      if (rows.length === 0) throw new Error('token_largest_accounts_missing');
      let top10 = 0n;
      for (const row of rows) top10 += positiveBigInt(row?.amount, 'token_holder_amount_invalid');
      const pct = Number((top10 * 1_000_000n) / supply) / 10_000;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('top10_holder_pct_invalid');
      return Object.freeze({
        top10_holder_pct: pct,
        largest_accounts_observed: rows.length,
        source: 'SOLANA_RPC',
        read_only: true,
        mode: 'SHADOW',
        execution_ready: false,
        live_execution_authorized: false
      });
    }
  });
}
