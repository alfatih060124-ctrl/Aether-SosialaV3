import { evaluateRisk } from '../../api/src/risk-engine.mjs';
import { simulateExecution } from './simulator.mjs';
import { createSimulationReceipt } from './receipt.mjs';

export function runE2E({ event, trader, policy, executionRequest, portfolio = {}, circuitBreakerActive = false }) {
  const risk = evaluateRisk({ event, trader, policy: { ...policy, requested_amount_usd: executionRequest?.requested_amount_usd }, portfolio, circuitBreakerActive });
  if (risk.decision !== 'APPROVED') {
    return { status: 'RISK_REJECTED', risk, execution: null, receipt: null };
  }

  const execution = simulateExecution({ executionRequest, tradeEvent: event, policy });
  const receipt = createSimulationReceipt({ executionRequest, result: execution });
  return { status: execution.status, risk, execution, receipt };
}
