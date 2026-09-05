import { randomUUID } from 'node:crypto';
import { settleDemoArbitrage, demoEquity } from './demo-autotrade-ledger.mjs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const signed = value => `${Number(value) >= 0 ? '+' : ''}${asNumber(value).toFixed(4)}`;

async function feeConfig(client) {
  const q = await client.query(`SELECT performance_fee_bps FROM platform_fee_config WHERE config_id=1 AND enabled=true LIMIT 1`);
  const bps = Number(q.rows[0]?.performance_fee_bps ?? 1000);
  return Number.isInteger(bps) && bps >= 0 && bps <= 10000 ? bps : 1000;
}

async function ensureAccount(client, userId, requestedInitialBalance) {
  const initial = clamp(Number.isFinite(Number(requestedInitialBalance)) ? Number(requestedInitialBalance) : 100, 10, 100000);
  await client.query(`
    INSERT INTO member_autotrade_demo_accounts(user_id,initial_balance_usdc,cash_balance_usdc)
    VALUES($1,$2,$2)
    ON CONFLICT(user_id) DO NOTHING
  `,[userId,initial]);
  const q = await client.query(`SELECT * FROM member_autotrade_demo_accounts WHERE user_id=$1 FOR UPDATE`,[userId]);
  if (!q.rows[0]) throw new Error('demo_account_unavailable');
  return q.rows[0];
}

function projectAccount(account, feeBps, history = []) {
  const initial = asNumber(account.initial_balance_usdc);
  const realized = asNumber(account.realized_net_pnl_usdc);
  const closed = Number(account.trades_closed || 0);
  const wins = Number(account.winning_trades || 0);
  return Object.freeze({
    user_id: account.user_id,
    initial_balance_usdc: initial,
    cash_balance_usdc: asNumber(account.cash_balance_usdc),
    balance_usdc: demoEquity(account),
    realized_net_pnl_usdc: realized,
    performance_fees_usdc: asNumber(account.performance_fees_usdc),
    return_bps: initial > 0 ? Math.round(realized / initial * 10000) : 0,
    trades_closed: closed,
    winning_trades: wins,
    losing_trades: Number(account.losing_trades || 0),
    win_rate_bps: closed > 0 ? Math.round(wins / closed * 10000) : null,
    open_position: account.open_position || {},
    performance_fee_bps: feeBps,
    history,
    mode: 'SHADOW',
    strategy: 'TWO_LEG_ARBITRAGE',
    currency: 'USDC_DEMO',
    persistent: true,
    funds_moved: false,
    live_execution_authorized: false
  });
}

