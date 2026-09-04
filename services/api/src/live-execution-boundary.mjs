import { assertLiveExecutionAuthorized } from './live-execution-gate.mjs';

function requireFunction(fn, code) {
  if (typeof fn !== 'function') throw new Error(code);
  return fn;
}

export async function dispatchLiveExecution({ decision, gateState, submitSignedTransaction, auditWrite, env = process.env } = {}) {
  const audit = requireFunction(auditWrite, 'live_execution_audit_writer_required');
  if (!decision || typeof decision !== 'object') throw new Error('live_execution_decision_required');
  if (!['BUY', 'SELL'].includes(decision.action)) throw new Error('live_execution_action_not_executable');

  let gate;
  try {
    gate = assertLiveExecutionAuthorized(gateState, env);
  } catch (error) {
    await audit({
      event_type: 'LIVE_EXECUTION_BLOCKED',
      action: decision.action || null,
      token_mint: decision.token_mint || null,
      blockers: Array.isArray(error.blockers) ? error.blockers : ['LIVE_EXECUTION_GATE_CLOSED']
    });
    throw error;
  }

  const submit = requireFunction(submitSignedTransaction, 'live_transaction_submitter_required');
  await audit({
    event_type: 'LIVE_EXECUTION_AUTHORIZED',
    action: decision.action,
    token_mint: decision.token_mint || null,
    requested_amount_usd: decision.requested_amount_usd || 0,
    gate_schema: gate.schema
  });

  const result = await submit({ decision, gate });
  return Object.freeze({
    schema: 'aether.live_execution_boundary.v1',
    execution_dispatched: true,
    live_execution_authorized: true,
    network_submission_authorized: true,
    signer_required: true,
    result
  });
}
