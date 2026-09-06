import { evaluateMemberLiveFundingPreflight } from './member-live-funding-preflight.mjs';

export const MEMBER_LIVE_FUNDING_PREFLIGHT_ROUTE = '/api/account/live-preflight';

export async function handleMemberLiveFundingPreflightRoute({ req, res, route, pool, walletAuth, sessionFor, send, walletPortfolio }) {
  if (route !== MEMBER_LIVE_FUNDING_PREFLIGHT_ROUTE) return false;
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', live_execution_authorized: false });
    return true;
  }
  if (!pool || !walletAuth) {
    send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', live_execution_authorized: false });
    return true;
  }
  const session = await sessionFor(req);
  if (!session) {
    send(res, 401, { error: 'session_required', mode: 'SHADOW', live_execution_authorized: false });
    return true;
  }
  try {
    const preflight = await evaluateMemberLiveFundingPreflight(pool, session, { portfolioService: walletPortfolio });
    send(res, 200, {
      ...preflight,
      route: MEMBER_LIVE_FUNDING_PREFLIGHT_ROUTE,
      authentication: 'WALLET_SESSION',
      mode: 'SHADOW',
      live_execution_authorized: false
    });
    return true;
  } catch (error) {
    const code = String(error?.message || 'live_funding_preflight_unavailable');
    const status = code === 'session_required' ? 401 : code === 'database_unconfigured' || code === 'portfolio_service_required' || code === 'solana_rpc_unconfigured' ? 503 : code.startsWith('solana_rpc_') ? 502 : code.endsWith('_invalid') ? 400 : 503;
    send(res, status, {
      error: code,
      funding_preflight_passed: false,
      transaction_submission_authorized: false,
      signer_authorized: false,
      fund_movement_authorized: false,
      live_execution_authorized: false,
      mode: 'SHADOW',
      fail_closed: true
    });
    return true;
  }
}
