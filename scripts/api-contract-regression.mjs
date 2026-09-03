import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { API_CONTRACT } from '../services/api/src/api-contract.mjs';

const server = await fs.readFile(new URL('../services/api/src/server.mjs', import.meta.url), 'utf8');
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
  'POST /api/autotrade/evaluate',
  'POST /api/executions',
  'POST /api/internal/traders/:traderId/reconciled-trades',
  'POST /api/admin/traders/:traderId/evidence/collect',
  'POST /api/admin/traders/:traderId/evidence/reconcile',
  'PATCH /api/admin/traders/:traderId/verification',
  'PATCH /api/admin/traders/:traderId/publication',
  'GET /api/admin/wallets/readiness'
]) {
  assert.ok(allRoutes.includes(required), `contract route missing: ${required}`);
}

for (const stale of [
  'GET /api/admin/system-health',
  'GET /api/admin/circuit-breakers',
  'GET /api/traders/:wallet',
  'POST /api/trade-events',
  'POST /api/follows'
]) {
  assert.equal(allRoutes.includes(stale), false, `stale contract route retained: ${stale}`);
}

assert.equal(API_CONTRACT.deployment_roles.public_edge, 'PUBLIC_EDGE');
assert.equal(API_CONTRACT.deployment_roles.primary_runtime, 'PRIMARY_VM');
assert.equal(API_CONTRACT.invariants.execution_mode, 'SHADOW');
assert.equal(API_CONTRACT.invariants.live_execution_authorized, false);
assert.equal(API_CONTRACT.invariants.signer_exposed_to_api, false);
assert.equal(API_CONTRACT.invariants.public_edge_blocks_internal_and_admin_routes, true);
assert.equal(API_CONTRACT.invariants.market_token_lookup_is_read_only, true);
assert.equal(API_CONTRACT.invariants.wallet_portfolio_is_session_bound, true);
assert.equal(API_CONTRACT.invariants.wallet_portfolio_is_read_only, true);
assert.equal(API_CONTRACT.invariants.wallet_portfolio_never_authorizes_live, true);
assert.equal(API_CONTRACT.invariants.copy_trade_activity_is_session_bound, true);
assert.equal(API_CONTRACT.invariants.copy_trade_activity_never_authorizes_live, true);
assert.equal(API_CONTRACT.invariants.copy_trade_open_positions_not_inferred_from_execution_requests, true);
assert.equal(API_CONTRACT.invariants.evidence_collection_does_not_verify, true);
assert.equal(API_CONTRACT.invariants.evidence_recording_does_not_verify, true);
assert.equal(API_CONTRACT.invariants.reconciled_performance_evidence_does_not_verify, true);
assert.equal(API_CONTRACT.invariants.direct_reconciliation_metrics_ingest_blocked, true);
assert.equal(API_CONTRACT.invariants.coordinated_reconciliation_sources_required, true);
assert.equal(API_CONTRACT.invariants.incomplete_reconciliation_sources_do_not_write_ledger, true);
assert.equal(API_CONTRACT.invariants.verification_does_not_publish, true);
assert.equal(API_CONTRACT.invariants.publication_requires_prior_verification, true);
assert.equal(API_CONTRACT.invariants.copy_mandate_requires_published_verified_trader, true);
assert.equal(API_CONTRACT.invariants.auto_trade_execution_dispatched, false);
assert.equal(API_CONTRACT.invariants.shadow_simulation_never_authorizes_live, true);
assert.equal(API_CONTRACT.invariants.shadow_simulation_requires_api_token, true);

for (const literal of [
  "route==='/api/health'",
  "route==='/api/execution/status'",
  "route==='/api/autotrade/status'",
  "route==='/api/account/wallet-portfolio'",
  "route==='/api/account/trader'",
  "route==='/api/account/copy-mandates'",
  "route==='/api/account/copy-trades'",
  "route==='/api/autotrade/evaluate'",
  "route==='/api/shadow/simulate'",
  "route==='/api/executions'",
  "route==='/api/admin/wallets/readiness'",
  "route==='/api/admin/fees'"
]) {
  assert.ok(server.includes(literal), `primary implementation missing: ${literal}`);
}

for (const segment of [
  "p[4]==='reconciled-trades'",
  "p[5]==='collect'",
  "p[5]==='reconcile'",
  "p[4]==='verification'",
  "p[4]==='publication'"
]) {
  assert.ok(server.includes(segment), `primary dynamic route missing: ${segment}`);
}

assert.ok(edge.includes("path === '/api/market/token'"));
assert.ok(edge.includes("'/api/account/wallet-portfolio'"));
assert.ok(edge.includes("'/api/account/copy-trades'"));
assert.ok(edge.includes("read_only: true"));
assert.ok(edge.includes("live_execution_authorized: false"));
assert.ok(edge.includes("error: 'public_gateway_route_blocked'"));
assert.ok(server.includes("execution_dispatched:false"));
assert.ok(server.includes("verification_authorized:false"));
assert.ok(server.includes("publication_authorized:false"));
assert.ok(server.includes("live_execution_authorized:false"));
assert.ok(server.includes("open_positions:[]"));
assert.ok(server.includes("position_accounting_ready:false"));
assert.ok(
  server.includes("route==='/api/shadow/simulate'){if(!auth(req))return send(res,401,{error:'unauthorized'});"),
  'direct PRIMARY_VM shadow simulation must require API_TOKEN before any simulation work'
);
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
