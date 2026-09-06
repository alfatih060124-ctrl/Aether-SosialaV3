import { createFollowerPositionAccountingService } from './follower-position-accounting.mjs';
import { handleMemberDelegatedAuthorityRoute } from './member-delegated-authority-route.mjs';
import { handleMemberLiveFundingPreflightRoute } from './member-live-funding-preflight-route.mjs';

export const MEMBER_POSITIONS_ROUTE = '/api/account/positions';

export async function handleMemberPositionsRoute({ req, res, route, pool, walletAuth, sessionFor, jsonBody, send }) {
  if (await handleMemberDelegatedAuthorityRoute({ req, res, route, pool, walletAuth, sessionFor, jsonBody, send })) return true;
  if (await handleMemberLiveFundingPreflightRoute({ req, res, route, pool, walletAuth, sessionFor, send })) return true;
  if (route !== MEMBER_POSITIONS_ROUTE) return false;
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed', mode: 'SHADOW', simulated: true, live_execution_authorized: false });
    return true;
  }
  if (!pool || !walletAuth) {
    send(res, 503, { error: 'database_unconfigured', mode: 'SHADOW', simulated: true, live_execution_authorized: false });
    return true;
  }

  const session = await sessionFor(req);
  if (!session) {
    send(res, 401, { error: 'session_required', mode: 'SHADOW', simulated: true, live_execution_authorized: false });
    return true;
  }

  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const service = createFollowerPositionAccountingService(pool);
    const snapshot = await service.getFollowerSnapshot(session.user_id, requestUrl.searchParams.get('limit'));
    send(res, 200, {
      ...snapshot,
      authentication: 'WALLET_SESSION',
      follower_identity_source: 'AUTHENTICATED_SESSION',
      caller_follower_authority: false,
      mode: 'SHADOW',
      simulated: true,
      live_execution_authorized: false
    });
    return true;
  } catch (error) {
    const code = String(error?.message || 'position_accounting_unavailable');
    const status = code.startsWith('invalid_') ? 400 : 503;
    send(res, status, {
      error: code,
      accounting_ready: false,
      items: [],
      mode: 'SHADOW',
      simulated: true,
      live_execution_authorized: false
    });
    return true;
  }
}
