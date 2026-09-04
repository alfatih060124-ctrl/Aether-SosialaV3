import { normalizeSolanaMint } from './market-intelligence.mjs';

const JUPITER_ORIGIN = 'https://api.jup.ag';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsUrl(value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(label);
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error(`${label}_https_required`);
  return url.href;
}

function decodeShortVec(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let i = 0; i < 3; i += 1) {
    if (cursor >= buffer.length) throw new Error('solana_transaction_shortvec_truncated');
    const byte = buffer[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, bytes: cursor - offset };
    shift += 7;
  }
  throw new Error('solana_transaction_shortvec_invalid');
}

function messageBase64FromTransaction(transactionBase64) {
  let bytes;
  try {
    bytes = Buffer.from(String(transactionBase64 || ''), 'base64');
  } catch {
    throw new Error('jupiter_swap_transaction_invalid_base64');
  }
  if (!bytes.length) throw new Error('jupiter_swap_transaction_empty');
  const signatures = decodeShortVec(bytes, 0);
  const messageOffset = signatures.bytes + signatures.value * 64;
  if (messageOffset >= bytes.length) throw new Error('jupiter_swap_transaction_message_missing');
  return bytes.subarray(messageOffset).toString('base64');
}

async function postJson(fetchImpl, url, body, { apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error'
    });
    if (response.status === 429) throw new Error('jupiter_swap_rate_limited');
    if (!response.ok) throw new Error(`jupiter_swap_http_${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') throw new Error('jupiter_swap_invalid_payload');
    if (payload.error) throw new Error('jupiter_swap_build_failed');
    if (!payload.swapTransaction) throw new Error('jupiter_swap_transaction_missing');
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('jupiter_swap_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(fetchImpl, endpoint, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`solana_rpc_http_${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`solana_rpc_${method}_error`);
    if (!Object.prototype.hasOwnProperty.call(body || {}, 'result')) throw new Error(`solana_rpc_${method}_missing_result`);
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('solana_rpc_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function simulationResult(result) {
  const value = result?.value || null;
  return {
    ok: Boolean(value && value.err === null),
    error: value?.err ?? null,
    units_consumed: Number.isFinite(Number(value?.unitsConsumed)) ? Number(value.unitsConsumed) : null,
    logs_observed: Array.isArray(value?.logs) ? value.logs.length : 0
  };
}

function classifySimulationState(sim) {
  if (sim?.ok) {
    return Object.freeze({
      state_status: 'SIMULATION_STATE_READY',
      account_state_available: true,
      route_execution_rejected: false
    });
  }
  const error = typeof sim?.error === 'string' ? sim.error : JSON.stringify(sim?.error ?? null);
  if (error === 'AccountNotFound') {
    return Object.freeze({
      state_status: 'SIMULATION_ACCOUNT_STATE_UNAVAILABLE',
      account_state_available: false,
      route_execution_rejected: false
    });
  }
  return Object.freeze({
    state_status: 'SIMULATION_EXECUTION_REJECTED',
    account_state_available: true,
    route_execution_rejected: true
  });
}

export function createJupiterUnsignedSimulationService({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.JUPITER_API_KEY || '',
  endpoint = process.env.SOLANA_RPC_URL,
  simulationPublicKey = process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '',
  timeoutMs = 12_000,
  interSwapDelayMs = Number(process.env.AETHER_JUPITER_INTER_SWAP_DELAY_MS || (process.env.JUPITER_API_KEY ? 1300 : 2600)),
  maxSwapRetries = Number(process.env.AETHER_JUPITER_SWAP_MAX_RETRIES || 3)
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const rpcEndpoint = httpsUrl(endpoint, 'solana_rpc_url_required');
  const rawPublicKey = String(simulationPublicKey || '').trim();
  if (!rawPublicKey) throw new Error('shadow_simulation_public_key_required');
  const userPublicKey = normalizeSolanaMint(rawPublicKey);
  const safeApiKey = String(apiKey || '').trim();
  const safeDelayMs = Number.isFinite(Number(interSwapDelayMs)) ? Math.min(15_000, Math.max(1000, Math.trunc(Number(interSwapDelayMs)))) : 1300;
  const safeMaxRetries = Number.isSafeInteger(Number(maxSwapRetries)) ? Math.min(5, Math.max(0, Number(maxSwapRetries))) : 3;

  async function buildSwapWithBackoff(quoteResponse) {
    const url = new URL('/swap/v1/swap', JUPITER_ORIGIN);
    let lastError = null;
    for (let attempt = 0; attempt <= safeMaxRetries; attempt += 1) {
      try {
        return await postJson(fetchImpl, url, {
          quoteResponse,
          userPublicKey,
          dynamicComputeUnitLimit: true,
          wrapAndUnwrapSol: true
        }, { apiKey: safeApiKey, timeoutMs });
      } catch (error) {
        lastError = error;
        if (String(error?.message || error) !== 'jupiter_swap_rate_limited' || attempt >= safeMaxRetries) throw error;
        await sleep(Math.min(15_000, safeDelayMs * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function buildAndObserve(quoteEvidence) {
    const quoteResponse = quoteEvidence?.provider_quote_response;
    if (!quoteResponse || typeof quoteResponse !== 'object') throw new Error('jupiter_provider_quote_required');
    const built = await buildSwapWithBackoff(quoteResponse);

    const transactionBase64 = String(built.swapTransaction);
    const messageBase64 = messageBase64FromTransaction(transactionBase64);
    const [feeResult, simulation] = await Promise.all([
      rpc(fetchImpl, rpcEndpoint, 'getFeeForMessage', [messageBase64, { commitment: 'processed' }], timeoutMs),
      rpc(fetchImpl, rpcEndpoint, 'simulateTransaction', [transactionBase64, {
        commitment: 'processed',
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true
      }], timeoutMs)
    ]);

    const lamports = Number(feeResult?.value);
    const exactFeeLamports = Number.isSafeInteger(lamports) && lamports >= 0 ? lamports : null;
    const sim = simulationResult(simulation);
    const state = classifySimulationState(sim);
    if (!sim.ok) {
      console.error('[aether-shadow-sim] simulation rejected', JSON.stringify({
        error: sim.error,
        state_status: state.state_status,
        account_state_available: state.account_state_available,
        route_execution_rejected: state.route_execution_rejected,
        units_consumed: sim.units_consumed,
        logs_observed: sim.logs_observed
      }));
    }
    return Object.freeze({
      transaction_built: true,
      exact_fee_lamports: exactFeeLamports,
      exact_transaction_fee_ready: exactFeeLamports !== null,
      simulation_attempted: true,
      simulation_ok: sim.ok,
      simulation_error: sim.error,
      simulation_state_status: state.state_status,
      simulation_account_state_available: state.account_state_available,
      simulation_route_execution_rejected: state.route_execution_rejected,
      units_consumed: sim.units_consumed,
      logs_observed: sim.logs_observed,
      user_public_key_present: true,
      source: 'JUPITER_SWAP_BUILD+SOLANA_RPC',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  return Object.freeze({
    user_public_key: userPublicKey,
    inter_swap_delay_ms: safeDelayMs,
    swap_max_retries: safeMaxRetries,
    async observeRoundTrip(quoteEvidence) {
      await sleep(safeDelayMs);
      const buy = await buildAndObserve(quoteEvidence?.buy);
      await sleep(safeDelayMs);
      const sell = await buildAndObserve(quoteEvidence?.sell);
      const buyFee = buy.exact_fee_lamports;
      const sellFee = sell.exact_fee_lamports;
      const accountStateAvailable = Boolean(buy.simulation_account_state_available && sell.simulation_account_state_available);
      return Object.freeze({
        buy,
        sell,
        exact_roundtrip_fee_lamports: buyFee !== null && sellFee !== null ? buyFee + sellFee : null,
        exact_transaction_fee_ready: Boolean(buy.exact_transaction_fee_ready && sell.exact_transaction_fee_ready),
        buy_simulation_ok: Boolean(buy.simulation_ok),
        sell_simulation_ok: Boolean(sell.simulation_ok),
        roundtrip_simulation_ok: Boolean(buy.simulation_ok && sell.simulation_ok),
        simulation_account_state_available: accountStateAvailable,
        simulation_state_limited: !accountStateAvailable,
        source: 'JUPITER_SWAP_BUILD+SOLANA_RPC',
        read_only: true,
        mode: 'SHADOW',
        transaction_signed: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}
