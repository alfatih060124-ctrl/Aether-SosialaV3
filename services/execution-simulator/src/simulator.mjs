import crypto from 'node:crypto';

export function simulateExecution({ executionRequest, tradeEvent, policy }) {
  if (!executionRequest?.idempotency_key) throw new Error('missing_idempotency_key');
  if (!tradeEvent?.token_in || !tradeEvent?.token_out) throw new Error('missing_trade_event');

  const requested = Number(executionRequest.requested_amount_usd ?? 0);
  const maxCopy = Number(policy?.max_copy_amount_usd ?? 0);
  const maxPosition = Number(policy?.max_position_amount_usd ?? 0);
  if (requested <= 0 || requested > maxCopy || requested > maxPosition) {
    return { status: 'REJECTED', reason: 'SIMULATION_LIMIT_REJECTED' };
  }

  const receiptId = crypto.createHash('sha256')
    .update(`${executionRequest.idempotency_key}:${tradeEvent.event_id}`)
    .digest('hex');

  return {
    status: 'SIMULATED',
    receipt_id: receiptId,
    execution_request_id: executionRequest.id,
    route: {
      token_in: tradeEvent.token_in,
      token_out: tradeEvent.token_out,
      amount_usd: requested
    },
    tx_hash: null,
    live_submission: false
  };
}
