import crypto from 'node:crypto';
import {
  proposeFeeConfigChange,
  approveFeeConfigChange,
  applyApprovedFeeConfig,
} from '../fee-control.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalUuid(value, name) {
  const text = String(value ?? '').trim();
  if (!UUID.test(text) || text !== text.toLowerCase()) throw new Error(`invalid_${name}`);
  return text;
}

function canonicalActor(actor, role) {
  if (!actor || typeof actor !== 'object' || actor.role !== role) throw new Error(`${role.toLowerCase()}_required`);
  const actorId = String(actor.actor_id ?? '');
  if (actorId !== actorId.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actorId)) throw new Error('invalid_actor_id');
  return { role, actor_id: actorId };
}

function configFromValues(performanceFeeBps, executionFeeBps, configuredBy) {
  return Object.freeze({
    schema: 'aether.fee_control.v1',
    mode: 'SHADOW',
    performance_fee_bps: Number(performanceFeeBps),
    execution_fee_bps: Number(executionFeeBps),
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false,
    configured_by: configuredBy,
  });
}

function changeFromRow(row) {
  if (!row) throw new Error('fee_change_not_found');
  return Object.freeze({
    schema: 'aether.fee_control_change.v1',
    status: row.status,
    requested_by: row.requested_by,
    approved_by: row.approved_by,
    current: configFromValues(row.current_performance_fee_bps, row.current_execution_fee_bps, 'db:persisted'),
    proposed: configFromValues(row.proposed_performance_fee_bps, row.proposed_execution_fee_bps, row.requested_by),
    applied: row.status === 'APPLIED',
  });
}

async function withTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('fee_control_repository_pool_required');
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

async function setActor(client, actor) {
  await client.query(`SELECT set_config('aether.actor',$1,true)`, [actor.actor_id]);
  await client.query(`SELECT set_config('aether.actor_role',$1,true)`, [actor.role]);
}

export function createFeeControlApprovalRepository(pool) {
  return Object.freeze({
    async propose({ config_id = 1, proposed, operator } = {}) {
      const actor = canonicalActor(operator, 'FEE_CONFIG_OPERATOR');
      if (!Number.isSafeInteger(config_id) || config_id <= 0) throw new Error('invalid_fee_config_id');

      return withTransaction(pool, async client => {
        await setActor(client, actor);
        const currentResult = await client.query(
          `SELECT config_id,performance_fee_bps,execution_fee_bps FROM platform_fee_config WHERE config_id=$1 FOR UPDATE`,
          [config_id],
        );
        const row = currentResult.rows[0];
        if (!row) throw new Error('fee_config_not_found');

        const current = configFromValues(row.performance_fee_bps, row.execution_fee_bps, 'db:persisted');
        const change = proposeFeeConfigChange(current, {
          performance_fee_bps: proposed?.performance_fee_bps,
          execution_fee_bps: proposed?.execution_fee_bps,
          mode: 'SHADOW',
          live_execution_authorized: false,
        }, actor);
        const changeId = crypto.randomUUID();

        const inserted = await client.query(
          `INSERT INTO fee_control_changes(
             change_id,config_id,status,requested_by,requested_role,
             current_performance_fee_bps,current_execution_fee_bps,
             proposed_performance_fee_bps,proposed_execution_fee_bps,
             mode,live_execution_authorized,network_submission_authorized,signer_required
           ) VALUES($1,$2,'PENDING_APPROVAL',$3,'FEE_CONFIG_OPERATOR',$4,$5,$6,$7,'SHADOW',false,false,false)
           RETURNING *`,
          [changeId, config_id, actor.actor_id, current.performance_fee_bps, current.execution_fee_bps,
            change.proposed.performance_fee_bps, change.proposed.execution_fee_bps],
        );
        return inserted.rows[0];
      });
    },

    async approve(changeIdInput, approver) {
      const changeId = canonicalUuid(changeIdInput, 'fee_change_id');
      const actor = canonicalActor(approver, 'FEE_CONFIG_APPROVER');

      return withTransaction(pool, async client => {
        await setActor(client, actor);
        const selected = await client.query(`SELECT * FROM fee_control_changes WHERE change_id=$1 FOR UPDATE`, [changeId]);
        const row = selected.rows[0];
        const approved = approveFeeConfigChange(changeFromRow(row), actor);
        const updated = await client.query(
          `UPDATE fee_control_changes
             SET status='APPROVED',approved_by=$2,approved_role='FEE_CONFIG_APPROVER',approved_at=now()
           WHERE change_id=$1 AND status='PENDING_APPROVAL'
           RETURNING *`,
          [changeId, approved.approved_by],
        );
        if (!updated.rows[0]) throw new Error('fee_change_concurrent_state_conflict');
        return updated.rows[0];
      });
    },

    async apply(changeIdInput, applier) {
      const changeId = canonicalUuid(changeIdInput, 'fee_change_id');
      const actor = canonicalActor(applier, 'FEE_CONFIG_APPLIER');

      return withTransaction(pool, async client => {
        await setActor(client, actor);
        const selected = await client.query(`SELECT * FROM fee_control_changes WHERE change_id=$1 FOR UPDATE`, [changeId]);
        const row = selected.rows[0];
        const result = applyApprovedFeeConfig(changeFromRow(row), actor);

        await client.query(`SELECT set_config('aether.fee_change_id',$1,true)`, [changeId]);
        const configUpdate = await client.query(
          `UPDATE platform_fee_config
             SET performance_fee_bps=$2,execution_fee_bps=$3,updated_at=now()
           WHERE config_id=$1
           RETURNING config_id,performance_fee_bps,execution_fee_bps,currency,enabled,updated_at`,
          [row.config_id, result.config.performance_fee_bps, result.config.execution_fee_bps],
        );
        if (!configUpdate.rows[0]) throw new Error('fee_config_not_found');

        const applied = await client.query(
          `UPDATE fee_control_changes
             SET status='APPLIED',applied_by=$2,applied_role='FEE_CONFIG_APPLIER',applied_at=now()
           WHERE change_id=$1 AND status='APPROVED'
           RETURNING *`,
          [changeId, actor.actor_id],
        );
        if (!applied.rows[0]) throw new Error('fee_change_concurrent_state_conflict');

        return Object.freeze({
          config: configUpdate.rows[0],
          change: applied.rows[0],
          audit: Object.freeze({
            ...result.audit,
            change_id: changeId,
            persistence: 'POSTGRES_TRANSACTION',
            execution_dispatched: false,
          }),
        });
      });
    },

    async get(changeIdInput) {
      const changeId = canonicalUuid(changeIdInput, 'fee_change_id');
      const result = await pool.query(`SELECT * FROM fee_control_changes WHERE change_id=$1`, [changeId]);
      return result.rows[0] ?? null;
    },
  });
}
