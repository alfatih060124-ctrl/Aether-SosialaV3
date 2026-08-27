export function createSimulationReceipt({ executionRequest, result }) {
  return {
    execution_request_id: executionRequest.id,
    status: result.status,
    receipt_id: result.receipt_id ?? null,
    tx_hash: null,
    mode: 'SIMULATION',
    live_submission: false,
    result
  };
}
