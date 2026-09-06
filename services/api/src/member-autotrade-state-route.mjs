import { getMemberAutoTradeState, commandMemberAutoTradeState } from './member-autotrade-state-machine.mjs';

export const MEMBER_AUTOTRADE_STATE_ROUTE = '/api/account/autotrade/state';
export const MEMBER_AUTOTRADE_START_ROUTE = '/api/account/autotrade/start';
export const MEMBER_AUTOTRADE_STOP_ROUTE = '/api/account/autotrade/stop';

function statusFor(error) {
  const code = String(error?.message || '');
  if (code === 'session_required') return 401;
  if (code === 'database_unconfigured') return 503;
  if (code === 'autotrade_state_not_found') return 404;
  if (code.endsWith('_state_conflict')) return 409;
  if (code.includes('_wallet_mismatch')) return 403;
  if (code.endsWith('_invalid')) return 400;
  return 500;
}

export async function handleMemberAutoTradeStateRoute({ req, res, route, pool, walletAuth, sessionFor, send }) {
  if (![MEMBER_AUTOTRADE_STATE_ROUTE, MEMBER_AUTOTRADE_START_ROUTE, MEMBER_AUTOTRADE_STOP_ROUTE].includes(route)) return false;
  const expectedMethod = route === MEMBER_AUTOTRADE_STATE_ROUTE ? 'GET' : 'POST';
  if (req.method !== expectedMethod) {
    send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false });
    return true;
  }
  if (!pool || !walletAuth) {
    send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false });
    return true;
  }
  try {
    const session = await sessionFor(req);
    if (!session) {
      send(res, 401, { error: 'session_required', mode: 'SHADOW', execution_dispatched: false, live_execution_authorized: false });
      return true;
    }
    const state = route === MEMBER_AUTOTRADE_STATE_ROUTE
      ? await getMemberAutoTradeState(pool, session)
      : await commandMemberAutoTradeState(pool, session, route === MEMBER_AUTOTRADE_START_ROUTE ? 'START' : 'STOP');
    send(res, 200, {
      state,
      route,
      authentication: 'WALLET_SESSION',
      mode: 'SHADOW',
      execution_dispatched: false,
      network_submission_authorized: false,
      signer_authorized: false,
      fund_movement_authorized: false,
      live_execution_authorized: false
    });
    return true;
  } catch (error) {
    send(res, statusFor(error), {
      error: String(error?.message || 'member_autotrade_state_failed'),
      mode: 'SHADOW',
      execution_dispatched: false,
      network_submission_authorized: false,
      signer_authorized: false,
      fund_movement_authorized: false,
      live_execution_authorized: false
    });
    return true;
  }
}
