import { buildExecutionIntent } from './execution-boundary.mjs';

const ACTIVE = 'ACTIVE';
const SHADOW = 'SHADOW';
const EXECUTABLE_ACTIONS = new Set(['BUY', 'SELL']);

function text(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name}_required`);
  return out;
}

function assertTraderGate(trader = {}) {
  if (String(trader.status || '').toUpperCase() !== ACTIVE) throw new Error('trader_not_active');
  if (trader.verified !== true || String(trader.verification_status || '').toUpperCase() !== 'VERIFIED') throw new Error('trader_not_verified');
  if (trader.published !== true) throw new Error('trader_not_published');
  if (String(trader.mode || SHADOW).toUpperCase() !== SHADOW) throw new Error('non_shadow_trader_blocked');
  return text(trader.trader_id, 'trader_id');
}

function assertCopyMandateGate(mandate = {}, traderId) {
  const mandateId = text(mandate.policy_id || mandate.mandate_id, 'mandate_id');
  const followerUserId = text(mandate.follower_user_id, 'follower_user_id');
  if (String(mandate.status || '').toUpperCase() !== ACTIVE) throw new Error('copy_mandate_not_active');
  if (String(mandate.mode || SHADOW).toUpperCase() !== SHADOW) throw new Error('non_shadow_copy_mandate_blocked');
  if (mandate.live_execution_authorized !== false) throw new Error('copy_mandate_live_authorization_blocked');
  if (text(mandate.trader_id, 'mandate_trader_id') !== traderId) throw new Error('copy_mandate_trader_mismatch');
  return { mandateId, followerUserId };
}

export function buildAutoTradeExecutionIntent({
  decision,
  trader,
  mandate,
  sourceDecisionId,
  signalAssessmentId = null,
  createdAt = Date.now(),
  ttlMs = 30_000
} = {}) {
  if (!decision || typeof decision !== 'object') throw new Error('autotrade_decision_required');
  const action = String(decision.action || '').toUpperCase();
  if (!EXECUTABLE_ACTIONS.has(action)) throw new Error('autotrade_decision_not_executable');
  if (String(decision.mode || '').toUpperCase() !== SHADOW) throw new Error('non_shadow_autotrade_decision_blocked');
  if (decision.live_execution_authorized !== false) throw new Error('autotrade_live_authorization_blocked');
  if (Number(decision.requested_amount_usd) <= 0) throw new Error('invalid_autotrade_requested_amount');

  const traderId = assertTraderGate(trader);
  const { mandateId, followerUserId } = assertCopyMandateGate(mandate, traderId);
  const maxSlippageBps = Number(mandate.max_slippage_bps ?? decision.max_slippage_bps ?? 100);

  return buildExecutionIntent({
    source_decision_id: text(sourceDecisionId, 'source_decision_id'),
    signal_assessment_id: signalAssessmentId,
    trader_id: traderId,
    follower_user_id: followerUserId,
    mandate_id: mandateId,
    token_mint: decision.token_mint,
    side: action,
    requested_amount_usd: decision.requested_amount_usd,
    max_slippage_bps: maxSlippageBps,
    mode: SHADOW,
    created_at: createdAt,
    ttl_ms: ttlMs,
    source: 'AUTO_TRADE_ENGINE',
    risk_context: {
      adapter: 'AUTO_TRADE_TO_EXECUTION_INTENT_V1',
      trader_gate: {
        active: true,
        verified: true,
        published: true,
        mode: SHADOW
      },
      copy_mandate_gate: {
        active: true,
        mode: SHADOW,
        live_execution_authorized: false,
        max_slippage_bps: maxSlippageBps
      },
      decision_reason_codes: Array.isArray(decision.reason_codes) ? decision.reason_codes.map(String) : []
    }
  });
}
