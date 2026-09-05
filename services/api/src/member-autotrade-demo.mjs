import { randomUUID } from 'node:crypto';
import { runRealMarketShadowStep } from './real-market-shadow-demo.mjs';
import { settleDemoAction, demoEquity } from './demo-autotrade-ledger.mjs';

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
    market_data_mode: 'REAL_MARKET',
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
      SELECT trade_id,scenario,engine_action,settlement_status,notional_usdc,gross_pnl_usdc,performance_fee_usdc,net_pnl_usdc,pnl_bps,balance_before_usdc,balance_after_usdc,engine_result,created_at
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

export async function runMemberAutoTradeDemoStep(pool, session, input = {}) {
  if (!pool || !session?.user_id) throw new Error('authenticated_session_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureAccount(client, session.user_id, input.capital_usd ?? 100);
    const feeBps = await feeConfig(client);
    const result = await runRealMarketShadowStep({ account, input });
    if (result?.mode !== 'SHADOW' || result?.market_data_mode !== 'REAL_MARKET' || result?.training_fixture !== false || result?.live_execution_authorized !== false || result?.funds_moved !== false) {
      throw new Error('demo_real_market_shadow_invariant_failed');
    }

    const settlement = settleDemoAction({
      account,
      engineAction: result.decision?.action,
      requestedAmountUsdc: result.decision?.requested_amount_usd,
      positionPnlBps: result.position?.unrealized_pnl_bps,
      performanceFeeBps: feeBps
    });

    let nextOpenPosition = settlement.open_position;
    if (settlement.settlement_status === 'OPENED' && result.open_position_metadata) {
      nextOpenPosition = { ...settlement.open_position, ...result.open_position_metadata };
    } else if (settlement.settlement_status === 'HELD' && result.open_position_metadata && asNumber(account.open_position?.notional_usdc) > 0) {
      nextOpenPosition = { ...account.open_position, ...result.open_position_metadata };
    }

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
      JSON.stringify(nextOpenPosition)
    ])).rows[0];

    const engineResult = {
      market_data_mode: 'REAL_MARKET',
      market_source: result.market_source,
      observed_at: result.observed_at,
      token_mint: result.assessment?.snapshot?.mint || result.open_position_metadata?.token_mint || account.open_position?.token_mint || null,
      expected_net_edge_bps: result.assessment?.expected_net_edge_bps ?? account.open_position?.expected_net_edge_bps ?? null,
      minimum_expected_net_edge_bps: result.assessment?.minimum_expected_net_edge_bps ?? 20,
      buy_pool: result.assessment?.snapshot?.buy_pool || null,
      sell_pool: result.assessment?.snapshot?.sell_pool || null,
      reason_codes: result.decision?.reason_codes ?? [],
      training_fixture: false,
      execution_dispatched: false,
      funds_moved: false,
      live_execution_authorized: false
    };

    const trade = (await client.query(`
      INSERT INTO member_autotrade_demo_trades(
        trade_id,user_id,scenario,engine_action,settlement_status,notional_usdc,gross_pnl_usdc,
        performance_fee_usdc,net_pnl_usdc,pnl_bps,balance_before_usdc,balance_after_usdc,engine_result
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *
    `,[
      randomUUID(),session.user_id,String(result.scenario),String(result.decision?.action || 'REJECT'),
      settlement.settlement_status,settlement.notional_usdc,settlement.gross_pnl_usdc,
      settlement.performance_fee_usdc,settlement.net_pnl_usdc,settlement.pnl_bps,
      settlement.balance_before_usdc,settlement.balance_after_usdc,JSON.stringify(engineResult)
    ])).rows[0];

    await client.query('COMMIT');
    const wallet = projectAccount(updated, feeBps);
    const walletLabel = `${result.scenario_label} · Demo balance ${wallet.balance_usdc.toFixed(4)} USDC · Net PnL ${signed(settlement.net_pnl_usdc)} · Performance fee ${settlement.performance_fee_usdc.toFixed(4)} USDC`;
    return Object.freeze({
      ...result,
      scenario_label: walletLabel,
      demo_wallet: wallet,
      demo_trade: trade,
      simulator_runtime: 'PRIMARY_VM_REAL_MARKET_SHADOW',
      authenticated_session: true,
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
