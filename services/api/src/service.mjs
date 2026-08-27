import crypto from 'node:crypto';

export function createAetherService({ repos, riskEngine, simulator }) {
  return {
    async recentTrades(limit) { return repos.tradeEvents.recent(limit); },
    async traders(limit = 50) { return repos.traders.list?.(limit) ?? []; },
    async policies(userId) { return repos.copyPolicies.listForFollower(userId); },
    async simulate({ event, trader, policy, executionRequest, portfolio = {}, circuitBreakerActive = false }) {
      const risk = riskEngine({ event, trader, policy, portfolio, circuitBreakerActive });
      const decisionId = crypto.randomUUID();
      await repos.riskDecisions.create({ decision_id: decisionId, event_id: event.event_id, follower_user_id: executionRequest.follower_user_id, decision: risk.decision, reason_code: risk.reason });
      await repos.auditEvents.append({ event_type: 'RISK_DECISION', actor: 'api', entity_type: 'trade_event', entity_id: event.event_id, payload: risk });
      if (risk.decision !== 'APPROVED') return { risk, execution: null };
      const execution = simulator({ executionRequest, tradeEvent: event, policy });
      await repos.auditEvents.append({ event_type: 'EXECUTION_SIMULATION', actor: 'api', entity_type: 'execution_request', entity_id: executionRequest.id, payload: execution });
      return { risk, execution };
    }
  };
}
