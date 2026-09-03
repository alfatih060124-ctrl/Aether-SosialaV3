const HARD_MIN_EXPECTED_NET_EDGE_BPS = 10;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid_${name}`);
  return number;
}

function isCanonicalUuid(value) {
  return typeof value === 'string' && CANONICAL_UUID_RE.test(value);
}

export const EXECUTION_RISK_RECHECK_CONTRACT = Object.freeze({
  schema: 'aether.execution.risk_recheck.v1',
  mode: 'SHADOW',
  authority: 'BACKEND_INTERNAL',
  caller_authority: false,
  hard_min_expected_net_edge_bps: HARD_MIN_EXPECTED_NET_EDGE_BPS,
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false
});

export function evaluateExecutionRiskRecheck({ intent, risk = {}, now = Date.now() } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('invalid_execution_intent');
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) throw new Error('invalid_execution_risk_snapshot');
  if (intent.mode !== 'SHADOW' || intent.live_execution_authorized !== false) throw new Error('execution_intent_fail_closed');

  const reasons = [];
  const nowMs = finiteNumber(now, 'execution_risk_now');
  const expiresAtMs = Date.parse(intent.expires_at);
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) reasons.push('EXECUTION_INTENT_EXPIRED');
  if (risk.source !== 'BACKEND_INTERNAL' || risk.authoritative !== true || risk.caller_authority === true) reasons.push('RISK_SOURCE_NOT_AUTHORITATIVE');
  if (risk.allowed !== true) reasons.push('RISK_POLICY_NOT_ALLOWED');

  if (intent.mandate_id !== null && intent.mandate_id !== undefined) {
    if (!isCanonicalUuid(intent.mandate_id)) reasons.push('MANDATE_ID_INVALID');
    else if (risk.mandate_active !== true) reasons.push('MANDATE_NOT_ACTIVE');
  }

  if (risk.trader_verified !== true) reasons.push('TRADER_NOT_VERIFIED');
  if (risk.marketplace_published !== true) reasons.push('TRADER_NOT_PUBLISHED');
  if (risk.market_data_fresh !== true) reasons.push('MARKET_DATA_STALE_OR_UNVERIFIED');
  if (risk.net_edge_costs_included !== true) reasons.push('NET_EDGE_COSTS_UNVERIFIED');

  const expectedNetEdgeBps = Number(risk.expected_net_edge_bps);
  if (!Number.isFinite(expectedNetEdgeBps)) reasons.push('EXPECTED_NET_EDGE_MISSING');
  else if (expectedNetEdgeBps < HARD_MIN_EXPECTED_NET_EDGE_BPS) reasons.push('EXPECTED_NET_EDGE_BELOW_MINIMUM');

  const priceImpactBps = Number(risk.estimated_price_impact_bps);
  const maxSlippageBps = Number(intent.max_slippage_bps);
  if (!Number.isFinite(priceImpactBps) || !Number.isFinite(maxSlippageBps) || priceImpactBps > maxSlippageBps) reasons.push('SLIPPAGE_LIMIT_EXCEEDED');

  if (risk.live_execution_authorized === true) reasons.push('LIVE_AUTHORIZATION_FORBIDDEN');
  if (risk.network_submission_authorized === true) reasons.push('NETWORK_SUBMISSION_AUTHORIZATION_FORBIDDEN');
  if (risk.signer_required === true || risk.signer_used === true) reasons.push('SIGNER_FORBIDDEN');

  return Object.freeze({
    schema: EXECUTION_RISK_RECHECK_CONTRACT.schema,
    passed: reasons.length === 0,
    reason_codes: Object.freeze(reasons),
    hard_min_expected_net_edge_bps: HARD_MIN_EXPECTED_NET_EDGE_BPS,
    execution_dispatched: false,
    network_submission: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    signer_required: false,
    signer_used: false
  });
}
