import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { API_CONTRACT } from '../services/api/src/api-contract.mjs';

const server = await fs.readFile(new URL('../services/api/src/server.mjs', import.meta.url), 'utf8');
const memberAutoTrade = await fs.readFile(new URL('../services/api/src/member-autotrade-route.mjs', import.meta.url), 'utf8');
const edge = await fs.readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
const walletPortfolio = await fs.readFile(new URL('../services/api/src/wallet-portfolio.mjs', import.meta.url), 'utf8');
const executionRequests = await fs.readFile(new URL('../services/api/src/repositories/execution-requests.mjs', import.meta.url), 'utf8');
const reconciledService = await fs.readFile(new URL('../services/api/src/reconciled-performance-service.mjs', import.meta.url), 'utf8');
const reconciliationRuntime = await fs.readFile(new URL('../services/api/src/reconciliation-runtime-service.mjs', import.meta.url), 'utf8');

const allRoutes = Object.entries(API_CONTRACT)
  .filter(([, value]) => Array.isArray(value))
  .flatMap(([, value]) => value);

for (const required of [
  'GET /api/market/token?mint=:mint',
  'GET /api/execution/status',
  'POST /api/auth/verify',
  'GET /api/account/wallet-portfolio',
  'GET /api/account/copy-trades',
  'POST /api/account/trader/apply',
  'POST /api/account/autotrade/evaluate',
  'POST /api/autotrade/evaluate',
  'POST /api/executions',
  'POST /api/internal/traders/:traderId/reconciled-trades',
  'POST /api/admin/traders/:traderId/evidence/collect',
  'POST /api/admin/traders/:traderId/evidence/reconcile',
  'PATCH /api/admin/traders/:traderId/verification',
  'PATCH /api/admin/traders/:traderId/publication',
  'GET /api/admin/wallets/readiness'
]) assert.ok(allRoutes.includes(required), `contract route missing: ${required}`);

for (const stale of [
  'GET /api/admin/system-health',
  'GET /api/admin/circuit-breakers',
  'GET /api/traders/:wallet',
  'POST /api/trade-events',
  'POST /api/follows'
]) assert.equal(allRoutes.includes(stale), false, `stale contract route retained: ${stale}`);

assert.equal(API_CONTRACT.deployment_roles.public_edge, 'PUBLIC_EDGE');
assert.equal(API_CONTRACT.deployment_roles.primary_runtime, 'PRIMARY_VM');
for (const [key, expected] of Object.entries({
  execution_mode: 'SHADOW',
  live_execution_authorized: false,
  signer_exposed_to_api: false,
  public_edge_blocks_internal_and_admin_routes: true,
  market_token_lookup_is_read_only: true,
  wallet_portfolio_is_session_bound: true,
  wallet_portfolio_is_read_only: true,
  wallet_portfolio_never_authorizes_live: true,
  copy_trade_activity_is_session_bound: true,
  copy_trade_activity_never_authorizes_live: true,
  copy_trade_open_positions_not_inferred_from_execution_requests: true,
  copy_mandate_consent_is_versioned: true,
  copy_mandate_requires_published_verified_trader: true,
  member_autotrade_is_session_bound: true,
  member_autotrade_uses_persisted_mandate: true,
  member_autotrade_caller_risk_authority: false,
  member_autotrade_execution_dispatched: false,
  legacy_caller_mandate_autotrade_disabled: true,
  evidence_collection_does_not_verify: true,
  evidence_recording_does_not_verify: true,
  reconciled_performance_evidence_does_not_verify: true,
  direct_reconciliation_metrics_ingest_blocked: true,
  coordinated_reconciliation_sources_required: true,
  incomplete_reconciliation_sources_do_not_write_ledger: true,
  verification_does_not_publish: true,
  publication_requires_prior_verification: true,
  auto_trade_execution_dispatched: false,
  shadow_simulation_never_authorizes_live: true,
  shadow_simulation_requires_api_token: true
})) assert.equal(API_CONTRACT.invariants[key], expected, `contract invariant mismatch: ${key}`);

