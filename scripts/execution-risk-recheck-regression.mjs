import assert from 'node:assert/strict';
import { evaluateExecutionRiskRecheck, EXECUTION_RISK_RECHECK_CONTRACT } from '../services/api/src/execution-risk-recheck.mjs';

const intent = {
  mode: 'SHADOW',
  live_execution_authorized: false,
  mandate_id: '11111111-1111-4111-8111-111111111111',
  max_slippage_bps: 100,
  expires_at: '2026-09-04T00:10:00.000Z'
};
const baseRisk = {
  source: 'BACKEND_INTERNAL',
  authoritative: true,
  caller_authority: false,
  allowed: true,
  mandate_active: true,
  trader_verified: true,
  marketplace_published: true,
  market_data_fresh: true,
  net_edge_costs_included: true,
  expected_net_edge_bps: 10,
  estimated_price_impact_bps: 25,
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false,
  signer_used: false
};
const now = Date.parse('2026-09-04T00:00:00.000Z');

assert.equal(EXECUTION_RISK_RECHECK_CONTRACT.hard_min_expected_net_edge_bps, 10);

const pass = evaluateExecutionRiskRecheck({ intent, risk: baseRisk, now });
assert.equal(pass.passed, true);
assert.equal(pass.execution_dispatched, false);
assert.equal(pass.network_submission, false);
assert.equal(pass.live_execution_authorized, false);
assert.equal(pass.signer_required, false);

const below = evaluateExecutionRiskRecheck({ intent, risk: { ...baseRisk, expected_net_edge_bps: 9 }, now });
assert.equal(below.passed, false);
assert.ok(below.reason_codes.includes('EXPECTED_NET_EDGE_BELOW_MINIMUM'));

const noCosts = evaluateExecutionRiskRecheck({ intent, risk: { ...baseRisk, net_edge_costs_included: false }, now });
assert.equal(noCosts.passed, false);
assert.ok(noCosts.reason_codes.includes('NET_EDGE_COSTS_UNVERIFIED'));

const callerRisk = evaluateExecutionRiskRecheck({ intent, risk: { ...baseRisk, source: 'CALLER', authoritative: false, caller_authority: true }, now });
assert.equal(callerRisk.passed, false);
assert.ok(callerRisk.reason_codes.includes('RISK_SOURCE_NOT_AUTHORITATIVE'));

const unpublished = evaluateExecutionRiskRecheck({ intent, risk: { ...baseRisk, marketplace_published: false }, now });
assert.equal(unpublished.passed, false);
assert.ok(unpublished.reason_codes.includes('TRADER_NOT_PUBLISHED'));

const expired = evaluateExecutionRiskRecheck({ intent, risk: baseRisk, now: Date.parse('2026-09-04T00:11:00.000Z') });
assert.equal(expired.passed, false);
assert.ok(expired.reason_codes.includes('EXECUTION_INTENT_EXPIRED'));

const signer = evaluateExecutionRiskRecheck({ intent, risk: { ...baseRisk, signer_required: true }, now });
assert.equal(signer.passed, false);
assert.ok(signer.reason_codes.includes('SIGNER_FORBIDDEN'));
assert.equal(signer.execution_dispatched, false);

console.log(JSON.stringify({ ok: true, tests: 7, schema: EXECUTION_RISK_RECHECK_CONTRACT.schema, hard_min_expected_net_edge_bps: 10, posture: 'SHADOW_FAIL_CLOSED' }));
