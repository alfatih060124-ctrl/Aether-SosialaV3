const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';
const MIN_NET_EDGE_BPS = 20;
const DEFAULT_MAX_SIMULATION_AGE_MS = 15_000;
const HARD_MAX_SIMULATION_AGE_MS = 60_000;

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function positiveNumber(value, code) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(code);
  return n;
}

function safeInt(value, code, min = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(code);
  return n;
}

function maxSimulationAgeMs(env = process.env) {
  const configured = Number(env.LIVE_MAX_SIMULATION_AGE_MS || DEFAULT_MAX_SIMULATION_AGE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_SIMULATION_AGE_MS;
  return Math.min(configured, HARD_MAX_SIMULATION_AGE_MS);
}

function requireDecision(decision) {
  if (!decision || typeof decision !== 'object') throw new Error('two_leg_preflight_decision_required');
  if (decision.strategy !== STRATEGY || decision.dex_pair !== DEX_PAIR || decision.action !== 'ARBITRAGE_SETTLE') {
    throw new Error('two_leg_preflight_decision_scope_invalid');
  }
  if (decision.qualified !== true || decision.risk_verified !== true || decision.costs_verified !== true || decision.freshness_verified !== true) {
    throw new Error('two_leg_preflight_decision_not_verified');
  }
  const netEdgeBps = Number(decision.expected_net_edge_bps);
  if (!Number.isFinite(netEdgeBps) || netEdgeBps < MIN_NET_EDGE_BPS) throw new Error('two_leg_preflight_net_edge_below_floor');
  return Object.freeze({
    ...decision,
    token_mint: text(decision.token_mint, 'two_leg_preflight_token_mint_required'),
    quote_mint: text(decision.quote_mint, 'two_leg_preflight_quote_mint_required'),
    notional_usdc: positiveNumber(decision.notional_usdc, 'two_leg_preflight_notional_required'),
    buy_dex: text(decision.buy_dex, 'two_leg_preflight_buy_dex_required').toUpperCase(),
    sell_dex: text(decision.sell_dex, 'two_leg_preflight_sell_dex_required').toUpperCase(),
    expected_net_edge_bps: netEdgeBps
  });
}

function requirePlan(plan, decision) {
  if (!plan || typeof plan !== 'object') throw new Error('two_leg_preflight_plan_required');
  if (plan.schema !== 'aether.two_leg_atomic_unsigned_plan.v1') throw new Error('two_leg_preflight_plan_schema_invalid');
  if (plan.strategy !== STRATEGY || plan.dex_pair !== DEX_PAIR || plan.atomic !== true || Number(plan.leg_count) !== 2) {
    throw new Error('two_leg_preflight_plan_scope_invalid');
  }
  if (plan.signed !== false || plan.transaction_signed !== false || plan.signer_requested === true) throw new Error('two_leg_preflight_unsigned_plan_required');
  if (plan.network_submission_authorized === true || plan.live_execution_authorized === true) throw new Error('two_leg_preflight_plan_safety_boundary_violation');
  if (text(plan.token_mint, 'two_leg_preflight_plan_token_mint_required') !== decision.token_mint) throw new Error('two_leg_preflight_plan_token_mint_mismatch');
  if (text(plan.quote_mint, 'two_leg_preflight_plan_quote_mint_required') !== decision.quote_mint) throw new Error('two_leg_preflight_plan_quote_mint_mismatch');
  if (positiveNumber(plan.notional_usdc, 'two_leg_preflight_plan_notional_required') !== decision.notional_usdc) throw new Error('two_leg_preflight_plan_notional_mismatch');
  if (String(plan.buy_dex || '').toUpperCase() !== decision.buy_dex || String(plan.sell_dex || '').toUpperCase() !== decision.sell_dex) {
    throw new Error('two_leg_preflight_plan_route_mismatch');
  }
  const serialized = text(plan.unsigned_transaction_base64, 'two_leg_preflight_unsigned_transaction_required');
  let bytes;
  try { bytes = Buffer.from(serialized, 'base64'); }
  catch { throw new Error('two_leg_preflight_unsigned_transaction_invalid'); }
  if (!bytes.length) throw new Error('two_leg_preflight_unsigned_transaction_invalid');
  return Object.freeze({ ...plan, unsigned_transaction_base64: serialized });
}

function requireSimulation(simulation, { now, env }) {
  if (!simulation || typeof simulation !== 'object') throw new Error('two_leg_preflight_simulation_required');
  if (simulation.ok !== true || simulation.err != null) throw new Error('two_leg_preflight_simulation_failed');
  const slot = safeInt(simulation.slot, 'two_leg_preflight_simulation_slot_required', 1);
  const unitsConsumed = safeInt(simulation.units_consumed, 'two_leg_preflight_units_consumed_required', 0);
  const observedAt = text(simulation.observed_at, 'two_leg_preflight_observed_at_required');
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) throw new Error('two_leg_preflight_observed_at_invalid');
  const age = now - observedMs;
  if (age < -1000 || age > maxSimulationAgeMs(env)) throw new Error('two_leg_preflight_simulation_stale');
  if (simulation.sig_verify === true) throw new Error('two_leg_preflight_signature_verification_forbidden');
  if (simulation.network_submission_performed === true || simulation.fund_movement_performed === true) throw new Error('two_leg_preflight_submission_boundary_violation');
  return Object.freeze({ slot, units_consumed: unitsConsumed, observed_at: observedAt });
}