for (const literal of [
  "route==='/api/health'",
  "route==='/api/execution/status'",
  "route==='/api/autotrade/status'",
  "route==='/api/account/wallet-portfolio'",
  "route==='/api/account/trader'",
  "route==='/api/account/copy-mandates'",
  "route==='/api/account/copy-trades'",
  "route==='/api/shadow/simulate'",
  "route==='/api/executions'",
  "route==='/api/admin/wallets/readiness'",
  "route==='/api/admin/fees'"
]) assert.ok(server.includes(literal), `primary implementation missing: ${literal}`);

assert.ok(server.includes("import { handleMemberAutoTradeRoute } from './member-autotrade-route.mjs';"));
assert.ok(server.includes('handleMemberAutoTradeRoute({req,res,route,pool,repos,walletAuth,sessionFor,jsonBody,send,executionMode,liveEnabled,walletPortfolio,assessmentProjection})'));
assert.ok(memberAutoTrade.includes("const MEMBER_ROUTE = '/api/account/autotrade/evaluate';"));
assert.ok(memberAutoTrade.includes("const LEGACY_ROUTE = '/api/autotrade/evaluate';"));
assert.ok(memberAutoTrade.includes("error: 'legacy_autotrade_route_disabled'"));
assert.equal(server.includes('body.mandate||{}'), false, 'caller-controlled legacy Auto Trade implementation must be removed');

for (const segment of [
  "p[4]==='reconciled-trades'",
  "p[5]==='collect'",
  "p[5]==='reconcile'",
  "p[4]==='verification'",
  "p[4]==='publication'"
]) assert.ok(server.includes(segment), `primary dynamic route missing: ${segment}`);

assert.ok(edge.includes("path === '/api/market/token'"));
assert.ok(edge.includes("'/api/account/wallet-portfolio'"));
assert.ok(edge.includes("'/api/account/copy-trades'"));
assert.ok(edge.includes("'/api/account/autotrade/evaluate'"));
assert.ok(edge.includes("read_only: true"));
assert.ok(edge.includes("live_execution_authorized: false"));
assert.ok(edge.includes("error: 'public_gateway_route_blocked'"));
assert.ok(server.includes("execution_dispatched:false") || memberAutoTrade.includes('execution_dispatched: false'));
assert.ok(server.includes("verification_authorized:false"));
assert.ok(server.includes("publication_authorized:false"));
assert.ok(server.includes("live_execution_authorized:false"));
assert.ok(server.includes("open_positions:[]"));
assert.ok(server.includes("position_accounting_ready:false"));
assert.ok(server.includes("route==='/api/shadow/simulate'){if(!auth(req))return send(res,401,{error:'unauthorized'});"));

assert.ok(walletPortfolio.includes("base_currency: 'USDC'"));
assert.ok(walletPortfolio.includes("gas_currency: 'SOL'"));
assert.ok(walletPortfolio.includes('read_only: true'));
assert.ok(walletPortfolio.includes('non_custodial: true'));
assert.ok(walletPortfolio.includes('signer_required: false'));
assert.ok(walletPortfolio.includes('transaction_created: false'));
assert.ok(walletPortfolio.includes('funds_moved: false'));
assert.ok(walletPortfolio.includes('live_execution_authorized: false'));
assert.ok(walletPortfolio.includes("available_for_copy_usdc: null"));
assert.ok(executionRequests.includes('async listForFollower(userId, limit = 100)'));
assert.ok(executionRequests.includes('WHERE er.follower_user_id=$1'));
assert.ok(executionRequests.includes('LEFT JOIN trade_events te ON te.event_id=er.event_id'));

assert.ok(reconciledService.includes('createReconciliationRuntimeService'));
assert.ok(reconciledService.includes('reconciliation_manual_metrics_blocked'));
assert.ok(reconciledService.includes('coordinateAndRecord'));
assert.ok(reconciliationRuntime.includes('coordinateReconciliationSources'));
assert.ok(reconciliationRuntime.includes("status: 'PENDING_CONFIGURATION'"));
assert.ok(reconciliationRuntime.includes("status: 'RECONCILIATION_RECORDED'"));
assert.ok(reconciliationRuntime.includes('ledger_recorded: false'));
assert.ok(reconciliationRuntime.includes("source_type: 'AETHER_COORDINATED_RECONCILIATION'"));
assert.equal(reconciliationRuntime.includes('verification_authorized: true'), false);
assert.equal(reconciliationRuntime.includes('publication_authorized: true'), false);
assert.equal(reconciliationRuntime.includes('live_execution_authorized: true'), false);

console.log('api contract regression: PASS');
