const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_ACCOUNTING_LAG_MS = 60_000;
const DEFAULT_MAX_MARK_AGE_MS = 15_000;

function canonicalUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function finiteMoney(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid_${field}`);
  return Math.round(n * 1000000) / 1000000;
}

function safeLimit(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(1, Math.min(200, n)) : 100;
}

function validClock(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('position_accounting_clock_invalid');
  return value;
}

function projectPosition(row, observedNow, maxMarkAgeMs) {
  const quantity = Number(row.token_quantity);
  const costBasis = Number(row.cost_basis_usdc);
  const markPrice = row.last_mark_price_usdc == null ? null : Number(row.last_mark_price_usdc);
  const markTime = row.mark_observed_at ? new Date(row.mark_observed_at) : null;
  const markAgeMs = markTime && !Number.isNaN(markTime.getTime()) ? observedNow.getTime() - markTime.getTime() : null;
  const markFresh = Number.isFinite(markPrice) && markPrice > 0 && markAgeMs != null && markAgeMs >= -2000 && markAgeMs <= maxMarkAgeMs;
  const marketValue = markFresh && Number.isFinite(quantity) ? quantity * markPrice : null;
  const unrealized = marketValue != null && Number.isFinite(costBasis) ? marketValue - costBasis : null;

  return Object.freeze({
    position_id: row.position_id,
    policy_id: row.policy_id,
    trader_id: row.trader_id,
    token_mint: row.token_mint,
    quote_mint: row.quote_mint,
    status: row.status,
    token_quantity: Number.isFinite(quantity) ? quantity : null,
    cost_basis_usdc: Number.isFinite(costBasis) ? costBasis : null,
    realized_pnl_usdc: Number.isFinite(Number(row.realized_pnl_usdc)) ? Number(row.realized_pnl_usdc) : null,
    mark_price_usdc: markFresh ? markPrice : null,
    mark_observed_at: markFresh ? row.mark_observed_at : null,
    mark_status: markFresh ? 'FRESH' : markPrice == null ? 'UNAVAILABLE' : 'STALE',
    market_value_usdc: marketValue == null ? null : Math.round(marketValue * 1000000) / 1000000,
    unrealized_pnl_usdc: unrealized == null ? null : Math.round(unrealized * 1000000) / 1000000,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    updated_at: row.updated_at,
    mode: 'SHADOW',
    simulated: true,
    live_execution_authorized: false
  });
}

export function createFollowerPositionAccountingService(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('position_accounting_pool_required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const maxAccountingLagMs = Number.isFinite(Number(options.maxAccountingLagMs))
    ? Math.max(1000, Number(options.maxAccountingLagMs))
    : DEFAULT_MAX_ACCOUNTING_LAG_MS;
  const maxMarkAgeMs = Number.isFinite(Number(options.maxMarkAgeMs))
    ? Math.max(1000, Number(options.maxMarkAgeMs))
    : DEFAULT_MAX_MARK_AGE_MS;

  async function accountingState(followerUserId) {
    const id = canonicalUuid(followerUserId, 'follower_user_id');
    const observedNow = validClock(now());
    const result = await pool.query(
      `SELECT follower_user_id,accounting_ready,complete_through,source_cursor,source_version,mode,live_execution_authorized,updated_at
         FROM follower_shadow_accounting_state
        WHERE follower_user_id=$1`,
      [id]
    );
    const row = result?.rows?.[0] || null;
    if (!row || row.accounting_ready !== true || row.mode !== 'SHADOW' || row.live_execution_authorized !== false || !row.complete_through) {
      return Object.freeze({ ready: false, reason: 'ACCOUNTING_NOT_READY', row, observedNow });
    }
    const completeThrough = new Date(row.complete_through);
    if (Number.isNaN(completeThrough.getTime())) {
      return Object.freeze({ ready: false, reason: 'ACCOUNTING_CURSOR_INVALID', row, observedNow });
    }
    const lagMs = observedNow.getTime() - completeThrough.getTime();
    if (lagMs < -2000 || lagMs > maxAccountingLagMs) {
      return Object.freeze({ ready: false, reason: 'ACCOUNTING_STALE', row, observedNow, lagMs });
    }
    return Object.freeze({ ready: true, reason: null, row, observedNow, lagMs });
  }

  async function dailyRealizedPnl(followerUserId, state = null) {
    const id = canonicalUuid(followerUserId, 'follower_user_id');
    const resolved = state || await accountingState(id);
    if (!resolved.ready) return Object.freeze({ accounting_ready: false, daily_realized_pnl_usdc: null, reason: resolved.reason });
    const utcStart = new Date(Date.UTC(
      resolved.observedNow.getUTCFullYear(),
      resolved.observedNow.getUTCMonth(),
      resolved.observedNow.getUTCDate()
    ));
    const result = await pool.query(
      `SELECT COALESCE(SUM(realized_pnl_usdc),0) AS daily_realized_pnl_usdc
         FROM follower_shadow_position_events
        WHERE follower_user_id=$1
          AND event_type IN ('DECREASE','CLOSE')
          AND occurred_at >= $2
          AND occurred_at <= $3
          AND mode='SHADOW'
          AND live_execution_authorized=false`,
      [id, utcStart.toISOString(), resolved.row.complete_through]
    );
    return Object.freeze({
      accounting_ready: true,
      daily_realized_pnl_usdc: finiteMoney(result?.rows?.[0]?.daily_realized_pnl_usdc ?? 0, 'daily_realized_pnl_usdc'),
      reason: null,
      complete_through: resolved.row.complete_through,
      source_version: resolved.row.source_version || null
    });
  }

  return Object.freeze({
    async getRiskSnapshot(followerUserId) {
      const state = await accountingState(followerUserId);
      return dailyRealizedPnl(followerUserId, state);
    },

    async getFollowerSnapshot(followerUserId, limit = 100) {
      const id = canonicalUuid(followerUserId, 'follower_user_id');
      const state = await accountingState(id);
      const pnl = await dailyRealizedPnl(id, state);
      if (!state.ready) {
        return Object.freeze({
          schema: 'aether.follower.shadow_positions.v1',
          accounting_ready: false,
          reason: state.reason,
          items: Object.freeze([]),
          daily_realized_pnl_usdc: null,
          mode: 'SHADOW',
          simulated: true,
          live_execution_authorized: false
        });
      }
      const result = await pool.query(
        `SELECT position_id,policy_id,trader_id,token_mint,quote_mint,status,token_quantity,cost_basis_usdc,
                realized_pnl_usdc,last_mark_price_usdc,mark_observed_at,opened_at,closed_at,updated_at
           FROM follower_shadow_positions
          WHERE follower_user_id=$1
            AND mode='SHADOW'
            AND live_execution_authorized=false
          ORDER BY CASE WHEN status IN ('OPEN','CLOSING') THEN 0 ELSE 1 END,updated_at DESC
          LIMIT $2`,
        [id, safeLimit(limit)]
      );
      const items = Object.freeze((result?.rows || []).map(row => projectPosition(row, state.observedNow, maxMarkAgeMs)));
      return Object.freeze({
        schema: 'aether.follower.shadow_positions.v1',
        accounting_ready: true,
        reason: null,
        complete_through: state.row.complete_through,
        source_version: state.row.source_version || null,
        daily_realized_pnl_usdc: pnl.daily_realized_pnl_usdc,
        items,
        mode: 'SHADOW',
        simulated: true,
        live_execution_authorized: false
      });
    }
  });
}
