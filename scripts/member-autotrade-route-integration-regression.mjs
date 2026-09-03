import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleMemberAutoTradeRoute, MEMBER_AUTOTRADE_ROUTE } from '../services/api/src/member-autotrade-route.mjs';

const policyId = '11111111-1111-4111-8111-111111111111';
const assessmentId = '22222222-2222-4222-8222-222222222222';
const session = { user_id: '33333333-3333-4333-8333-333333333333', primary_wallet: '11111111111111111111111111111111' };
const assessmentRow = { assessment_id: assessmentId, token_mint: 'TOKEN', quality_score: 90, verdict: 'QUALIFIED', hard_rejects: [], components: {}, snapshot: {}, observed_at: new Date().toISOString() };

function responseCapture() {
  const calls = [];
  return {
    res: {},
    send(_res, status, body) { calls.push({ status, body }); },
    last() { return calls.at(-1); }
  };
}

function deps(overrides = {}) {
  const capture = responseCapture();
  return {
    req: { method: 'POST' }, res: capture.res, route: MEMBER_AUTOTRADE_ROUTE,
    pool: {}, repos: { signalIntelligence: { async getAssessment(id) { assert.equal(id, assessmentId); return assessmentRow; } } },
    walletAuth: {}, sessionFor: async () => session,
    jsonBody: async () => ({ policy_id: policyId, assessment_id: assessmentId }),
    send: capture.send,
    executionMode: 'SHADOW', liveEnabled: false, walletPortfolio: {},
    assessmentProjection: row => ({ token_mint: row.token_mint, quality_score: Number(row.quality_score), verdict: row.verdict, hard_rejects: [], components: {}, snapshot: {}, live_execution_authorized: false }),
    createRiskResolver: ({ walletAddress }) => { assert.equal(walletAddress, session.primary_wallet); return async () => ({ trusted: true }); },
    persistDecision: async input => {
      assert.equal(input.session.user_id, session.user_id);
      assert.deepEqual(input.requestBody, { policy_id: policyId, assessment_id: assessmentId });
      const resolved = await input.resolveAssessment({ assessment_id: assessmentId });
      assert.equal(resolved.assessment_id, assessmentId);
      await input.resolveRuntimeRisk({});
      return { schema: 'test', decision_id: 'decision', execution_dispatched: false, live_execution_authorized: false, network_submission_authorized: false, signer_required: false };
    },
    capture,
    ...overrides
  };
}

{
  const x = deps();
  assert.equal(await handleMemberAutoTradeRoute(x), true);
  assert.equal(x.capture.last().status, 200);
  assert.equal(x.capture.last().body.authentication, 'WALLET_SESSION');
  assert.equal(x.capture.last().body.mode, 'SHADOW');
  assert.equal(x.capture.last().body.execution_dispatched, false);
  assert.equal(x.capture.last().body.live_execution_authorized, false);
  assert.equal(x.capture.last().body.network_submission_authorized, false);
  assert.equal(x.capture.last().body.signer_required, false);
}

{
  const x = deps({ sessionFor: async () => null });
  assert.equal(await handleMemberAutoTradeRoute(x), true);
  assert.equal(x.capture.last().status, 401);
  assert.equal(x.capture.last().body.error, 'session_required');
}

{
  const x = deps({ route: '/api/autotrade/evaluate' });
  assert.equal(await handleMemberAutoTradeRoute(x), true);
  assert.equal(x.capture.last().status, 410);
  assert.equal(x.capture.last().body.error, 'legacy_autotrade_route_disabled');
}

{
  const x = deps({ liveEnabled: true });
  assert.equal(await handleMemberAutoTradeRoute(x), true);
  assert.equal(x.capture.last().status, 423);
  assert.equal(x.capture.last().body.live_execution_authorized, false);
}

const routeBoundary = fs.readFileSync(new URL('../services/api/src/autotrade-route-boundary.mjs', import.meta.url), 'utf8');
for (const field of ['mandate','follower_user_id','trader_id','runtime_risk','position','snapshot','execution_mode','mode','live_execution_authorized','network_submission_authorized','signer_required']) {
  assert.ok(routeBoundary.includes(`'${field}'`), `caller authority field must remain forbidden: ${field}`);
}

const server = fs.readFileSync(new URL('../services/api/src/server.mjs', import.meta.url), 'utf8');
assert.ok(server.includes("import { handleMemberAutoTradeRoute } from './member-autotrade-route.mjs';"));
assert.ok(server.includes('handleMemberAutoTradeRoute({req,res,route,pool,repos,walletAuth,sessionFor,jsonBody,send,executionMode,liveEnabled,walletPortfolio,assessmentProjection})'));
assert.ok(!server.includes('body.mandate||{}'), 'legacy caller-controlled mandate route must be removed');
assert.ok(server.includes('consent_version:mandate.consent_version'));

const edge = fs.readFileSync(new URL('../api/index.mjs', import.meta.url), 'utf8');
assert.match(edge, /SESSION_POST_ROUTES[\s\S]*\/api\/account\/autotrade\/evaluate/);
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
assert.match(caddy, /method POST[\s\S]*\/api\/account\/autotrade\/evaluate/);
const contract = fs.readFileSync(new URL('../services/api/src/api-contract.mjs', import.meta.url), 'utf8');
assert.ok(contract.includes("'POST /api/account/autotrade/evaluate'"));
assert.ok(contract.includes("'POST /api/autotrade/evaluate'"));
assert.ok(contract.includes('legacy_caller_mandate_autotrade_disabled: true'));

console.log('member autotrade route integration regression: ok');
