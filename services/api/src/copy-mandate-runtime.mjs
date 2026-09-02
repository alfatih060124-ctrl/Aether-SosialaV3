import { createCopyMandate, assertCopyMandateAllowsIntent } from './copy-mandate.mjs';

function requireRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('copy_mandate_not_found');
  return row;
}

function persistedStatus(row) {
  const status = String(row.status || '').toUpperCase();
  if (status === 'ACTIVE') {
    if (row.enabled !== true) throw new Error('copy_mandate_disabled');
    return 'ACTIVE';
  }
  if (status === 'PAUSED') return 'PAUSED';
  if (status === 'CANCELLED' || status === 'REVOKED') return 'REVOKED';
  throw new Error('invalid_mandate_status');
}

function finiteMoney(value, field) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(n * 100)) {
    throw new Error(`invalid_${field}`);
  }
  return n;
}

export function hydratePersistedCopyMandate(row) {
  const persisted = requireRow(row);
  const canonical = createCopyMandate({
    mandate_id: persisted.policy_id,
    follower_user_id: persisted.follower_user_id,
    trader_id: persisted.trader_id,
    policy_type: persisted.policy_type,
    value: finiteMoney(persisted.policy_value, 'policy_value'),
    max_copy_amount_usd: finiteMoney(persisted.max_copy_amount_usd, 'max_copy_amount'),
    max_position_amount_usd: finiteMoney(persisted.max_position_amount_usd, 'max_position_amount'),
    status: persistedStatus(persisted),
    consent_version: persisted.consent_version,
    consented_at: persisted.consented_at instanceof Date ? persisted.consented_at.toISOString() : persisted.consented_at,
    execution_mode: persisted.mode,
    live_execution_authorized: persisted.live_execution_authorized,
    network_submission_authorized: false,
    signer_required: false
  });

  if (canonical.policy.max_position_amount_usd < canonical.policy.max_copy_amount_usd) {
    throw new Error('copy_mandate_position_limit_below_copy_limit');
  }
  return canonical;
}

export function assertPersistedCopyMandateAllowsIntent(row, authenticatedContext) {
  const mandate = hydratePersistedCopyMandate(row);
  return Object.freeze({
    mandate,
    authorization: assertCopyMandateAllowsIntent(mandate, authenticatedContext),
    execution_dispatched: false,
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}

export function createCopyMandateRuntimeRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new Error('copy_mandate_repository_pool_required');
  return Object.freeze({
    async getByPolicyId(policyId) {
      if (typeof policyId !== 'string' || policyId.trim() === '') throw new Error('policy_id_required');
      const result = await pool.query(
        `SELECT policy_id,follower_user_id,trader_id,enabled,status,mode,live_execution_authorized,
                max_copy_amount_usd,max_position_amount_usd,allocation_bps,max_slippage_bps,
                max_daily_loss_bps,stop_drawdown_bps,policy_type,policy_value,consent_version,consented_at
           FROM copy_policies
          WHERE policy_id=$1`,
        [policyId.trim()]
      );
      return result.rows[0] ?? null;
    }
  });
}
