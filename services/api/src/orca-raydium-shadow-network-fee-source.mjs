const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_FEE_PAYER = '11111111111111111111111111111111';
const MAX_COMPUTE_UNITS = 1_400_000;

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

async function rpcCall(fetchImpl, rpcUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`shadow_network_fee_rpc_http_${response?.status || 'error'}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(`shadow_network_fee_rpc_${method}_failed`);
    if (payload?.result === undefined || payload?.result === null) throw new Error(`shadow_network_fee_rpc_${method}_missing`);
    return payload.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('shadow_network_fee_rpc_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function percentile(values, fraction) {
  const rows = values.filter(Number.isFinite).filter(v => v >= 0).sort((a, b) => a - b);
  if (!rows.length) return 0;
  return rows[Math.min(rows.length - 1, Math.floor((rows.length - 1) * fraction))];
}

function conservativeSolUsd(scan) {
  if (!scan || scan.read_only !== true || scan.live_execution_authorized !== false) throw new Error('shadow_network_fee_sol_usd_scan_invalid');
  const pools = Array.isArray(scan.pools) ? scan.pools : [];
  const prices = [];
  for (const pool of pools) {
    if (!['orca', 'raydium'].includes(String(pool?.dex_id || '').toLowerCase())) continue;
    if (pool?.quote_verified !== true || pool?.costs_verified !== true) continue;
    for (const value of [pool.buy_price_usd, pool.sell_price_usd]) {
      const price = Number(value);
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }
  }
  if (prices.length < 2) throw new Error('shadow_network_fee_sol_usd_evidence_required');
  return Math.max(...prices);
}

export function createOrcaRaydiumShadowNetworkFeeSource({
  rpcUrl,
  scannerRuntime,
  fetchImpl = globalThis.fetch,
  usdcMint = DEFAULT_USDC_MINT,
  feePayer = DEFAULT_FEE_PAYER,
  timeoutMs = 5_000
} = {}) {
  const endpoint = text(rpcUrl, 'shadow_network_fee_rpc_url_required');
  if (!scannerRuntime || typeof scannerRuntime.scanPair !== 'function') throw new Error('shadow_network_fee_scanner_required');
  if (typeof fetchImpl !== 'function') throw new Error('shadow_network_fee_fetch_required');
  const quoteMint = text(usdcMint, 'shadow_network_fee_usdc_mint_required');
  const payerAddress = text(feePayer, 'shadow_network_fee_payer_required');

  return async function loadNetworkFeeEvidence() {
    const { ComputeBudgetProgram, PublicKey, TransactionMessage } = await import('@solana/web3.js');
    const payer = new PublicKey(payerAddress);
    const [latest, recentPriorityFees, solUsdScan] = await Promise.all([
      rpcCall(fetchImpl, endpoint, 'getLatestBlockhash', [{ commitment: 'confirmed' }], timeoutMs),
      rpcCall(fetchImpl, endpoint, 'getRecentPrioritizationFees', [[]], timeoutMs),
      scannerRuntime.scanPair({ token_mint: WSOL_MINT, quote_mint: quoteMint })
    ]);
    const blockhash = text(latest?.value?.blockhash, 'shadow_network_fee_blockhash_required');
    if (!Array.isArray(recentPriorityFees)) throw new Error('shadow_network_fee_priority_evidence_required');
    const priorityMicroLamports = Math.ceil(percentile(recentPriorityFees.map(row => Number(row?.prioritizationFee)), 0.9));
    if (!Number.isSafeInteger(priorityMicroLamports) || priorityMicroLamports < 0) throw new Error('shadow_network_fee_priority_invalid');

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports })
    ];
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const messageBase64 = Buffer.from(message.serialize()).toString('base64');
    const feeResult = await rpcCall(fetchImpl, endpoint, 'getFeeForMessage', [messageBase64, { commitment: 'confirmed' }], timeoutMs);
    const feeLamports = Number(feeResult?.value);
    if (!Number.isSafeInteger(feeLamports) || feeLamports <= 0) throw new Error('shadow_network_fee_lamports_required');

    const solUsd = conservativeSolUsd(solUsdScan);
    const networkFeeUsdc = feeLamports / 1_000_000_000 * solUsd;
    if (!Number.isFinite(networkFeeUsdc) || networkFeeUsdc <= 0) throw new Error('shadow_network_fee_usdc_invalid');

    return Object.freeze({
      network_fee_usdc: networkFeeUsdc,
      network_fee_verified: true,
      source: 'SOLANA_GET_FEE_FOR_MESSAGE_CONSERVATIVE_TWO_LEG_BOUND',
      source_reference: `BLOCKHASH_${blockhash}|CU_${MAX_COMPUTE_UNITS}|P90_${priorityMicroLamports}|SOL_USD_ORCA_RAYDIUM`,
      sol_usd_price: solUsd,
      fee_lamports: feeLamports,
      compute_unit_limit: MAX_COMPUTE_UNITS,
      priority_micro_lamports: priorityMicroLamports,
      read_only: true,
      transaction_signed: false,
      transaction_submitted: false,
      signer_requested: false,
      live_execution_authorized: false
    });
  };
}

export const ORCA_RAYDIUM_SHADOW_NETWORK_FEE_SOURCE = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  sol_usd_source: 'ORCA_RAYDIUM_VERIFIED_SCANNER',
  compute_bound: 'SOLANA_MAX_COMPUTE_UNITS',
  message_fee_source: 'getFeeForMessage',
  signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