export async function getMemberAutoTradeDemoState(pool, userId, { limit = 20 } = {}) {
  if (!pool || !userId) throw new Error('demo_account_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureAccount(client, userId, 100);
    const feeBps = await feeConfig(client);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const history = (await client.query(`
      SELECT trade_id,scenario,engine_action,settlement_status,notional_usdc,gross_pnl_usdc,performance_fee_usdc,net_pnl_usdc,pnl_bps,balance_before_usdc,balance_after_usdc,created_at
      FROM member_autotrade_demo_trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2
    `,[userId,safeLimit])).rows;
    await client.query('COMMIT');
    return projectAccount(account, feeBps, history);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function rejectedSettlement(account) {
  const balance = demoEquity(account);
  return Object.freeze({
    settlement_status: 'REJECTED',
    notional_usdc: 0,
    gross_pnl_usdc: 0,
    performance_fee_usdc: 0,
    net_pnl_usdc: 0,
    pnl_bps: null,
    balance_before_usdc: balance,
    balance_after_usdc: balance,
    cash_balance_usdc: asNumber(account.cash_balance_usdc),
    open_position: Object.freeze(account.open_position && typeof account.open_position === 'object' ? account.open_position : {}),
    trades_closed_delta: 0,
    winning_trades_delta: 0,
    losing_trades_delta: 0
  });
}

export async function runMemberAutoTradeDemoStep(pool, session, input = {}, { realMarketRuntime } = {}) {
  if (!pool || !session?.user_id) throw new Error('authenticated_session_required');
  if (!realMarketRuntime || typeof realMarketRuntime.runNextOpportunity !== 'function') throw new Error('real_market_shadow_runtime_unconfigured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureAccount(client, session.user_id, input.capital_usd ?? 100);
    if (asNumber(account?.open_position?.notional_usdc) > 0) throw new Error('legacy_demo_open_position_requires_reset');
    const feeBps = await feeConfig(client);

    const result = await realMarketRuntime.runNextOpportunity({ demo_account: account });
    if (result?.mode !== 'SHADOW' || result?.strategy !== 'TWO_LEG_ARBITRAGE' || result?.live_execution_authorized !== false || result?.funds_moved !== false) {
      throw new Error('demo_shadow_invariant_failed');
    }

    const selected = result.selected || null;
    const assessment = selected?.assessment || null;
    const arbitrage = assessment?.arbitrage || null;
    const settlement = selected
      ? settleDemoArbitrage({
          account,
          notionalUsdc: arbitrage?.notional_usdc,
          finalUsdc: arbitrage?.final_usdc,
          performanceFeeBps: feeBps
        })
      : rejectedSettlement(account);

    const updated = (await client.query(`
      UPDATE member_autotrade_demo_accounts SET
        cash_balance_usdc=$2,
        realized_net_pnl_usdc=realized_net_pnl_usdc+$3,
        performance_fees_usdc=performance_fees_usdc+$4,
        trades_closed=trades_closed+$5,
        winning_trades=winning_trades+$6,
        losing_trades=losing_trades+$7,
        open_position=$8::jsonb,
        updated_at=now()
      WHERE user_id=$1 RETURNING *
    `,[
      session.user_id,
      settlement.cash_balance_usdc,
      settlement.net_pnl_usdc,
      settlement.performance_fee_usdc,
      settlement.trades_closed_delta,
      settlement.winning_trades_delta,
      settlement.losing_trades_delta,
      JSON.stringify(settlement.open_position)
    ])).rows[0];

    const decision = assessment?.decision || Object.freeze({ action: 'REJECT', reason_codes: Object.freeze(['NO_QUALIFIED_REAL_MARKET_OPPORTUNITY']) });
    const opportunity = selected?.opportunity || null;
    const engineAction = selected ? 'ARBITRAGE_SETTLE' : 'REJECT';
    const trade = (await client.query(`
      INSERT INTO member_autotrade_demo_trades(
        trade_id,user_id,scenario,engine_action,settlement_status,notional_usdc,gross_pnl_usdc,
        performance_fee_usdc,net_pnl_usdc,pnl_bps,balance_before_usdc,balance_after_usdc,engine_result
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *
    `,[
      randomUUID(),session.user_id,'REAL_MARKET_ORCA_RAYDIUM',engineAction,
      settlement.settlement_status,settlement.notional_usdc,settlement.gross_pnl_usdc,
      settlement.performance_fee_usdc,settlement.net_pnl_usdc,settlement.pnl_bps,
      settlement.balance_before_usdc,settlement.balance_after_usdc,JSON.stringify({
        token_mint: opportunity?.token_mint ?? null,
        quote_mint: opportunity?.quote_mint ?? null,
        buy_dex: opportunity?.buy_route?.dex_id ?? null,
        sell_dex: opportunity?.sell_route?.dex_id ?? null,
        expected_net_edge_bps: arbitrage?.expected_net_edge_bps ?? arbitrage?.net_edge_bps ?? null,
        reason_codes: decision?.reason_codes ?? [],
        qualified_count: result.qualified_count ?? 0,
        candidate_count: result.candidate_count ?? 0,
        market_source: result.market_source ?? null,
        discovery_source: result.discovery_source ?? null,
        discovery_execution_ready: false,
        benchmark_source: 'REAL_MARKET_SHADOW',
        training_fixture: false,
        strategy: 'TWO_LEG_ARBITRAGE',
        execution_dispatched: false,
        funds_moved: false,
        live_execution_authorized: false
      })
    ])).rows[0];

    await client.query('COMMIT');
    const wallet = projectAccount(updated, feeBps);
    const edge = arbitrage?.expected_net_edge_bps ?? arbitrage?.net_edge_bps;
    const label = selected
      ? `ORCA ↔ Raydium arbitrage · NET edge ${Number.isFinite(Number(edge)) ? (Number(edge) / 100).toFixed(2) : '—'}% · Demo balance ${wallet.balance_usdc.toFixed(4)} USDC · Net PnL ${signed(settlement.net_pnl_usdc)} · Performance fee ${settlement.performance_fee_usdc.toFixed(4)} USDC`
      : `No qualified ORCA ↔ Raydium opportunity · Demo balance ${wallet.balance_usdc.toFixed(4)} USDC`;

    return Object.freeze({
      decision,
      assessment,
      opportunity,
      scenario_label: label,
      demo_wallet: wallet,
      demo_trade: trade,
      qualified: Boolean(selected),
      candidate_count: result.candidate_count ?? 0,
      qualified_count: result.qualified_count ?? 0,
      market_source: result.market_source ?? null,
      simulator_runtime: 'PRIMARY_VM_REAL_MARKET_TWO_LEG_SHADOW',
      authenticated_session: true,
      mode: 'SHADOW',
      strategy: 'TWO_LEG_ARBITRAGE',
      execution_dispatched: false,
      transaction_created: false,
      signer_requested: false,
      funds_moved: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
