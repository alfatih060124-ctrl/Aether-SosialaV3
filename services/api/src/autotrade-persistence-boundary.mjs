import { evaluateAuthenticatedAutoTradeRoute } from './autotrade-route-boundary.mjs';

function requireMethod(target, method, error) {
  if (!target || typeof target[method] !== 'function') throw new Error(error);
  return target[method].bind(target);
}

export async function persistAuthenticatedAutoTradeDecision({
  session,
  requestBody,
  mandateRepository,
  signalRepository,
  auditRepository,
  resolveAssessment,
  resolveRuntimeRisk,
  liveEnabled = false
}) {
  const recordDecision = requireMethod(signalRepository, 'recordDecision', 'autotrade_decision_repository_required');
  const appendAudit = requireMethod(auditRepository, 'append', 'autotrade_audit_repository_required');

  const result = await evaluateAuthenticatedAutoTradeRoute({
    session,
    requestBody,
    mandateRepository,
    resolveAssessment,
    resolveRuntimeRisk,
    liveEnabled
  });

  if (result.execution_dispatched !== false || result.live_execution_authorized !== false || result.network_submission_authorized !== false || result.signer_required !== false) {
    throw new Error('autotrade_persistence_shadow_invariant_failed');
  }

  const mandateReference = Object.freeze({
    schema: 'aether.copy_mandate.persistence_reference.v1',
    mandate_id: result.mandate_id,
    trader_id: result.trader_id,
    caller_authority: false,
    live_execution_authorized: false
  });

  const stored = await recordDecision({
    assessmentId: result.assessment_id,
    decision: result.decision,
    mandate: mandateReference,
    position: requestBody?.position ?? {}
  });
  if (!stored?.decision_id) throw new Error('autotrade_decision_persistence_failed');

  await appendAudit({
    event_type: 'AUTOTRADE_SHADOW_DECISION',
    actor: 'auto-trade-engine',
    entity_type: 'auto_trade_decision',
    entity_id: String(stored.decision_id),
    payload: {
      assessment_id: result.assessment_id,
      mandate_id: result.mandate_id,
      trader_id: result.trader_id,
      token_mint: result.decision?.token_mint ?? null,
      action: result.decision?.action ?? null,
      reason_codes: result.decision?.reason_codes ?? [],
      requested_amount_usd: result.decision?.requested_amount_usd ?? 0,
      ...result.audit_metadata,
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    }
  });

  return Object.freeze({
    schema: 'aether.autotrade.persistence_boundary.v1',
    assessment_id: result.assessment_id,
    decision_id: stored.decision_id,
    mandate_id: result.mandate_id,
    trader_id: result.trader_id,
    assessment: result.assessment,
    decision: result.decision,
    execution_dispatched: false,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}
