const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_ACCOUNTING_LAG_MS = 60_000;

function canonicalUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) throw new Error(`${field}_required`);
  return value;
}

function positive(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${field}`);
  return n;
}

function marketPrice(assessment) {
  return positive(
    assessment?.snapshot?.current_price_usdc ?? assessment?.snapshot?.price_usdc ?? assessment?.price_usdc,
    'trusted_position_market_price_usdc'
  );
}

function accountingReady(row, observedNow, maxAccountingLagMs) {
  if (!row || row.accounting_ready !== true || row.mode !== 'SHADOW' || row.live_execution_authorized !== false || !row.complete_through) {
    return false;
  }
  const completeThrough = new Date(row.complete_through);
  if (Number.isNaN(completeThrough.getTime())) return false;
  const lagMs = observedNow.getTime() - completeThrough.getTime();
  return lagMs >= -2000 && lagMs <= maxAccountingLagMs;
}

export function createTrustedAutoTradePositionResolver({ pool, now = () => new Date(), maxAccountingLagMs = DEFAULT_MAX_ACCOUNTING_LAG_MS } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('autotrade_position_pool_required');
  const maxLag = Number.isFinite(Number(maxAccountingLagMs)) ? Math.max(1000, Number(maxAccountingLagMs)) : DEFAULT_MAX_ACCOUNTING_LAG_MS;

  return async function resolveTrustedPosition(context = {}) {
    const followerUserId = canonicalUuid(context.authenticated_follower_user_id, 'follower_user_id');
    const policyId = canonicalUuid(context.policy_id, 'policy_id');
    const tokenMint = requiredText(context.assessment?.token_mint || context.assessment?.snapshot?.token_mint, 'token_mint');
    const observedNow = now();
    if (!(observedNow instanceof Date) || Number.isNaN(observedNow.getTime())) throw new Error('trusted_position_clock_invalid');

    const positions = await pool.query(
      `SELECT position_id,policy_id,trader_id,token_mint,quote_mint,status,token_quantity,cost_basis_usdc,
              realized_pnl_usdc,last_mark_price_usdc,mark_observed_at,opened_at,updated_at
         FROM follower_shadow_positions
        WHERE follower_user_id=$1
          AND policy_id=$2
          AND token_mint=$3
          AND status IN ('OPEN','CLOSING')
          AND mode='SHADOW'
          AND live_execution_authorized=false
        ORDER BY updated_at DESC
        LIMIT 2`,
      [followerUserId, policyId, tokenMint]
    );
    const rows = positions?.rows || [];
    if (rows.length > 1) throw new Error('trusted_position_ambiguous');
    if (!rows.length) return Object.freeze({});

    const stateResult = await pool.query(
      `SELECT follower_user_id,accounting_ready,complete_through,source_version,mode,live_execution_authorized
         FROM follower_shadow_accounting_state
        WHERE follower_user_id=$1`,
      [followerUserId]
    );
    const state = stateResult?.rows?.[0] || null;
    if (!accountingReady(state, observedNow, maxLag)) throw new Error('trusted_position_accounting_not_ready');

    const row = rows[0];
    if (row.policy_id !== policyId || row.token_mint !== tokenMint || !['OPEN', 'CLOSING'].includes(row.status)) {
      throw new Error('trusted_position_scope_mismatch');
    }
    const quantity = positive(row.token_quantity, 'trusted_position_token_quantity');
    const costBasis = positive(row.cost_basis_usdc, 'trusted_position_cost_basis_usdc');
    const entryPrice = costBasis / quantity;
    const currentPrice = marketPrice(context.assessment);
    const priorMark = Number(row.last_mark_price_usdc);
    const peakPrice = Math.max(entryPrice, currentPrice, Number.isFinite(priorMark) && priorMark > 0 ? priorMark : 0);
    const positionValue = quantity * currentPrice;
    const unrealizedPnlBps = ((currentPrice / entryPrice) - 1) * 10000;

    return Object.freeze({
      position_id: row.position_id,
      policy_id: row.policy_id,
      trader_id: row.trader_id,
      token_mint: row.token_mint,
      quote_mint: row.quote_mint,
      status: row.status,
      position_value_usd: positionValue,
      entry_price_usd: entryPrice,
      current_price_usd: currentPrice,
      peak_price_usd: peakPrice,
      unrealized_pnl_bps: unrealizedPnlBps,
      accounting_complete_through: state.complete_through,
      accounting_source_version: state.source_version || null,
      source: 'BACKEND_FOLLOWER_SHADOW_POSITION_ACCOUNTING',
      caller_authority: false,
      mode: 'SHADOW',
      simulated: true,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    });
  };
}
