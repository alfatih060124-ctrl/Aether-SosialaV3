import { assertLiveExecutionAuthorized } from './live-execution-gate.mjs';

const MIN_NET_EDGE_BPS = 20;
const DEFAULT_MAX_DECISION_AGE_MS = 15_000;
const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';
const ACTION = 'ARBITRAGE_SETTLE';

function requireFunction(fn, code) {
  if (typeof fn !== 'function') throw new Error(code);
  return fn;
}

function positiveIntegerString(value, code) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(code);
  return raw;
}

function requireDecision(decision, { nowMs, maxDecisionAgeMs }) {
  if (!decision || typeof decision !== 'object') throw new Error('two_leg_live_decision_required');
  if (decision.strategy !== STRATEGY) throw new Error('two_leg_live_strategy_invalid');
  if (decision.dex_pair !== DEX_PAIR) throw new Error('two_leg_live_dex_pair_invalid');
  if (decision.action !== ACTION) throw new Error('two_leg_live_action_invalid');
  if (decision.qualified !== true) throw new Error('two_leg_live_qualification_required');
  const netEdgeBps = Number(decision.expected_net_edge_bps);
  if (!Number.isFinite(netEdgeBps) || netEdgeBps < MIN_NET_EDGE_BPS) throw new Error('two_leg_live_net_edge_below_floor');
  if (decision.risk_verified !== true) throw new Error('two_leg_live_risk_verification_required');
  if (decision.costs_verified !== true) throw new Error('two_leg_live_cost_verification_required');
  if (decision.freshness_verified !== true) throw new Error('two_leg_live_freshness_verification_required');

  const observedMs = Date.parse(String(decision.observed_at || ''));
  if (!Number.isFinite(observedMs)) throw new Error('two_leg_live_observed_at_required');
  const ageMs = nowMs - observedMs;
  if (ageMs < 0 || ageMs > maxDecisionAgeMs) throw new Error('two_leg_live_decision_stale');

  const tokenMint = String(decision.token_mint || '').trim();
  const quoteMint = String(decision.quote_mint || '').trim();
  if (!tokenMint || !quoteMint || tokenMint === quoteMint) throw new Error('two_leg_live_token_pair_invalid');
  const notionalAtomic = positiveIntegerString(decision.notional_usdc_atomic, 'two_leg_live_notional_invalid');
  const buyDex = String(decision.buy_dex || '').trim().toUpperCase();
  const sellDex = String(decision.sell_dex || '').trim().toUpperCase();
  if (!((buyDex === 'ORCA' && sellDex === 'RAYDIUM') || (buyDex === 'RAYDIUM' && sellDex === 'ORCA'))) {
    throw new Error('two_leg_live_direction_invalid');
  }

  return Object.freeze({
    ...decision,
    expected_net_edge_bps: netEdgeBps,
    observed_at: new Date(observedMs).toISOString(),
    token_mint: tokenMint,
    quote_mint: quoteMint,
    notional_usdc_atomic: notionalAtomic,
    buy_dex: buyDex,
    sell_dex: sellDex
  });
}

function requireSerializedTransaction(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  throw new Error('two_leg_atomic_plan_transaction_required');
}

