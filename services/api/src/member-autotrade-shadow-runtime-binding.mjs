import { createHash } from 'node:crypto';
import { getMemberAutoTradeState, commandMemberAutoTradeState } from './member-autotrade-state-machine.mjs';
import { getPaperArbitragePerformance, persistQualifiedPaperArbitrage } from './paper-arbitrage-persistence.mjs';

const finite = (value, code) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return number;
};

function expectedNetEdge(item) {
  const value = Number(item?.assessment?.arbitrage?.expected_net_edge_bps ?? item?.assessment?.arbitrage?.net_edge_bps);
  return Number.isFinite(value) ? value : -Infinity;
}

function assertSelected(selected) {
  if (!selected) return null;
  if (selected.mode !== 'SHADOW' || selected.qualified !== true || selected.live_execution_authorized !== false) {
    throw new Error('member_shadow_selected_invariant_failed');
  }
  if (selected.assessment?.decision?.action !== 'ARBITRAGE_SETTLE') throw new Error('member_shadow_selected_not_qualified');
  return selected;
}

function assertShadowRuntimeResult(result) {
  if (!result || typeof result !== 'object') throw new Error('member_shadow_runtime_result_required');
  if (result.mode !== 'SHADOW' || result.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('member_shadow_runtime_invariant_failed');
  if (result.execution_dispatched !== false || result.funds_moved !== false || result.network_submission_authorized !== false || result.live_execution_authorized !== false) {
    throw new Error('member_shadow_runtime_invariant_failed');
  }
  assertSelected(result.selected);
  return result;
}

async function runCompatibleShadowRuntime({ runtime, demoAccount, pair }) {
  if (!runtime || typeof runtime !== 'object') throw new Error('member_shadow_runtime_required');
  if (typeof runtime.runNextOpportunity === 'function') {
    return assertShadowRuntimeResult(await runtime.runNextOpportunity({ demo_account: demoAccount }));
  }
  if (typeof runtime.scanAndQualifyPair === 'function') {
    if (!pair?.token_mint || !pair?.quote_mint) throw new Error('member_shadow_runtime_pair_required');
    const scan = await runtime.scanAndQualifyPair({ token_mint: pair.token_mint, quote_mint: pair.quote_mint, demo_account: demoAccount });
    if (!scan || scan.mode !== 'SHADOW' || scan.strategy !== 'TWO_LEG_ARBITRAGE' || scan.live_execution_authorized !== false) {
      throw new Error('member_shadow_runtime_invariant_failed');
    }
    const qualified = (scan.results || []).filter(item => item?.qualified === true && item?.assessment?.decision?.action === 'ARBITRAGE_SETTLE');
    qualified.sort((a, b) => expectedNetEdge(b) - expectedNetEdge(a));
    const selected = assertSelected(qualified[0] || null);
    return assertShadowRuntimeResult(Object.freeze({
      selected,
      qualified_count: qualified.length,
      candidate_count: Array.isArray(scan.results) ? scan.results.length : 0,
      mode: 'SHADOW',
      strategy: 'TWO_LEG_ARBITRAGE',
      execution_dispatched: false,
      funds_moved: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    }));
  }
  if (typeof runtime.scanPair === 'function') throw new Error('member_shadow_qualification_runtime_required');
  throw new Error('member_shadow_runtime_required');
}

function stableCycleKey(selected) {
  const payload = JSON.stringify({
    token_mint: selected?.opportunity?.token_mint || null,
    quote_mint: selected?.opportunity?.quote_mint || null,
    market_source: selected?.assessment?.market_source || null,
    observed_at: selected?.assessment?.observed_at || null,
    buy_pool: selected?.assessment?.arbitrage?.buy_route?.pool_address || null,
    sell_pool: selected?.assessment?.arbitrage?.sell_route?.pool_address || null,
    net_edge_bps: selected?.assessment?.arbitrage?.net_edge_bps ?? null
  });
  return `shadow:${createHash('sha256').update(payload).digest('hex')}`;
}

export async function runMemberAutoTradeShadowTick({
  pool,
  session,
  runtime,
  pair = null,
  performanceFeeBps = 1000,
  initialBalanceUsdc = 100
} = {}) {
  if (!pool) throw new Error('database_unconfigured');
  if (!session?.user_id || !session?.primary_wallet) throw new Error('session_required');
  const initialBalance = finite(initialBalanceUsdc, 'member_shadow_initial_balance_invalid');
  if (!(initialBalance > 0)) throw new Error('member_shadow_initial_balance_invalid');

  const state = await getMemberAutoTradeState(pool, session);
  if (state.state !== 'RUNNING_SCANNING' || state.stop_requested) {
    return Object.freeze({
      status: 'NOOP',
      reason: 'AUTOTRADE_NOT_RUNNING_SCANNING',
      state,
      mode: 'SHADOW',
      execution_dispatched: false,
      funds_moved: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  try {
    const performance = await getPaperArbitragePerformance(pool, session.user_id, { limit: 1 });
    const demoAccount = performance.account || { cash_balance_usdc: initialBalance };
    const result = await runCompatibleShadowRuntime({ runtime, demoAccount, pair });

    if (!result.selected) {
      return Object.freeze({
        status: 'SCANNING',
        reason: 'NO_QUALIFIED_OPPORTUNITY',
        candidate_count: Number(result.candidate_count || 0),
        qualified_count: Number(result.qualified_count || 0),
        state: await getMemberAutoTradeState(pool, session),
        mode: 'SHADOW',
        execution_dispatched: false,
        funds_moved: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }

    await commandMemberAutoTradeState(pool, session, 'BEGIN_EXECUTION');
    await commandMemberAutoTradeState(pool, session, 'BEGIN_SETTLING');
    const persisted = await persistQualifiedPaperArbitrage(pool, session, result.selected, {
      performanceFeeBps,
      initialBalanceUsdc: initialBalance,
      idempotencyKey: stableCycleKey(result.selected)
    });
    const settledState = await commandMemberAutoTradeState(pool, session, 'SETTLED');

    return Object.freeze({
      status: persisted.duplicate ? 'DUPLICATE_SETTLED' : 'SETTLED',
      state: settledState,
      cycle: persisted.cycle,
      accounting: persisted.accounting,
      duplicate: persisted.duplicate,
      mode: 'SHADOW',
      execution_dispatched: false,
      funds_moved: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  } catch (error) {
    try { await commandMemberAutoTradeState(pool, session, 'FAIL'); } catch {}
    throw error;
  }
}

async function pauseAbandonedInflightStates(pool, staleAfterMs) {
  const staleMs = Math.max(10_000, Number(staleAfterMs) || 120_000);
  const result = await pool.query(`
    UPDATE member_autotrade_states
    SET state='PAUSED', stop_requested=FALSE, paused_at=now(), updated_at=now(), state_version=state_version+1
    WHERE execution_mode='SHADOW'
      AND state IN ('EXECUTING','SETTLING')
      AND updated_at < now() - ($1::double precision * interval '1 millisecond')
    RETURNING user_id
  `, [staleMs]);
  return result.rows.map(row => row.user_id);
}

async function withMemberLease(pool, userId, fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [String(userId)]);
    locked = result.rows[0]?.locked === true;
    if (!locked) return null;
    return await fn();
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [String(userId)]); } catch {}
    }
    client.release();
  }
}

export async function runRunnableMemberAutoTradeShadowBatch({
  pool,
  runtime,
  loadPairForMember = null,
  performanceFeeBps = 1000,
  initialBalanceUsdc = 100,
  limit = 20,
  staleAfterMs = 120_000
} = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const recovered = await pauseAbandonedInflightStates(pool, staleAfterMs);
  const rows = (await pool.query(`
    SELECT user_id,wallet_address
    FROM member_autotrade_states
    WHERE state='RUNNING_SCANNING' AND stop_requested=FALSE AND execution_mode='SHADOW'
    ORDER BY updated_at ASC
    LIMIT $1
  `, [safeLimit])).rows;
  const items = [];
  for (const row of rows) {
    const leased = await withMemberLease(pool, row.user_id, async () => {
      try {
        const pair = typeof loadPairForMember === 'function'
          ? await loadPairForMember({ user_id: row.user_id, primary_wallet: row.wallet_address })
          : null;
        return await runMemberAutoTradeShadowTick({
          pool,
          session: { user_id: row.user_id, primary_wallet: row.wallet_address },
          runtime,
          pair,
          performanceFeeBps,
          initialBalanceUsdc
        });
      } catch (error) {
        return Object.freeze({
          status: 'PAUSED_FAIL_CLOSED',
          user_id: row.user_id,
          error: String(error?.message || 'member_shadow_tick_failed'),
          mode: 'SHADOW',
          execution_dispatched: false,
          funds_moved: false,
          network_submission_authorized: false,
          live_execution_authorized: false
        });
      }
    });
    if (leased) items.push(leased);
  }
  return Object.freeze({
    processed: items.length,
    recovered_to_paused: recovered.length,
    items: Object.freeze(items),
    mode: 'SHADOW',
    execution_dispatched: false,
    funds_moved: false,
    network_submission_authorized: false,
    live_execution_authorized: false
  });
}

export const MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  required_state: 'RUNNING_SCANNING',
  qualified_action: 'ARBITRAGE_SETTLE',
  compatible_runtime_interfaces: Object.freeze(['runNextOpportunity','scanAndQualifyPair']),
  raw_scanner_is_execution_runtime: false,
  member_batch_lease: 'POSTGRES_ADVISORY_LOCK',
  abandoned_inflight_recovery: 'PAUSE_FAIL_CLOSED',
  persists_only_qualified_cycles: true,
  no_qualified_opportunity_is_error: false,
  transaction_count_cap: null,
  execution_dispatched: false,
  signer_authorized: false,
  funds_moved: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
