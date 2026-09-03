import { createCopyMandate, assertCopyMandateAllowsIntent } from './copy-mandate.mjs';

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalPolicyId(value) {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) throw new Error('invalid_policy_id');
  return value;
}

function requireRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('copy_mandate_not_found');
  return row;
}

function assertTraderRuntimeState(row) {
  if (
    row.trader_status !== 'ACTIVE' ||
    row.trader_verified !== true ||
    row.trader_onboarding_status !== 'APPROVED' ||
    row.trader_verification_status !== 'VERIFIED' ||
    row.trader_published !== true
  ) throw new Error('trader_not_copyable');
  if (row.trader_mode !== 'SHADOW') throw new Error('trader_not_shadow');
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
  assertTraderRuntimeState(persisted);
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
      const canonicalId = canonicalPolicyId(policyId);
      const result = await pool.query(
        `SELECT p.policy_id,p.follower_user_id,p.trader_id,p.enabled,p.status,p.mode,p.live_execution_authorized,
                p.max_copy_amount_usd,p.max_position_amount_usd,p.allocation_bps,p.max_slippage_bps,
                p.max_daily_loss_bps,p.stop_drawdown_bps,p.policy_type,p.policy_value,p.consent_version,p.consented_at,
                t.status AS trader_status,t.verified AS trader_verified,t.mode AS trader_mode,
                t.onboarding_status AS trader_onboarding_status,t.verification_status AS trader_verification_status,
                t.published AS trader_published
           FROM copy_policies p
           JOIN traders t ON t.trader_id=p.trader_id
          WHERE p.policy_id=$1`,
        [canonicalId]
      );
      return result.rows[0] ?? null;
    }
  });
}
