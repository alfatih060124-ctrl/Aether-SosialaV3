import assert from 'node:assert/strict';
import { handleMemberPositionsRoute, MEMBER_POSITIONS_ROUTE } from '../services/api/src/member-positions-route.mjs';

const followerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policyId = '11111111-1111-4111-8111-111111111111';
const traderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const positionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function responseHarness() {
  let response = null;
  return {
    res: {},
    send(_res, status, body) { response = { status, body }; },
    get: () => response
  };
}

{
  const h = responseHarness();
  const handled = await handleMemberPositionsRoute({
    req: { method: 'GET', url: MEMBER_POSITIONS_ROUTE },
    res: h.res,
    route: MEMBER_POSITIONS_ROUTE,
    pool: { async query() { throw new Error('must_not_query_without_session'); } },
    walletAuth: {},
    sessionFor: async () => null,
    send: h.send
  });
  assert.equal(handled, true);
  assert.equal(h.get().status, 401);
  assert.equal(h.get().body.error, 'session_required');
  assert.equal(h.get().body.live_execution_authorized, false);
}

{
  const queries = [];
  const h = responseHarness();
  const handled = await handleMemberPositionsRoute({
    req: { method: 'GET', url: `${MEMBER_POSITIONS_ROUTE}?limit=50` },
    res: h.res,
    route: MEMBER_POSITIONS_ROUTE,
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('FROM follower_shadow_accounting_state')) return { rows: [] };
        throw new Error('partial_position_query_forbidden');
      }
    },
    walletAuth: {},
    sessionFor: async () => ({ user_id: followerId, primary_wallet: 'wallet' }),
    send: h.send
  });
  assert.equal(handled, true);
  assert.equal(h.get().status, 200);
  assert.equal(h.get().body.accounting_ready, false);
  assert.deepEqual(h.get().body.items, []);
  assert.equal(h.get().body.follower_identity_source, 'AUTHENTICATED_SESSION');
  assert.equal(h.get().body.caller_follower_authority, false);
  assert.equal(h.get().body.simulated, true);
  assert.equal(h.get().body.live_execution_authorized, false);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [followerId]);
}

{
  const nowIso = new Date().toISOString();
  const h = responseHarness();
  const handled = await handleMemberPositionsRoute({
    req: { method: 'GET', url: `${MEMBER_POSITIONS_ROUTE}?limit=50` },
    res: h.res,
    route: MEMBER_POSITIONS_ROUTE,
    pool: {
      async query(sql, params) {
        if (sql.includes('FROM follower_shadow_accounting_state')) return { rows: [{
          follower_user_id: followerId,
          accounting_ready: true,
          complete_through: nowIso,
          source_version: 'shadow-fill-ledger-v1',
          mode: 'SHADOW',
          live_execution_authorized: false,
          updated_at: nowIso
        }] };
        if (sql.includes('FROM follower_shadow_position_events')) return { rows: [{ daily_realized_pnl_usdc: '1.5' }] };
        if (sql.includes('FROM follower_shadow_positions')) {
          assert.equal(params[0], followerId);
          return { rows: [{
            position_id: positionId,
            policy_id: policyId,
            trader_id: traderId,
            token_mint: 'TokenMint11111111111111111111111111111111',
            quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            status: 'OPEN',
            token_quantity: '2',
            cost_basis_usdc: '10',
            realized_pnl_usdc: '1.5',
            last_mark_price_usdc: '6',
            mark_observed_at: nowIso,
            opened_at: nowIso,
            closed_at: null,
            updated_at: nowIso
          }] };
        }
        throw new Error(`unexpected_query:${sql}`);
      }
    },
    walletAuth: {},
    sessionFor: async () => ({ user_id: followerId, primary_wallet: 'wallet' }),
    send: h.send
  });
  assert.equal(handled, true);
  assert.equal(h.get().status, 200);
  assert.equal(h.get().body.accounting_ready, true);
  assert.equal(h.get().body.items.length, 1);
  assert.equal(h.get().body.items[0].status, 'OPEN');
  assert.equal(h.get().body.items[0].simulated, true);
  assert.equal(h.get().body.items[0].live_execution_authorized, false);
}

{
  const h = responseHarness();
  const handled = await handleMemberPositionsRoute({
    req: { method: 'POST', url: MEMBER_POSITIONS_ROUTE },
    res: h.res,
    route: MEMBER_POSITIONS_ROUTE,
    pool: {},
    walletAuth: {},
    sessionFor: async () => ({ user_id: followerId }),
    send: h.send
  });
  assert.equal(handled, true);
  assert.equal(h.get().status, 405);
}

console.log('member positions route regression: PASS');
