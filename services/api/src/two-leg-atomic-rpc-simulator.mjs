const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';
const DEFAULT_TIMEOUT_MS = 5_000;

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function timeout(value) {
  const n = Number(value || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0 || n > 15_000) throw new Error('two_leg_rpc_simulator_timeout_invalid');
  return Math.floor(n);
}

export function createTwoLegAtomicRpcSimulator({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  const endpoint = text(rpcUrl, 'two_leg_rpc_simulator_url_required');
  if (!endpoint.startsWith('https://')) throw new Error('two_leg_rpc_simulator_https_required');
  if (typeof fetchImpl !== 'function') throw new Error('two_leg_rpc_simulator_fetch_required');
  if (typeof now !== 'function') throw new Error('two_leg_rpc_simulator_clock_required');
  const requestTimeoutMs = timeout(timeoutMs);

  return async function simulateUnsignedTransaction({
    transaction_base64,
    sig_verify,
    replace_recent_blockhash,
    decision,
    plan
  } = {}) {
    const transactionBase64 = text(transaction_base64, 'two_leg_rpc_simulator_transaction_required');
    if (sig_verify !== false) throw new Error('two_leg_rpc_simulator_sig_verify_must_be_false');
    if (replace_recent_blockhash !== true) throw new Error('two_leg_rpc_simulator_replace_blockhash_required');
    if (!decision || decision.strategy !== STRATEGY || decision.dex_pair !== DEX_PAIR) throw new Error('two_leg_rpc_simulator_decision_scope_invalid');
    if (!plan || plan.schema !== 'aether.two_leg_atomic_unsigned_plan.v1' || plan.atomic !== true || Number(plan.leg_count) !== 2) {
      throw new Error('two_leg_rpc_simulator_plan_scope_invalid');
    }
    if (plan.signed !== false || plan.transaction_signed !== false || plan.network_submission_authorized === true || plan.live_execution_authorized === true) {
      throw new Error('two_leg_rpc_simulator_plan_safety_boundary_violation');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'simulateTransaction',
          params: [transactionBase64, {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: 'confirmed'
          }]
        }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response?.ok) throw new Error(`two_leg_rpc_simulator_http_${response?.status || 'error'}`);
      const payload = await response.json();
      if (payload?.error) throw new Error('two_leg_rpc_simulator_rpc_failed');
      const result = payload?.result;
      const value = result?.value;
      const slot = Number(result?.context?.slot);
      if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('two_leg_rpc_simulator_slot_required');
      if (!value || typeof value !== 'object') throw new Error('two_leg_rpc_simulator_result_required');
      const unitsConsumed = Number(value.unitsConsumed ?? 0);
      if (!Number.isSafeInteger(unitsConsumed) || unitsConsumed < 0) throw new Error('two_leg_rpc_simulator_units_invalid');
      const observedMs = Number(now());
      if (!Number.isFinite(observedMs)) throw new Error('two_leg_rpc_simulator_clock_invalid');

      return Object.freeze({
        ok: value.err == null,
        err: value.err ?? null,
        slot,
        units_consumed: unitsConsumed,
        observed_at: new Date(observedMs).toISOString(),
        sig_verify: false,
        replace_recent_blockhash: true,
        network_submission_performed: false,
        fund_movement_performed: false,
        transaction_signed: false,
        signer_requested: false,
        live_execution_authorized: false
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('two_leg_rpc_simulator_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export const TWO_LEG_ATOMIC_RPC_SIMULATOR = Object.freeze({
  schema: 'aether.two_leg_atomic_rpc_simulator.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  rpc_method: 'simulateTransaction',
  sig_verify: false,
  replace_recent_blockhash: true,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false,
  fail_closed: true
});
