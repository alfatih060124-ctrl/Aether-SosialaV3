const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireObject(value, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value;
}

function requireCanonicalIdentity(value, error) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) throw new Error(error);
  return value;
}

function requireSafeNumber(value, field, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || !Number.isSafeInteger(value * 100)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireSafeInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_${field}`);
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== 'string') throw new Error(`invalid_${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`invalid_${field}`);
  return { value, parsed };
}

function canonicalAllowedTokens(value) {
  if (!Array.isArray(value)) throw new Error('invalid_allowed_tokens');
  const tokens = value.map((token) => requireCanonicalIdentity(token, 'invalid_allowed_token'));
  if (new Set(tokens).size !== tokens.length) throw new Error('duplicate_allowed_token');
  return Object.freeze(tokens);
}

export async function resolveBackendRuntimeRisk({
  repository,
  authenticatedFollowerUserId,
  policyId,
  assessment,
  position = {},
  now = () => new Date(),
  maxSnapshotAgeSeconds = 60
}) {
  if (!repository || typeof repository.getRuntimeRiskSnapshot !== 'function') {
    throw new Error('autotrade_runtime_risk_repository_required');
  }
  const followerUserId = requireCanonicalIdentity(authenticatedFollowerUserId, 'authenticated_follower_user_id_required');
  if (typeof policyId !== 'string' || !CANONICAL_UUID_RE.test(policyId)) throw new Error('invalid_policy_id');
  requireObject(assessment, 'signal_assessment_required');
  requireObject(position, 'invalid_position');
  if (typeof now !== 'function') throw new Error('autotrade_runtime_risk_clock_required');
  requireSafeInt(maxSnapshotAgeSeconds, 'max_snapshot_age_seconds', { min: 1, max: 300 });

  const snapshot = requireObject(await repository.getRuntimeRiskSnapshot({
    authenticated_follower_user_id: followerUserId,
    policy_id: policyId,
    assessment,
    position
  }), 'autotrade_runtime_risk_snapshot_required');

  if (snapshot.schema !== 'aether.autotrade.runtime_risk_snapshot.v1') throw new Error('invalid_runtime_risk_snapshot_schema');
  if (snapshot.source !== 'BACKEND_PERSISTED' || snapshot.authoritative !== true) throw new Error('runtime_risk_source_not_authoritative');
  if (snapshot.authenticated_follower_user_id !== followerUserId || snapshot.policy_id !== policyId) {
    throw new Error('runtime_risk_identity_binding_mismatch');
  }
  if (snapshot.live_execution_authorized !== false || snapshot.network_submission_authorized !== false || snapshot.signer_required !== false) {
    throw new Error('runtime_risk_shadow_invariant_failed');
  }

  const observed = canonicalTimestamp(snapshot.observed_at, 'runtime_risk_observed_at');
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error('invalid_runtime_risk_clock');
  const ageMs = current.getTime() - observed.parsed;
  if (ageMs < 0 || ageMs > maxSnapshotAgeSeconds * 1000) throw new Error('runtime_risk_snapshot_stale');

  const capitalLimitUsd = requireSafeNumber(snapshot.capital_limit_usd, 'capital_limit_usd', { min: 0.01 });
  const availableCapitalUsd = requireSafeNumber(snapshot.available_capital_usd, 'available_capital_usd', { min: 0 });
  if (availableCapitalUsd > capitalLimitUsd) throw new Error('available_capital_exceeds_capital_limit');

  return Object.freeze({
    capital_limit_usd: capitalLimitUsd,
    available_capital_usd: availableCapitalUsd,
    daily_realized_pnl_usd: requireSafeNumber(snapshot.daily_realized_pnl_usd, 'daily_realized_pnl_usd'),
    trades_today: requireSafeInt(snapshot.trades_today, 'trades_today'),
    max_trades_per_day: requireSafeInt(snapshot.max_trades_per_day, 'max_trades_per_day', { min: 1, max: 1000 }),
    cooldown_seconds: requireSafeInt(snapshot.cooldown_seconds, 'cooldown_seconds', { max: 86400 * 30 }),
    seconds_since_last_trade: requireSafeInt(snapshot.seconds_since_last_trade, 'seconds_since_last_trade', { max: 86400 * 365 }),
    min_signal_score: requireSafeNumber(snapshot.min_signal_score, 'min_signal_score', { min: 0, max: 100 }),
    exit_quality_floor: requireSafeNumber(snapshot.exit_quality_floor, 'exit_quality_floor', { min: 0, max: 100 }),
    allowed_tokens: canonicalAllowedTokens(snapshot.allowed_tokens),
    audit_metadata: Object.freeze({
      schema: 'aether.autotrade.runtime_risk_source.v1',
      snapshot_schema: snapshot.schema,
      source: snapshot.source,
      authoritative: true,
      observed_at: observed.value,
      authenticated_follower_user_id: followerUserId,
      policy_id: policyId,
      caller_runtime_risk_authority: false,
      execution_mode: 'SHADOW',
      execution_scope: 'INTENT_ONLY',
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false,
      execution_dispatched: false
    })
  });
}
