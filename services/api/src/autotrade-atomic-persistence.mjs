import { persistAuthenticatedAutoTradeDecision } from './autotrade-persistence-boundary.mjs';
import { createCopyMandateRuntimeRepository } from './copy-mandate-runtime.mjs';
import { createSignalIntelligenceRepository } from './repositories/signal-intelligence.mjs';
import { createCoreRepositories } from './repositories/core.mjs';

function requireFactory(factory, error) {
  if (typeof factory !== 'function') throw new Error(error);
  return factory;
}

export async function persistAuthenticatedAutoTradeDecisionAtomically({
  pool,
  session,
  requestBody,
  resolveAssessment,
  resolveRuntimeRisk,
  liveEnabled = false,
  createMandateRepository = createCopyMandateRuntimeRepository,
  createSignalRepository = createSignalIntelligenceRepository,
  createAuditRepository = (client) => createCoreRepositories(client).auditEvents
}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('autotrade_transaction_pool_required');
  const mandateFactory = requireFactory(createMandateRepository, 'autotrade_mandate_repository_factory_required');
  const signalFactory = requireFactory(createSignalRepository, 'autotrade_signal_repository_factory_required');
  const auditFactory = requireFactory(createAuditRepository, 'autotrade_audit_repository_factory_required');

  const client = await pool.connect();
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
    throw new Error('autotrade_transaction_client_invalid');
  }

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;

    const mandateRepository = mandateFactory(client);
    const signalRepository = signalFactory(client);
    const auditRepository = auditFactory(client);

    const result = await persistAuthenticatedAutoTradeDecision({
      session,
      requestBody,
      mandateRepository,
      signalRepository,
      auditRepository,
      resolveAssessment,
      resolveRuntimeRisk,
      liveEnabled
    });

    if (
      result.execution_dispatched !== false ||
      result.live_execution_authorized !== false ||
      result.network_submission_authorized !== false ||
      result.signer_required !== false
    ) {
      throw new Error('autotrade_atomic_shadow_invariant_failed');
    }

    await client.query('COMMIT');
    return Object.freeze({
      ...result,
      schema: 'aether.autotrade.atomic_persistence.v1',
      decision_audit_atomic: true,
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    });
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        const wrapped = new Error('autotrade_transaction_rollback_failed', { cause: error });
        wrapped.rollback_error = rollbackError;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
