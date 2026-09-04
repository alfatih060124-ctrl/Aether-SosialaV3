import { randomUUID } from 'node:crypto';

const finitePositive = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${field}`);
  return n;
};
const finite = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid_${field}`);
  return n;
};
const required = (value, field) => {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${field}_required`);
  return s;
};

export function createShadowPositionLifecycle(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('shadow_lifecycle_pool_required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  async function transact(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function markReady(client, followerUserId, sourceId) {
    const ts = now().toISOString();
    await client.query(
      `INSERT INTO follower_shadow_accounting_state(follower_user_id,accounting_ready,complete_through,source_cursor,source_version,mode,live_execution_authorized,updated_at)
       VALUES($1,true,$2,$3,'shadow-lifecycle-v1','SHADOW',false,now())
       ON CONFLICT(follower_user_id) DO UPDATE SET accounting_ready=true,complete_through=EXCLUDED.complete_through,source_cursor=EXCLUDED.source_cursor,source_version=EXCLUDED.source_version,mode='SHADOW',live_execution_authorized=false,updated_at=now()`,
      [followerUserId, ts, sourceId]
    );
    return ts;
  }

  return Object.freeze({
    async openPosition(input = {}) {
      return transact(async client => {
        const followerUserId = required(input.follower_user_id, 'follower_user_id');
        const policyId = required(input.policy_id, 'policy_id');
        const traderId = required(input.trader_id, 'trader_id');
        const tokenMint = required(input.token_mint, 'token_mint');
        const quoteMint = required(input.quote_mint || 'USDC', 'quote_mint');
        const amountUsdc = finitePositive(input.amount_usdc, 'amount_usdc');
        const entryPrice = finitePositive(input.entry_price_usdc, 'entry_price_usdc');
        const quantity = amountUsdc / entryPrice;
        const sourceId = required(input.source_id || randomUUID(), 'source_id');
        const idempotencyKey = required(input.idempotency_key || `shadow:open:${sourceId}`, 'idempotency_key');
        const existing = await client.query(`SELECT e.position_id FROM follower_shadow_position_events e WHERE e.idempotency_key=$1`, [idempotencyKey]);
        if (existing.rows[0]) return { idempotent: true, position_id: existing.rows[0].position_id, mode: 'SHADOW', live_execution_authorized: false };
        const active = await client.query(`SELECT position_id FROM follower_shadow_positions WHERE follower_user_id=$1 AND policy_id=$2 AND token_mint=$3 AND quote_mint=$4 AND status IN ('OPEN','CLOSING') FOR UPDATE`, [followerUserId, policyId, tokenMint, quoteMint]);
        if (active.rows[0]) throw new Error('shadow_position_already_open');
        const positionId = randomUUID();
        const occurredAt = now().toISOString();
        await client.query(`INSERT INTO follower_shadow_positions(position_id,follower_user_id,policy_id,trader_id,token_mint,quote_mint,status,token_quantity,cost_basis_usdc,realized_pnl_usdc,last_mark_price_usdc,mark_observed_at,mode,live_execution_authorized,opened_at) VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,0,$9,$10,'SHADOW',false,$10)`, [positionId,followerUserId,policyId,traderId,tokenMint,quoteMint,quantity,amountUsdc,entryPrice,occurredAt]);
        await client.query(`INSERT INTO follower_shadow_position_events(event_id,position_id,follower_user_id,policy_id,event_type,token_delta,usdc_delta,realized_pnl_usdc,mark_price_usdc,source_type,source_id,idempotency_key,evidence,mode,live_execution_authorized,occurred_at) VALUES($1,$2,$3,$4,'OPEN',$5,$6,0,$7,'AUTOTRADE_SHADOW',$8,$9,$10::jsonb,'SHADOW',false,$11)`, [randomUUID(),positionId,followerUserId,policyId,quantity,-amountUsdc,entryPrice,sourceId,idempotencyKey,JSON.stringify({expected_net_edge_bps:Number(input.expected_net_edge_bps ?? 0),costs_included:input.costs_included===true,quality_score:Number(input.quality_score ?? 0),decision_reasons:input.decision_reasons||[]}),occurredAt]);
        await markReady(client, followerUserId, sourceId);
        return { position_id: positionId, token_quantity: quantity, cost_basis_usdc: amountUsdc, entry_price_usdc: entryPrice, mode: 'SHADOW', live_execution_authorized: false };
      });
    },

    async markPosition(input = {}) {
      return transact(async client => {
        const positionId = required(input.position_id, 'position_id');
        const markPrice = finitePositive(input.mark_price_usdc, 'mark_price_usdc');
        const sourceId = required(input.source_id || randomUUID(), 'source_id');
        const occurredAt = now().toISOString();
        const row = (await client.query(`SELECT * FROM follower_shadow_positions WHERE position_id=$1 AND mode='SHADOW' AND live_execution_authorized=false FOR UPDATE`, [positionId])).rows[0];
        if (!row) throw new Error('shadow_position_not_found');
        if (row.status === 'CLOSED') throw new Error('shadow_position_closed');
        await client.query(`UPDATE follower_shadow_positions SET last_mark_price_usdc=$2,mark_observed_at=$3,updated_at=now() WHERE position_id=$1`, [positionId,markPrice,occurredAt]);
        await client.query(`INSERT INTO follower_shadow_position_events(event_id,position_id,follower_user_id,policy_id,event_type,mark_price_usdc,source_type,source_id,idempotency_key,evidence,mode,live_execution_authorized,occurred_at) VALUES($1,$2,$3,$4,'MARK',$5,'MARKET_DATA_SHADOW',$6,$7,'{}'::jsonb,'SHADOW',false,$8) ON CONFLICT(idempotency_key) DO NOTHING`, [randomUUID(),positionId,row.follower_user_id,row.policy_id,markPrice,sourceId,input.idempotency_key||`shadow:mark:${positionId}:${sourceId}`,occurredAt]);
        await markReady(client,row.follower_user_id,sourceId);
        const marketValue = Number(row.token_quantity) * markPrice;
        return { position_id:positionId, mark_price_usdc:markPrice, market_value_usdc:marketValue, unrealized_pnl_usdc:marketValue-Number(row.cost_basis_usdc), mode:'SHADOW', live_execution_authorized:false };
      });
    },

    async closePosition(input = {}) {
      return transact(async client => {
        const positionId = required(input.position_id, 'position_id');
        const exitPrice = finitePositive(input.exit_price_usdc, 'exit_price_usdc');
        const sourceId = required(input.source_id || randomUUID(), 'source_id');
        const idempotencyKey = required(input.idempotency_key || `shadow:close:${sourceId}`, 'idempotency_key');
        const existing = await client.query(`SELECT position_id,realized_pnl_usdc FROM follower_shadow_position_events WHERE idempotency_key=$1`, [idempotencyKey]);
        if (existing.rows[0]) return { idempotent:true, position_id:existing.rows[0].position_id, realized_pnl_usdc:Number(existing.rows[0].realized_pnl_usdc), mode:'SHADOW', live_execution_authorized:false };
        const row = (await client.query(`SELECT * FROM follower_shadow_positions WHERE position_id=$1 AND mode='SHADOW' AND live_execution_authorized=false FOR UPDATE`, [positionId])).rows[0];
        if (!row) throw new Error('shadow_position_not_found');
        if (row.status === 'CLOSED') throw new Error('shadow_position_closed');
        const quantity = finite(row.token_quantity,'token_quantity');
        const proceeds = quantity * exitPrice;
        const costBasis = finite(row.cost_basis_usdc,'cost_basis_usdc');
        const realized = proceeds - costBasis;
        const occurredAt = now().toISOString();
        await client.query(`UPDATE follower_shadow_positions SET status='CLOSED',token_quantity=0,cost_basis_usdc=0,realized_pnl_usdc=realized_pnl_usdc+$2,last_mark_price_usdc=$3,mark_observed_at=$4,closed_at=$4,updated_at=now() WHERE position_id=$1`, [positionId,realized,exitPrice,occurredAt]);
        await client.query(`INSERT INTO follower_shadow_position_events(event_id,position_id,follower_user_id,policy_id,event_type,token_delta,usdc_delta,realized_pnl_usdc,mark_price_usdc,source_type,source_id,idempotency_key,evidence,mode,live_execution_authorized,occurred_at) VALUES($1,$2,$3,$4,'CLOSE',$5,$6,$7,$8,'AUTOTRADE_SHADOW',$9,$10,$11::jsonb,'SHADOW',false,$12)`, [randomUUID(),positionId,row.follower_user_id,row.policy_id,-quantity,proceeds,realized,exitPrice,sourceId,idempotencyKey,JSON.stringify({exit_reasons:input.exit_reasons||[]}),occurredAt]);
        await markReady(client,row.follower_user_id,sourceId);
        return { position_id:positionId, proceeds_usdc:proceeds, realized_pnl_usdc:realized, return_bps:costBasis>0?(realized/costBasis)*10000:null, closed_at:occurredAt, mode:'SHADOW', live_execution_authorized:false };
      });
    }
  });
}
