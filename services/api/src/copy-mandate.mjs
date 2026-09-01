const POLICY_TYPES = new Set(['FIXED_USD', 'PERCENT_EQUITY', 'CAPPED_PROPORTIONAL']);
const MANDATE_STATUSES = new Set(['ACTIVE', 'PAUSED', 'REVOKED']);

export const COPY_MANDATE_SCHEMA = 'aether.copy_mandate.v1';

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid_${field}`);
  return value.trim();
}

function requirePositiveSafeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value * 100)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireIsoTimestamp(value, field) {
  const text = requireString(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) throw new Error(`invalid_${field}`);
  return text;
}

export function createCopyMandate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_copy_mandate');

  const policyType = requireString(input.policy_type, 'policy_type');
  if (!POLICY_TYPES.has(policyType)) throw new Error('invalid_policy_type');

  const status = input.status ?? 'ACTIVE';
  if (!MANDATE_STATUSES.has(status)) throw new Error('invalid_mandate_status');

  if (input.execution_mode !== undefined && input.execution_mode !== 'SHADOW') throw new Error('copy_mandate_shadow_only');
  if (input.live_execution_authorized === true) throw new Error('live_execution_forbidden');
  if (input.network_submission_authorized === true) throw new Error('network_submission_forbidden');
  if (input.signer_required === true) throw new Error('signer_forbidden');

  return Object.freeze({
    schema: COPY_MANDATE_SCHEMA,
    mandate_id: requireString(input.mandate_id, 'mandate_id'),
    follower_user_id: requireString(input.follower_user_id, 'follower_user_id'),
    trader_id: requireString(input.trader_id, 'trader_id'),
    status,
    consent_version: requireString(input.consent_version, 'consent_version'),
    consented_at: requireIsoTimestamp(input.consented_at, 'consented_at'),
    policy: Object.freeze({
      type: policyType,
      value: requirePositiveSafeNumber(input.value, 'policy_value'),
      max_copy_amount_usd: requirePositiveSafeNumber(input.max_copy_amount_usd, 'max_copy_amount'),
      max_position_amount_usd: requirePositiveSafeNumber(input.max_position_amount_usd, 'max_position_amount')
    }),
    execution_mode: 'SHADOW',
    execution_scope: 'INTENT_ONLY',
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}

export function assertCopyMandateAllowsIntent(mandate, context = {}) {
  if (!mandate || mandate.schema !== COPY_MANDATE_SCHEMA) throw new Error('invalid_copy_mandate_schema');
  if (mandate.status !== 'ACTIVE') throw new Error('copy_mandate_not_active');
  if (mandate.execution_mode !== 'SHADOW' || mandate.execution_scope !== 'INTENT_ONLY') throw new Error('copy_mandate_scope_violation');
  if (mandate.live_execution_authorized !== false) throw new Error('live_execution_forbidden');
  if (mandate.network_submission_authorized !== false) throw new Error('network_submission_forbidden');
  if (mandate.signer_required !== false) throw new Error('signer_forbidden');

  if (context.follower_user_id !== undefined && context.follower_user_id !== mandate.follower_user_id) {
    throw new Error('copy_mandate_follower_mismatch');
  }
  if (context.trader_id !== undefined && context.trader_id !== mandate.trader_id) {
    throw new Error('copy_mandate_trader_mismatch');
  }

  return Object.freeze({
    allowed: true,
    mandate_id: mandate.mandate_id,
    execution_mode: 'SHADOW',
    execution_scope: 'INTENT_ONLY',
    live_execution_authorized: false,
    network_submission_authorized: false,
    signer_required: false
  });
}
