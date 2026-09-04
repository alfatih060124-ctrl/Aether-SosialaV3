import { createShadowPositionLifecycle } from './shadow-position-lifecycle.mjs';

const finitePositive = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${field}`);
  return n;
};

function quoteMint(assessment = {}) {
  return String(assessment.quote_mint || assessment.snapshot?.quote_mint || 'USDC');
}

function currentPrice(assessment = {}) {
  return finitePositive(
    assessment.snapshot?.current_price_usdc ?? assessment.snapshot?.price_usdc ?? assessment.price_usdc,
    'shadow_market_price_usdc'
  );
}

export function createShadowAutoTradeLifecycleBridge(pool, options = {}) {
  const lifecycle = options.lifecycle || createShadowPositionLifecycle(pool, options);

  return Object.freeze({
    async applyDecision({ decision, assessment, mandate, position = {}, context = {} } = {}) {
      if (!decision || decision.mode !== 'SHADOW' || decision.live_execution_authorized !== false) {
        throw new Error('shadow_decision_required');
      }
      if (context.liveEnabled === true || String(context.executionMode || 'SHADOW').toUpperCase() !== 'SHADOW') {
        throw new Error('shadow_lifecycle_live_blocked');
      }

      const action = String(decision.action || '').toUpperCase();
      const price = currentPrice(assessment);
      const sourceId = String(context.source_id || context.assessment_id || assessment?.assessment_id || `${assessment?.token_mint || 'token'}:${Date.now()}`);

      if (action === 'BUY') {
        const amountUsdc = finitePositive(decision.requested_amount_usd, 'requested_amount_usd');
        return lifecycle.openPosition({
          follower_user_id: mandate.follower_user_id,
          policy_id: mandate.policy_id,
          trader_id: mandate.trader_id,
          token_mint: assessment.token_mint || assessment.snapshot?.token_mint,
          quote_mint: quoteMint(assessment),
          amount_usdc: amountUsdc,
          entry_price_usdc: price,
          source_id: sourceId,
          idempotency_key: `shadow:autotrade:buy:${mandate.policy_id}:${sourceId}`,
          expected_net_edge_bps: assessment.snapshot?.expected_net_edge_bps ?? assessment.snapshot?.net_edge_bps ?? 0,
          costs_included: assessment.snapshot?.costs_verified === true || assessment.snapshot?.costs_included === true,
          quality_score: assessment.quality_score,
          decision_reasons: decision.reason_codes || []
        });
      }

      if (action === 'SELL') {
        const positionId = position.position_id;
        if (!positionId) throw new Error('shadow_position_id_required_for_sell');
        return lifecycle.closePosition({
          position_id: positionId,
          exit_price_usdc: price,
          source_id: sourceId,
          idempotency_key: `shadow:autotrade:sell:${positionId}:${sourceId}`,
          exit_reasons: decision.reason_codes || []
        });
      }

      if (action === 'HOLD' && position.position_id) {
        return lifecycle.markPosition({
          position_id: position.position_id,
          mark_price_usdc: price,
          source_id: sourceId,
          idempotency_key: `shadow:autotrade:mark:${position.position_id}:${sourceId}`
        });
      }

      return Object.freeze({
        action,
        persisted: false,
        mode: 'SHADOW',
        live_execution_authorized: false,
        reason_codes: decision.reason_codes || []
      });
    }
  });
}
