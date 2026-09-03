import { buildAutoTradeMandateFromPersisted } from './copy-mandate-autotrade-adapter.mjs';
import { evaluateAutoTrade } from './auto-trade-engine.mjs';

function requireRepository(repository) {
  if (!repository || typeof repository.getByPolicyId !== 'function') {
    throw new Error('copy_mandate_runtime_repository_required');
  }
  return repository;
}

function canonicalFollowerUserId(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('authenticated_follower_user_id_required');
  if (value !== value.trim()) throw new Error('invalid_authenticated_follower_user_id');
  return value;
}

export async function evaluatePersistedCopyMandateAutoTrade({
  repository,
  authenticatedFollowerUserId,
  policyId,
  assessment,
  position = {},
  runtimeRisk,
  liveEnabled = false
}) {
  if (liveEnabled === true) throw new Error('autotrade_live_blocked');
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) throw new Error('signal_assessment_required');
  if (!position || typeof position !== 'object' || Array.isArray(position)) throw new Error('invalid_position');

  const repo = requireRepository(repository);
  const followerUserId = canonicalFollowerUserId(authenticatedFollowerUserId);
  const persisted = await repo.getByPolicyId(policyId);
  if (!persisted) throw new Error('copy_mandate_not_found');

  const adapted = buildAutoTradeMandateFromPersisted(persisted, followerUserId, runtimeRisk);
  const decision = evaluateAutoTrade({
    assessment,
    mandate: adapted.engine_mandate,
    position,
    runtime: { liveEnabled: false }
  });

  if (decision?.mode !== 'SHADOW' || decision?.live_execution_authorized !== false) {
    throw new Error('autotrade_shadow_invariant_failed');
  }

  return Object.freeze({
    schema: 'aether.autotrade.persisted_mandate_service.v1',
    mandate_id: adapted.mandate_id,
    follower_user_id: adapted.follower_user_id,
    trader_id: adapted.trader_id,
    assessment,
    decision,
    audit_metadata: Object.freeze({
      ...adapted.audit_metadata,
      service_schema: 'aether.autotrade.persisted_mandate_service.v1',
      authenticated_follower_user_id: followerUserId,
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    }),
    execution_dispatched: false,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}