function requireAtomicPlan(plan, decision) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('two_leg_atomic_plan_required');
  if (plan.strategy !== STRATEGY) throw new Error('two_leg_atomic_plan_strategy_invalid');
  if (plan.dex_pair !== DEX_PAIR) throw new Error('two_leg_atomic_plan_dex_pair_invalid');
  if (plan.atomic !== true) throw new Error('two_leg_atomic_plan_not_atomic');
  if (Number(plan.leg_count) !== 2) throw new Error('two_leg_atomic_plan_leg_count_invalid');
  if (!Array.isArray(plan.legs) || plan.legs.length !== 2) throw new Error('two_leg_atomic_plan_legs_invalid');
  const [buyLeg, sellLeg] = plan.legs;
  if (String(buyLeg?.dex || '').toUpperCase() !== decision.buy_dex || String(buyLeg?.side || '').toUpperCase() !== 'BUY') {
    throw new Error('two_leg_atomic_plan_buy_leg_mismatch');
  }
  if (String(sellLeg?.dex || '').toUpperCase() !== decision.sell_dex || String(sellLeg?.side || '').toUpperCase() !== 'SELL') {
    throw new Error('two_leg_atomic_plan_sell_leg_mismatch');
  }
  if (String(plan.token_mint || '').trim() !== decision.token_mint || String(plan.quote_mint || '').trim() !== decision.quote_mint) {
    throw new Error('two_leg_atomic_plan_token_pair_mismatch');
  }
  if (positiveIntegerString(plan.notional_usdc_atomic, 'two_leg_atomic_plan_notional_invalid') !== decision.notional_usdc_atomic) {
    throw new Error('two_leg_atomic_plan_notional_mismatch');
  }
  if (plan.signed !== true) throw new Error('two_leg_atomic_plan_signature_required');
  requireSerializedTransaction(plan.serialized_transaction);
  return plan;
}

function maxDecisionAge(env) {
  const value = Number(env.LIVE_MAX_DECISION_AGE_MS ?? DEFAULT_MAX_DECISION_AGE_MS);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) throw new Error('two_leg_live_max_decision_age_invalid');
  return value;
}

export async function dispatchTwoLegLiveExecution({
  decision,
  gateState,
  buildSignedAtomicTransaction,
  submitSignedAtomicTransaction,
  auditWrite,
  env = process.env,
  now = () => Date.now()
} = {}) {
  const audit = requireFunction(auditWrite, 'two_leg_live_audit_writer_required');
  let phase = 'VALIDATION';
  try {
    const checkedDecision = requireDecision(decision, { nowMs: Number(now()), maxDecisionAgeMs: maxDecisionAge(env) });
    phase = 'LIVE_GATE';
    const gate = assertLiveExecutionAuthorized(gateState, env);
    phase = 'BUILD';
    const build = requireFunction(buildSignedAtomicTransaction, 'two_leg_atomic_builder_required');
    const submit = requireFunction(submitSignedAtomicTransaction, 'two_leg_atomic_submitter_required');
    const plan = requireAtomicPlan(await build({ decision: checkedDecision, gate }), checkedDecision);

    await audit({
      event_type: 'TWO_LEG_LIVE_EXECUTION_AUTHORIZED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      expected_net_edge_bps: checkedDecision.expected_net_edge_bps,
      token_mint: checkedDecision.token_mint,
      quote_mint: checkedDecision.quote_mint,
      notional_usdc_atomic: checkedDecision.notional_usdc_atomic,
      atomic: true,
      leg_count: 2,
      gate_schema: gate.schema
    });

    phase = 'SUBMIT';
    const result = await submit({ plan, decision: checkedDecision, gate });
    return Object.freeze({
      schema: 'aether.two_leg_live_execution_boundary.v1',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      atomic: true,
      leg_count: 2,
      execution_dispatched: true,
      live_execution_authorized: true,
      network_submission_authorized: true,
      signer_required: true,
      result
    });
  } catch (error) {
    await audit({
      event_type: 'TWO_LEG_LIVE_EXECUTION_BLOCKED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      phase,
      blocker: String(error?.code || error?.message || 'TWO_LEG_LIVE_EXECUTION_BLOCKED'),
      blockers: Array.isArray(error?.blockers) ? error.blockers : undefined
    });
    throw error;
  }
}

export const TWO_LEG_LIVE_EXECUTION_BOUNDARY = Object.freeze({
  schema: 'aether.two_leg_live_execution_boundary.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  action: ACTION,
  min_expected_net_edge_bps: MIN_NET_EDGE_BPS,
  max_decision_age_ms_default: DEFAULT_MAX_DECISION_AGE_MS,
  atomic_required: true,
  leg_count: 2,
  directional_execution_supported: false,
  independent_leg_submission_supported: false,
  fail_closed: true
});
