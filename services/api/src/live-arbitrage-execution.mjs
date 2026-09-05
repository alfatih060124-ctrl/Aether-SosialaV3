const HARD_MIN_NET_EDGE_BPS = 20;
const ALLOWED_DEX = new Set(['orca', 'raydium']);

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const normalizeDex = value => String(value || '').trim().toLowerCase();

function assertArbitrageContract(result) {
  if (!result || typeof result !== 'object') throw new Error('live_arbitrage_result_required');
  if (result.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('live_strategy_mismatch');
  if (result.market_data_mode !== 'REAL_MARKET_SHADOW') throw new Error('live_real_market_shadow_source_required');
  if (result.training_fixture === true) throw new Error('live_fixture_forbidden');
  if (result.assessment?.verdict !== 'QUALIFIED') throw new Error('live_signal_not_qualified');
  if (result.decision?.action !== 'ARBITRAGE_SETTLE') throw new Error('live_arbitrage_settlement_required');
  if (finite(result.arbitrage?.net_edge_bps, -Infinity) < HARD_MIN_NET_EDGE_BPS) throw new Error('live_net_edge_below_minimum');

  const buy = result.arbitrage?.buy_route || {};
  const sell = result.arbitrage?.sell_route || {};
  const buyDex = normalizeDex(buy.dex_id);
  const sellDex = normalizeDex(sell.dex_id);
  if (!ALLOWED_DEX.has(buyDex) || !ALLOWED_DEX.has(sellDex)) throw new Error('live_dex_not_allowed');
  if (buyDex === sellDex) throw new Error('live_cross_dex_required');
  if (buy.quote_verified !== true || sell.quote_verified !== true) throw new Error('live_quote_unverified');
  if (result.arbitrage?.cost_breakdown?.costs_verified !== true) throw new Error('live_costs_unverified');

  return { buy, sell, buyDex, sellDex };
}

export function getLiveArbitrageGate(env = process.env) {
  const executionMode = String(env.EXECUTION_MODE || 'SHADOW').toUpperCase();
  const liveEnabled = env.LIVE_ENABLED === 'true';
  const fixtureGatePassed = env.FIXTURE_GATE_PASSED === 'true';
  const operatorApproved = env.OPERATOR_APPROVED === 'true';
  const realMoneyApproved = env.REAL_MONEY_APPROVED === 'true';
  const ready = executionMode === 'LIVE' && liveEnabled && fixtureGatePassed && operatorApproved && realMoneyApproved;
  return Object.freeze({
    execution_mode: executionMode,
    live_enabled: liveEnabled,
    fixture_gate_passed: fixtureGatePassed,
    operator_approved: operatorApproved,
    real_money_approved: realMoneyApproved,
    ready,
    fail_closed: !ready,
    allowed_dex: Object.freeze(['ORCA', 'RAYDIUM']),
    minimum_expected_net_edge_bps: HARD_MIN_NET_EDGE_BPS
  });
}

export function buildLiveArbitrageIntent({ result, member, env = process.env }) {
  const gate = getLiveArbitrageGate(env);
  if (!gate.ready) throw new Error('live_execution_gate_closed');
  if (!member?.user_id || !member?.primary_wallet) throw new Error('live_member_session_required');
  const routes = assertArbitrageContract(result);

  return Object.freeze({
    type: 'AETHER_LIVE_TWO_LEG_ARBITRAGE',
    strategy: 'TWO_LEG_ARBITRAGE',
    member_user_id: member.user_id,
    wallet_address: member.primary_wallet,
    token_mint: result.assessment?.token_mint || result.assessment?.snapshot?.token_mint || null,
    quote_mint: result.assessment?.snapshot?.quote_mint || null,
    notional_usdc: result.arbitrage.notional_usdc,
    expected_net_edge_bps: result.arbitrage.net_edge_bps,
    buy_route: Object.freeze({ ...routes.buy, dex_id: routes.buyDex }),
    sell_route: Object.freeze({ ...routes.sell, dex_id: routes.sellDex }),
    cost_breakdown: result.arbitrage.cost_breakdown,
    observed_at: result.observed_at,
    quote_verified: true,
    requires_wallet_signature: true,
    requires_atomic_or_fail_closed_execution: true,
    funds_moved: false,
    transaction_submitted: false
  });
}

export async function executeLiveArbitrage({ result, member, transactionExecutor, env = process.env }) {
  const intent = buildLiveArbitrageIntent({ result, member, env });
  if (!transactionExecutor || typeof transactionExecutor.executeAtomicArbitrage !== 'function') {
    throw new Error('live_transaction_executor_unavailable');
  }
  const execution = await transactionExecutor.executeAtomicArbitrage(intent);
  if (!execution || execution.submitted !== true || !String(execution.signature || '').trim()) {
    throw new Error('live_transaction_submission_unverified');
  }
  return Object.freeze({
    mode: 'LIVE',
    strategy: 'TWO_LEG_ARBITRAGE',
    transaction_signature: String(execution.signature),
    submitted: true,
    member_user_id: intent.member_user_id,
    wallet_address: intent.wallet_address,
    buy_dex: intent.buy_route.dex_id,
    sell_dex: intent.sell_route.dex_id,
    expected_net_edge_bps: intent.expected_net_edge_bps,
    submitted_at: execution.submitted_at || new Date().toISOString()
  });
}

export const LIVE_ARBITRAGE_MIN_NET_EDGE_BPS = HARD_MIN_NET_EDGE_BPS;