export async function runTwoLegAtomicPreflight({
  decision,
  plan,
  simulateUnsignedTransaction,
  auditWrite,
  env = process.env,
  now = Date.now()
} = {}) {
  if (typeof auditWrite !== 'function') throw new Error('two_leg_preflight_audit_writer_required');
  let phase = 'VALIDATION';
  try {
    const checkedDecision = requireDecision(decision);
    const checkedPlan = requirePlan(plan, checkedDecision);
    if (typeof simulateUnsignedTransaction !== 'function') throw new Error('two_leg_preflight_simulator_required');

    phase = 'SIMULATION';
    const simulation = requireSimulation(await simulateUnsignedTransaction({
      transaction_base64: checkedPlan.unsigned_transaction_base64,
      sig_verify: false,
      replace_recent_blockhash: true,
      decision: checkedDecision,
      plan: checkedPlan
    }), { now, env });

    await auditWrite({
      event_type: 'TWO_LEG_ATOMIC_PREFLIGHT_VERIFIED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      token_mint: checkedDecision.token_mint,
      quote_mint: checkedDecision.quote_mint,
      notional_usdc: checkedDecision.notional_usdc,
      simulation_slot: simulation.slot,
      units_consumed: simulation.units_consumed
    });

    return Object.freeze({
      schema: 'aether.two_leg_atomic_preflight.v1',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      atomic: true,
      leg_count: 2,
      preflight_verified: true,
      simulation_ok: true,
      simulation_slot: simulation.slot,
      units_consumed: simulation.units_consumed,
      observed_at: simulation.observed_at,
      transaction_hash: checkedPlan.transaction_hash,
      transaction_signing_authorized: false,
      network_submission_authorized: false,
      fund_movement_authorized: false,
      live_execution_authorized: false
    });
  } catch (error) {
    await auditWrite({
      event_type: 'TWO_LEG_ATOMIC_PREFLIGHT_BLOCKED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      phase,
      blocker: String(error?.message || 'two_leg_preflight_unknown_error')
    });
    throw error;
  }
}

export const TWO_LEG_ATOMIC_PREFLIGHT = Object.freeze({
  schema: 'aether.two_leg_atomic_preflight.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  min_expected_net_edge_bps: MIN_NET_EDGE_BPS,
  requires_atomic_unsigned_transaction: true,
  requires_simulation_success: true,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false,
  fail_closed: true
});
