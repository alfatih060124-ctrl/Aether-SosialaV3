import { randomUUID } from 'node:crypto';

export async function runShadowSimulation({ repos, pool, body }) {
  const traderWallet = String(body.trader_wallet || '').trim();
  const followerWallet = String(body.follower_wallet || '').trim();
  const amountUsd = Number(body.amount_usd);
  if (!traderWallet || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { status: 400, body: { error: 'invalid_simulation_request', required: ['trader_wallet', 'amount_usd'] } };
  }

  const trader = await repos.traders.getByWallet(traderWallet);
  if (!trader) return { status: 404, body: { error: 'trader_not_found' } };

  let policyQuery = 'SELECT * FROM copy_policies WHERE trader_id=$1 AND enabled=true ORDER BY created_at ASC';
  let policyParams = [trader.trader_id];
  if (followerWallet) {
    const follower = await pool.query(
      `SELECT user_id FROM shadow_wallet_identities WHERE wallet_address=$1 AND role='FOLLOWER' AND enabled=true`,
      [followerWallet]
    );
    if (!follower.rows[0]) return { status: 404, body: { error: 'follower_not_found' } };
    policyQuery = 'SELECT * FROM copy_policies WHERE trader_id=$1 AND follower_user_id=$2 AND enabled=true ORDER BY created_at ASC';
    policyParams = [trader.trader_id, follower.rows[0].user_id];
  }

  const policies = await pool.query(policyQuery, policyParams);
  if (followerWallet && policies.rowCount === 0) {
    return { status: 404, body: { error: 'copy_policy_not_found' } };
  }

  const eventId = `shadow_${randomUUID()}`;
  const event = await repos.tradeEvents.insert({
    event_id: eventId,
    chain: String(body.chain || 'solana'),
    dex: String(body.dex || 'shadow'),
    trader_wallet: traderWallet,
    token_in: String(body.token_in || 'SIM_IN'),
    token_out: String(body.token_out || 'SIM_OUT'),
    amount_in_raw: String(body.amount_in_raw || '0'),
    amount_out_raw: String(body.amount_out_raw || '0'),
    amount_usd: amountUsd,
    tx_hash: `shadow_${randomUUID()}`,
    slot: Number(body.slot || 0),
    confidence: Number(body.confidence ?? 1),
    observed_at: new Date().toISOString(),
    decoder_version: String(body.decoder_version || 'shadow-v1')
  });

  const results = [];
  for (const policy of policies.rows) {
    const maxCopy = Number(policy.max_copy_amount_usd || 0);
    const maxPosition = Number(policy.max_position_amount_usd || 0);
    const approved = amountUsd <= (maxCopy > 0 ? maxCopy : Infinity) && amountUsd <= (maxPosition > 0 ? maxPosition : Infinity);
    const reason = approved ? 'SHADOW_APPROVED' : 'RISK_LIMIT_EXCEEDED';
    const decision = await repos.riskDecisions.create({
      decision_id: randomUUID(), event_id: event.event_id,
      follower_user_id: policy.follower_user_id,
      decision: approved ? 'APPROVE' : 'REJECT', reason_code: reason
    });
    let execution = null;
    if (approved) {
      execution = await repos.executionRequests.create({
        execution_request_id: randomUUID(),
        idempotency_key: `shadow:${event.event_id}:${policy.follower_user_id}`,
        event_id: event.event_id,
        follower_user_id: policy.follower_user_id,
        requested_amount_usd: amountUsd,
        mode: 'SIMULATION',
        status: 'SIMULATED'
      });
    }
    await repos.auditEvents.append({
      event_type: 'SHADOW_SIMULATION', actor: 'system', entity_type: 'trade_event',
      entity_id: event.event_id,
      payload: {
        policy_id: policy.policy_id,
        follower_user_id: policy.follower_user_id,
        follower_wallet: followerWallet || null,
        decision: decision.decision,
        reason_code: reason,
        execution_request_id: execution?.execution_request_id ?? null
      }
    });
    results.push({
      policy_id: policy.policy_id,
      follower_user_id: policy.follower_user_id,
      follower_wallet: followerWallet || null,
      decision: decision.decision,
      reason_code: reason,
      execution_request_id: execution?.execution_request_id ?? null
    });
  }

  await repos.auditEvents.append({
    event_type: 'SHADOW_EVENT_CREATED', actor: 'system', entity_type: 'trade_event',
    entity_id: event.event_id,
    payload: {
      trader_id: trader.trader_id,
      trader_wallet: traderWallet,
      follower_wallet: followerWallet || null,
      amount_usd: amountUsd,
      policies_evaluated: policies.rowCount
    }
  });

  return {
    status: 201,
    body: {
      mode: 'SHADOW', live_enabled: false,
      event, event_id: event.event_id,
      policies_evaluated: results.length,
      results
    }
  };
}
