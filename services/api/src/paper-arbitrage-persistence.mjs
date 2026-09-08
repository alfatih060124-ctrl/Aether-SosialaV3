import { randomUUID } from 'node:crypto';

const finite = (value, code) => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) throw new Error(code);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(code);
  return numeric;
};
const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};
const round8 = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;
const clampInitial = value => Math.max(10, Math.min(100000, Number.isFinite(Number(value)) ? Number(value) : 100));

function assertShadowResult(result) {
  if (!result || typeof result !== 'object') throw new Error('paper_arbitrage_result_required');
  if (result.mode !== 'SHADOW') throw new Error('paper_arbitrage_shadow_mode_required');
  if (result.live_execution_authorized !== false || result.funds_moved !== false || result.execution_dispatched !== false) {
    throw new Error('paper_arbitrage_shadow_invariant_failed');
  }
  if (result.qualified !== true || result.assessment?.decision?.action !== 'ARBITRAGE_SETTLE') {
    throw new Error('paper_arbitrage_qualified_settlement_required');
  }
  const assessment = result.assessment;
  if (assessment.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('paper_arbitrage_strategy_required');
  if (assessment.training_fixture !== false || assessment.market_data_mode !== 'REAL_MARKET_SHADOW') {
    throw new Error('paper_arbitrage_real_market_shadow_required');
  }
  return assessment;
}

export function derivePaperArbitrageAccounting({ result, account, performanceFeeBps }) {
  const assessment = assertShadowResult(result);
  const arb = assessment.arbitrage;
  if (!arb || typeof arb !== 'object') throw new Error('paper_arbitrage_assessment_required');
  if (arb.cost_breakdown?.costs_verified !== true) throw new Error('paper_arbitrage_costs_unverified');
  const buy = arb.buy_route;
  const sell = arb.sell_route;
  const buyDex = text(buy?.dex_id, 'paper_arbitrage_buy_dex_required').toLowerCase();
  const sellDex = text(sell?.dex_id, 'paper_arbitrage_sell_dex_required').toLowerCase();
  if (!['orca','raydium'].includes(buyDex) || !['orca','raydium'].includes(sellDex) || buyDex === sellDex) {
    throw new Error('paper_arbitrage_cross_dex_required');
  }
  const notional = finite(arb.notional_usdc, 'paper_arbitrage_notional_required');
  const finalUsdc = finite(arb.final_usdc, 'paper_arbitrage_final_required');
  const buyPrice = finite(buy.price_usd, 'paper_arbitrage_buy_price_required');
  const sellPrice = finite(sell.price_usd, 'paper_arbitrage_sell_price_required');
  const cashBefore = finite(account?.cash_balance_usdc, 'paper_arbitrage_account_cash_required');
  if (!(notional > 0) || notional > cashBefore) throw new Error('paper_arbitrage_notional_unavailable');
  if (!(buyPrice > 0) || !(sellPrice > 0) || finalUsdc < 0) throw new Error('paper_arbitrage_values_invalid');
  const feeBps = finite(performanceFeeBps, 'paper_arbitrage_performance_fee_bps_required');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('paper_arbitrage_performance_fee_bps_invalid');

  const rawFinalBeforeCosts = notional * (sellPrice / buyPrice);
  const grossProfitBeforeCosts = rawFinalBeforeCosts - notional;
  const marketExecutionCost = Math.max(0, rawFinalBeforeCosts - finalUsdc);
  const marketNetPnl = finalUsdc - notional;
  const performanceFee = marketNetPnl > 0 ? marketNetPnl * feeBps / 10000 : 0;
  const memberNetProfit = marketNetPnl - performanceFee;
  const cashAfter = cashBefore + memberNetProfit;

  return Object.freeze({
    token_mint: text(result.opportunity?.token_mint, 'paper_arbitrage_token_mint_required'),
    quote_mint: text(result.opportunity?.quote_mint, 'paper_arbitrage_quote_mint_required'),
    buy_dex: buyDex,
    sell_dex: sellDex,
    buy_pool: text(buy.pool_address, 'paper_arbitrage_buy_pool_required'),
    sell_pool: text(sell.pool_address, 'paper_arbitrage_sell_pool_required'),
    notional_usdc: round8(notional),
    gross_profit_before_costs_usdc: round8(grossProfitBeforeCosts),
    market_execution_cost_usdc: round8(marketExecutionCost),
    market_net_pnl_usdc: round8(marketNetPnl),
    performance_fee_usdc: round8(performanceFee),
    member_net_profit_usdc: round8(memberNetProfit),
    cash_before_usdc: round8(cashBefore),
    cash_after_usdc: round8(cashAfter),
    gross_edge_bps: finite(arb.gross_edge_bps, 'paper_arbitrage_gross_edge_required'),
    net_edge_bps: finite(arb.net_edge_bps, 'paper_arbitrage_net_edge_required'),
    network_fee_usdc: finite(arb.cost_breakdown.network_fee_usdc, 'paper_arbitrage_network_fee_required'),
    cost_breakdown: Object.freeze({ ...arb.cost_breakdown }),
    market_source: text(assessment.market_source, 'paper_arbitrage_market_source_required'),
    observed_at: text(assessment.observed_at, 'paper_arbitrage_observed_at_required'),
    assessment: Object.freeze({
      verdict: assessment.assessment?.verdict || null,
      quality_score: assessment.assessment?.quality_score ?? null,
      reason_codes: Object.freeze([...(assessment.decision?.reason_codes || [])])
    }),
    cycles_closed_delta: 1,
    profitable_cycles_delta: memberNetProfit > 0 ? 1 : 0,
    losing_cycles_delta: memberNetProfit < 0 ? 1 : 0,
    performance_fee_bps: feeBps,
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    execution_dispatched: false,
    funds_moved: false,
    live_execution_authorized: false
  });
}

async function ensureAccount(client, userId, initialBalanceUsdc) {
  const initial = clampInitial(initialBalanceUsdc);
  await client.query(`
    INSERT INTO member_paper_arbitrage_accounts(user_id,initial_balance_usdc,cash_balance_usdc)
    VALUES($1,$2,$2) ON CONFLICT(user_id) DO NOTHING
  `,[userId,initial]);
  const row = (await client.query(`SELECT * FROM member_paper_arbitrage_accounts WHERE user_id=$1 FOR UPDATE`,[userId])).rows[0];
  if (!row) throw new Error('paper_arbitrage_account_unavailable');
  if (row.mode !== 'SHADOW' || row.strategy !== 'TWO_LEG_ARBITRAGE' || row.live_execution_authorized !== false) {
    throw new Error('paper_arbitrage_account_invariant_failed');
  }
  return row;
}

export async function persistQualifiedPaperArbitrage(pool, session, result, { performanceFeeBps, initialBalanceUsdc = 100, idempotencyKey } = {}) {
  if (!pool || !session?.user_id) throw new Error('paper_arbitrage_authenticated_session_required');
  const stableKey = text(idempotencyKey, 'paper_arbitrage_idempotency_key_required');
  if (stableKey.length > 200) throw new Error('paper_arbitrage_idempotency_key_invalid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureAccount(client, session.user_id, initialBalanceUsdc);
    const existing = (await client.query(`
      SELECT * FROM member_paper_arbitrage_cycles
      WHERE user_id=$1 AND idempotency_key=$2
      LIMIT 1
    `,[session.user_id,stableKey])).rows[0];
    if (existing) {
      await client.query('COMMIT');
      return Object.freeze({
        account,
        cycle: existing,
        accounting: null,
        duplicate: true,
        mode: 'SHADOW',
        funds_moved: false,
        live_execution_authorized: false
      });
    }

    const record = derivePaperArbitrageAccounting({ result, account, performanceFeeBps });
    const updated = (await client.query(`
      UPDATE member_paper_arbitrage_accounts SET
        cash_balance_usdc=$2,
        realized_market_pnl_usdc=realized_market_pnl_usdc+$3,
        performance_fees_usdc=performance_fees_usdc+$4,
        member_net_pnl_usdc=member_net_pnl_usdc+$5,
        cycles_closed=cycles_closed+$6,
        profitable_cycles=profitable_cycles+$7,
        losing_cycles=losing_cycles+$8,
        updated_at=now()
      WHERE user_id=$1 RETURNING *
    `,[session.user_id,record.cash_after_usdc,record.market_net_pnl_usdc,record.performance_fee_usdc,record.member_net_profit_usdc,1,record.profitable_cycles_delta,record.losing_cycles_delta])).rows[0];
    const cycle = (await client.query(`
      INSERT INTO member_paper_arbitrage_cycles(
        cycle_id,user_id,idempotency_key,token_mint,quote_mint,buy_dex,sell_dex,buy_pool,sell_pool,notional_usdc,
        gross_profit_before_costs_usdc,market_execution_cost_usdc,market_net_pnl_usdc,performance_fee_usdc,
        member_net_profit_usdc,gross_edge_bps,net_edge_bps,network_fee_usdc,cost_breakdown,assessment,
        market_source,observed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22) RETURNING *
    `,[randomUUID(),session.user_id,stableKey,record.token_mint,record.quote_mint,record.buy_dex,record.sell_dex,record.buy_pool,record.sell_pool,
      record.notional_usdc,record.gross_profit_before_costs_usdc,record.market_execution_cost_usdc,record.market_net_pnl_usdc,
      record.performance_fee_usdc,record.member_net_profit_usdc,record.gross_edge_bps,record.net_edge_bps,record.network_fee_usdc,
      JSON.stringify(record.cost_breakdown),JSON.stringify(record.assessment),record.market_source,record.observed_at])).rows[0];
    await client.query('COMMIT');
    return Object.freeze({ account: updated, cycle, accounting: record, duplicate: false, mode: 'SHADOW', funds_moved: false, live_execution_authorized: false });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function persistQualifiedPaperArbitrageProbe(pool, session, candidate, { performanceFeeBps, initialBalanceUsdc = 100, idempotencyKey } = {}) {
  if (!pool || !session?.user_id) throw new Error('paper_arbitrage_authenticated_session_required');
  const stableKey = text(idempotencyKey, 'paper_arbitrage_idempotency_key_required');
  if (stableKey.length > 200) throw new Error('paper_arbitrage_idempotency_key_invalid');
  if (!candidate || typeof candidate !== 'object') throw new Error('paper_arbitrage_probe_candidate_required');
  if (candidate.mode !== 'SHADOW' || candidate.execution_dispatched !== false || candidate.transaction_signed !== false || candidate.network_submission_authorized !== false || candidate.live_execution_authorized !== false) {
    throw new Error('paper_arbitrage_probe_shadow_invariant_failed');
  }
  if (candidate.net_edge_gate_passed !== true || candidate.costs_verified !== true || candidate.exact_transaction_fee_ready !== true) {
    throw new Error('paper_arbitrage_probe_verification_required');
  }
  const netEdge = finite(candidate.expected_net_edge_bps, 'paper_arbitrage_probe_net_edge_required');
  if (netEdge < 20) throw new Error('paper_arbitrage_probe_net_edge_below_floor');
  const grossEdge = finite(candidate.gross_executable_spread_bps, 'paper_arbitrage_probe_gross_edge_required');
  const notional = finite(candidate.notional_usdc, 'paper_arbitrage_probe_notional_required');
  const grossProfit = finite(candidate.gross_profit_before_costs_usdc, 'paper_arbitrage_probe_gross_profit_required');
  const executionCost = finite(candidate.market_execution_cost_usdc, 'paper_arbitrage_probe_execution_cost_required');
  const marketNetPnl = finite(candidate.market_net_pnl_usdc, 'paper_arbitrage_probe_market_net_pnl_required');
  const networkFee = finite(candidate.network_fee_usdc, 'paper_arbitrage_probe_network_fee_required');
  if (!(notional > 0) || executionCost < 0 || networkFee < 0) throw new Error('paper_arbitrage_probe_values_invalid');
  const buyDex = text(candidate.buy_dex, 'paper_arbitrage_probe_buy_dex_required').toLowerCase();
  const sellDex = text(candidate.sell_dex, 'paper_arbitrage_probe_sell_dex_required').toLowerCase();
  if (!['orca','raydium'].includes(buyDex) || !['orca','raydium'].includes(sellDex) || buyDex === sellDex) throw new Error('paper_arbitrage_probe_cross_dex_required');
  const feeBps = finite(performanceFeeBps, 'paper_arbitrage_performance_fee_bps_required');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('paper_arbitrage_performance_fee_bps_invalid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureAccount(client, session.user_id, initialBalanceUsdc);
    const existing = (await client.query(`SELECT * FROM member_paper_arbitrage_cycles WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1`, [session.user_id, stableKey])).rows[0];
    if (existing) {
      await client.query('COMMIT');
      return Object.freeze({ account, cycle: existing, duplicate: true, mode: 'SHADOW', funds_moved: false, live_execution_authorized: false });
    }
    const cashBefore = finite(account.cash_balance_usdc, 'paper_arbitrage_account_cash_required');
    if (notional > cashBefore) throw new Error('paper_arbitrage_notional_unavailable');
    const performanceFee = marketNetPnl > 0 ? marketNetPnl * feeBps / 10000 : 0;
    const memberNetProfit = marketNetPnl - performanceFee;
    const cashAfter = cashBefore + memberNetProfit;
    if (cashAfter < 0) throw new Error('paper_arbitrage_account_negative_cash');
    const updated = (await client.query(`
      UPDATE member_paper_arbitrage_accounts SET
        cash_balance_usdc=$2,realized_market_pnl_usdc=realized_market_pnl_usdc+$3,
        performance_fees_usdc=performance_fees_usdc+$4,member_net_pnl_usdc=member_net_pnl_usdc+$5,
        cycles_closed=cycles_closed+1,profitable_cycles=profitable_cycles+$6,losing_cycles=losing_cycles+$7,updated_at=now()
      WHERE user_id=$1 RETURNING *
    `,[session.user_id,round8(cashAfter),round8(marketNetPnl),round8(performanceFee),round8(memberNetProfit),memberNetProfit>0?1:0,memberNetProfit<0?1:0])).rows[0];
    const costBreakdown = Object.freeze({
      source: 'REAL_MARKET_SHADOW_NET_EDGE_PROBE',
      costs_verified: true,
      network_fee_usdc: round8(networkFee),
      market_execution_cost_usdc: round8(executionCost),
      exact_transaction_fee_ready: true
    });
    const assessment = Object.freeze({
      verdict: 'QUALIFIED',
      quality_score: null,
      reason_codes: Object.freeze(['NET_EDGE_GATE_PASSED','REAL_MARKET_SHADOW','ORCA_RAYDIUM'])
    });
    const cycle = (await client.query(`
      INSERT INTO member_paper_arbitrage_cycles(
        cycle_id,user_id,idempotency_key,token_mint,quote_mint,buy_dex,sell_dex,buy_pool,sell_pool,notional_usdc,
        gross_profit_before_costs_usdc,market_execution_cost_usdc,market_net_pnl_usdc,performance_fee_usdc,
        member_net_profit_usdc,gross_edge_bps,net_edge_bps,network_fee_usdc,cost_breakdown,assessment,market_source,observed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22) RETURNING *
    `,[randomUUID(),session.user_id,stableKey,text(candidate.token_mint,'paper_arbitrage_probe_token_mint_required'),text(candidate.quote_mint,'paper_arbitrage_probe_quote_mint_required'),buyDex,sellDex,
      text(candidate.buy_pool_address,'paper_arbitrage_probe_buy_pool_required'),text(candidate.sell_pool_address,'paper_arbitrage_probe_sell_pool_required'),round8(notional),round8(grossProfit),round8(executionCost),round8(marketNetPnl),round8(performanceFee),round8(memberNetProfit),grossEdge,netEdge,round8(networkFee),JSON.stringify(costBreakdown),JSON.stringify(assessment),'REAL_MARKET_SHADOW_NET_EDGE_PROBE',text(candidate.observed_at,'paper_arbitrage_probe_observed_at_required')])).rows[0];
    await client.query('COMMIT');
    return Object.freeze({ account: updated, cycle, duplicate: false, mode: 'SHADOW', funds_moved: false, live_execution_authorized: false });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function getPaperArbitragePerformance(pool, userId, { limit = 50 } = {}) {
  if (!pool || !userId) throw new Error('paper_arbitrage_account_required');
  const client = await pool.connect();
  try {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const account = (await client.query(`SELECT * FROM member_paper_arbitrage_accounts WHERE user_id=$1`,[userId])).rows[0] || null;
    const history = (await client.query(`
      SELECT cycle_id,idempotency_key,token_mint,quote_mint,buy_dex,sell_dex,buy_pool,sell_pool,notional_usdc,
        gross_profit_before_costs_usdc,market_execution_cost_usdc,market_net_pnl_usdc,performance_fee_usdc,
        member_net_profit_usdc,gross_edge_bps,net_edge_bps,network_fee_usdc,market_source,observed_at,created_at
      FROM member_paper_arbitrage_cycles WHERE user_id=$1 ORDER BY observed_at DESC,created_at DESC LIMIT $2
    `,[userId,safeLimit])).rows;
    const periods = (await client.query(`
      SELECT
        COALESCE(SUM(member_net_profit_usdc) FILTER (WHERE observed_at >= date_trunc('day',now())),0) AS today_net_pnl_usdc,
        COALESCE(SUM(member_net_profit_usdc) FILTER (WHERE observed_at >= now()-interval '7 days'),0) AS pnl_7d_usdc,
        COALESCE(SUM(member_net_profit_usdc) FILTER (WHERE observed_at >= now()-interval '30 days'),0) AS pnl_30d_usdc,
        COALESCE(SUM(member_net_profit_usdc),0) AS all_time_net_pnl_usdc,
        COUNT(*)::int AS total_cycles,
        COUNT(*) FILTER (WHERE member_net_profit_usdc > 0)::int AS profitable_cycles,
        COUNT(*) FILTER (WHERE member_net_profit_usdc < 0)::int AS losing_cycles,
        AVG(net_edge_bps) AS avg_net_edge_bps,
        COALESCE(SUM(gross_profit_before_costs_usdc),0) AS gross_profit_before_costs_usdc,
        COALESCE(SUM(market_execution_cost_usdc),0) AS market_execution_cost_usdc,
        COALESCE(SUM(performance_fee_usdc),0) AS performance_fees_usdc
      FROM member_paper_arbitrage_cycles WHERE user_id=$1
    `,[userId])).rows[0];
    return Object.freeze({
      account,
      periods,
      history,
      mode: 'SHADOW',
      strategy: 'TWO_LEG_ARBITRAGE',
      currency: 'USDC_DEMO',
      persistent: true,
      aether_execution_fee_usdc: null,
      execution_fee_status: 'NOT_CONFIGURED_IN_THIS_SCOPE',
      funds_moved: false,
      live_execution_authorized: false
    });
  } finally {
    client.release();
  }
}

export const PAPER_ARBITRAGE_PERSISTENCE = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dedicated_ledger: true,
  legacy_training_positions_reused: false,
  persists_only_qualified_cycles: true,
  idempotency_key_required: true,
  performance_time_basis: 'OBSERVED_AT',
  performance_windows: Object.freeze(['TODAY','7D','30D','ALL_TIME']),
  transaction_count_cap: null,
  funds_moved: false,
  live_execution_authorized: false
});
