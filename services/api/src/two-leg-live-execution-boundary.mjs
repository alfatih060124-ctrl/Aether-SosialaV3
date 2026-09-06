import { assertLiveExecutionAuthorized } from './live-execution-gate.mjs';

const MIN_NET_EDGE_BPS = 20;
const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';
const ACTION = 'ARBITRAGE_SETTLE';

function requireFunction(fn, code) {
  if (typeof fn !== 'function') throw new Error(code);
  return fn;
}

function requireDecision(decision) {
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
  return Object.freeze({ ...decision, expected_net_edge_bps: netEdgeBps });
}

function requireAtomicPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('two_leg_atomic_plan_required');
  if (plan.strategy !== STRATEGY) throw new Error('two_leg_atomic_plan_strategy_invalid');
  if (plan.dex_pair !== DEX_PAIR) throw new Error('two_leg_atomic_plan_dex_pair_invalid');
  if (plan.atomic !== true) throw new Error('two_leg_atomic_plan_not_atomic');
  if (Number(plan.leg_count) !== 2) throw new Error('two_leg_atomic_plan_leg_count_invalid');
  if (!Array.isArray(plan.legs) || plan.legs.length !== 2) throw new Error('two_leg_atomic_plan_legs_invalid');
  const dexes = new Set(plan.legs.map(leg => String(leg?.dex || '').toUpperCase()));
  if (!(dexes.has('ORCA') && dexes.has('RAYDIUM') && dexes.size === 2)) throw new Error('two_leg_atomic_plan_dex_scope_invalid');
  if (plan.signed !== true) throw new Error('two_leg_atomic_plan_signature_required');
  if (!plan.serialized_transaction) throw new Error('two_leg_atomic_plan_transaction_required');
  return plan;
}

export async function dispatchTwoLegLiveExecution({
  decision,
  gateState,
  buildSignedAtomicTransaction,
  submitSignedAtomicTransaction,
  auditWrite,
  env = process.env
} = {}) {
  const audit = requireFunction(auditWrite, 'two_leg_live_audit_writer_required');
  const checkedDecision = requireDecision(decision);

  let gate;
  try {
    gate = assertLiveExecutionAuthorized(gateState, env);
  } catch (error) {
    await audit({
      event_type: 'TWO_LEG_LIVE_EXECUTION_BLOCKED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      blockers: Array.isArray(error.blockers) ? error.blockers : ['LIVE_EXECUTION_GATE_CLOSED']
    });
    throw error;
  }

  const build = requireFunction(buildSignedAtomicTransaction, 'two_leg_atomic_builder_required');
  const submit = requireFunction(submitSignedAtomicTransaction, 'two_leg_atomic_submitter_required');
  const plan = requireAtomicPlan(await build({ decision: checkedDecision, gate }));

  await audit({
    event_type: 'TWO_LEG_LIVE_EXECUTION_AUTHORIZED',
    strategy: STRATEGY,
    dex_pair: DEX_PAIR,
    expected_net_edge_bps: checkedDecision.expected_net_edge_bps,
    atomic: true,
    leg_count: 2,
    gate_schema: gate.schema
  });

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
}

export const TWO_LEG_LIVE_EXECUTION_BOUNDARY = Object.freeze({
  schema: 'aether.two_leg_live_execution_boundary.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  action: ACTION,
  min_expected_net_edge_bps: MIN_NET_EDGE_BPS,
  atomic_required: true,
  leg_count: 2,
  directional_execution_supported: false,
  independent_leg_submission_supported: false,
  fail_closed: true
});
