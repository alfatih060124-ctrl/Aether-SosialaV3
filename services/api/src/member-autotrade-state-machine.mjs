const STATES = Object.freeze(['STOPPED','RUNNING_SCANNING','EXECUTING','SETTLING','PAUSED']);

function nowDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('autotrade_state_now_invalid');
  return parsed;
}

function safeState(value) {
  const state = String(value || '').trim().toUpperCase();
  if (!STATES.includes(state)) throw new Error('autotrade_state_invalid');
  return state;
}

export function applyMemberAutoTradeCommand(snapshot, command, { now = new Date() } = {}) {
  const current = safeState(snapshot?.state || 'STOPPED');
  const action = String(command || '').trim().toUpperCase();
  const at = nowDate(now).toISOString();
  const next = { ...snapshot, state: current, stop_requested: Boolean(snapshot?.stop_requested), updated_at: at };

  if (action === 'START') {
    if (!['STOPPED','PAUSED'].includes(current)) throw new Error('autotrade_start_state_conflict');
    next.state = 'RUNNING_SCANNING';
    next.stop_requested = false;
    next.started_at = at;
    next.paused_at = null;
    next.stopped_at = null;
  } else if (action === 'STOP') {
    if (current === 'STOPPED') return Object.freeze(next);
    if (['EXECUTING','SETTLING'].includes(current)) {
      next.stop_requested = true;
    } else {
      next.state = 'STOPPED';
      next.stop_requested = false;
      next.stopped_at = at;
    }
  } else if (action === 'PAUSE') {
    if (current !== 'RUNNING_SCANNING') throw new Error('autotrade_pause_state_conflict');
    next.state = 'PAUSED';
    next.stop_requested = false;
    next.paused_at = at;
  } else if (action === 'FAIL') {
    if (!['RUNNING_SCANNING','EXECUTING','SETTLING'].includes(current)) throw new Error('autotrade_fail_state_conflict');
    next.state = 'PAUSED';
    next.stop_requested = false;
    next.paused_at = at;
  } else if (action === 'BEGIN_EXECUTION') {
    if (current !== 'RUNNING_SCANNING' || next.stop_requested) throw new Error('autotrade_execution_state_conflict');
    next.state = 'EXECUTING';
  } else if (action === 'BEGIN_SETTLING') {
    if (current !== 'EXECUTING') throw new Error('autotrade_settling_state_conflict');
    next.state = 'SETTLING';
  } else if (action === 'SETTLED') {
    if (current !== 'SETTLING') throw new Error('autotrade_settled_state_conflict');
    if (next.stop_requested) {
      next.state = 'STOPPED';
      next.stop_requested = false;
      next.stopped_at = at;
    } else {
      next.state = 'RUNNING_SCANNING';
    }
  } else {
    throw new Error('autotrade_command_invalid');
  }

  return Object.freeze(next);
}

function project(row) {
  if (!row) return null;
  return Object.freeze({
    user_id: row.user_id,
    wallet_address: row.wallet_address,
    state: row.state,
    execution_mode: row.execution_mode,
    state_version: Number(row.state_version),
    stop_requested: row.stop_requested === true,
    started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    paused_at: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    stopped_at: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
    updated_at: new Date(row.updated_at).toISOString(),
    execution_dispatched: false,
    live_execution_authorized: false,
    transaction_submission_authorized: false,
    signer_authorized: false,
    fund_movement_authorized: false
  });
}

export async function getMemberAutoTradeState(pool, session) {
  if (!pool) throw new Error('database_unconfigured');
  if (!session?.user_id || !session?.primary_wallet) throw new Error('session_required');
  const result = await pool.query(`
    INSERT INTO member_autotrade_states (user_id, wallet_address)
    VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
    RETURNING *
  `, [session.user_id, session.primary_wallet]);
  return project(result.rows[0]);
}

export async function commandMemberAutoTradeState(pool, session, command, { now = new Date() } = {}) {
  if (!pool) throw new Error('database_unconfigured');
  if (!session?.user_id || !session?.primary_wallet) throw new Error('session_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO member_autotrade_states (user_id, wallet_address)
      VALUES ($1,$2)
      ON CONFLICT (user_id) DO NOTHING
    `, [session.user_id, session.primary_wallet]);
    const locked = await client.query(`SELECT * FROM member_autotrade_states WHERE user_id=$1 FOR UPDATE`, [session.user_id]);
    const row = locked.rows[0];
    if (!row) throw new Error('autotrade_state_not_found');
    if (row.wallet_address !== session.primary_wallet) throw new Error('autotrade_state_wallet_mismatch');
    const next = applyMemberAutoTradeCommand(row, command, { now });
    const updated = await client.query(`
      UPDATE member_autotrade_states
      SET state=$2, stop_requested=$3, started_at=$4, paused_at=$5, stopped_at=$6,
          updated_at=$7, state_version=state_version+1
      WHERE user_id=$1
      RETURNING *
    `, [session.user_id, next.state, next.stop_requested, next.started_at || row.started_at, next.paused_at, next.stopped_at, next.updated_at]);
    await client.query('COMMIT');
    return project(updated.rows[0]);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function commandMemberAutoTradeStateInternal(pool, userId, command, { now = new Date() } = {}) {
  if (!pool) throw new Error('database_unconfigured');
  const user = String(userId || '').trim();
  if (!user) throw new Error('autotrade_internal_user_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM member_autotrade_states WHERE user_id=$1 FOR UPDATE`, [user]);
    const row = locked.rows[0];
    if (!row) throw new Error('autotrade_state_not_found');
    const next = applyMemberAutoTradeCommand(row, command, { now });
    const updated = await client.query(`
      UPDATE member_autotrade_states
      SET state=$2, stop_requested=$3, started_at=$4, paused_at=$5, stopped_at=$6,
          updated_at=$7, state_version=state_version+1
      WHERE user_id=$1 RETURNING *
    `,[user,next.state,next.stop_requested,next.started_at||row.started_at,next.paused_at,next.stopped_at,next.updated_at]);
    await client.query('COMMIT');
    return project(updated.rows[0]);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export const MEMBER_AUTOTRADE_STATE_MACHINE = Object.freeze({
  states: STATES,
  member_commands: Object.freeze(['START','STOP']),
  internal_commands: Object.freeze(['PAUSE','FAIL','BEGIN_EXECUTION','BEGIN_SETTLING','SETTLED']),
  execution_mode: 'SHADOW',
  execution_dispatched: false,
  live_execution_authorized: false,
  transaction_submission_authorized: false,
  signer_authorized: false,
  fund_movement_authorized: false
});
