const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalId(value, error) {
  if (typeof value !== 'string' || value !== value.trim() || !CANONICAL_UUID_RE.test(value)) throw new Error(error);
  return value;
}

function finite(value, field, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`invalid_${field}`);
  return parsed;
}

function integer(value, field, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`invalid_${field}`);
  return parsed;
}

function tokens(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('invalid_allowed_tokens');
  const normalized = value.map((token) => {
    if (typeof token !== 'string' || token !== token.trim() || token.length === 0 || token.length > 64) throw new Error('invalid_allowed_token');
    return token;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate_allowed_token');
  return normalized;
}

function trustedFacts(value, followerUserId, policyId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime_risk_facts_required');
  if (value.schema !== 'aether.autotrade.runtime_risk_facts.v1') throw new Error('invalid_runtime_risk_facts_schema');
  if (value.source !== 'BACKEND_INTERNAL' || value.authoritative !== true || value.caller_authority !== false) throw new Error('untrusted_runtime_risk_facts');
  if (value.authenticated_follower_user_id !== followerUserId || value.policy_id !== policyId) throw new Error('runtime_risk_facts_identity_mismatch');

  const capitalLimit = finite(value.capital_limit_usd, 'capital_limit_usd', { min: Number.MIN_VALUE });
  const availableCapital = finite(value.available_capital_usd, 'available_capital_usd', { min: 0, max: capitalLimit });

  return Object.freeze({
    capital_limit_usd: capitalLimit,
    available_capital_usd: availableCapital,
    daily_realized_pnl_usd: finite(value.daily_realized_pnl_usd, 'daily_realized_pnl_usd'),
    trades_today: integer(value.trades_today, 'trades_today'),
    max_trades_per_day: integer(value.max_trades_per_day, 'max_trades_per_day', { min: 1 }),
    cooldown_seconds: integer(value.cooldown_seconds, 'cooldown_seconds'),
    seconds_since_last_trade: integer(value.seconds_since_last_trade, 'seconds_since_last_trade'),
    min_signal_score: finite(value.min_signal_score, 'min_signal_score', { min: 0, max: 100 }),
    exit_quality_floor: finite(value.exit_quality_floor, 'exit_quality_floor', { min: 0, max: 100 }),
    allowed_tokens: tokens(value.allowed_tokens)
  });
}

export function createAutoTradeRuntimeRiskSnapshotWriter(db, { producer, clock = () => new Date() } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('autotrade_runtime_risk_db_required');
  if (!producer || typeof producer.getRuntimeRiskFacts !== 'function') throw new Error('trusted_runtime_risk_producer_required');
  if (typeof clock !== 'function') throw new Error('runtime_risk_clock_required');

  return Object.freeze({
    async refresh({ authenticated_follower_user_id, policy_id }) {
      const followerUserId = canonicalId(authenticated_follower_user_id, 'invalid_authenticated_follower_user_id');
      const policyId = canonicalId(policy_id, 'invalid_policy_id');
      const produced = await producer.getRuntimeRiskFacts({ authenticated_follower_user_id: followerUserId, policy_id: policyId });
      const facts = trustedFacts(produced, followerUserId, policyId);
      const observedAt = clock();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) throw new Error('invalid_runtime_risk_clock');

      const result = await db.query(`
        INSERT INTO autotrade_runtime_risk_snapshots (
          policy_id, follower_user_id, observed_at, capital_limit_usd, available_capital_usd,
          daily_realized_pnl_usd, trades_today, max_trades_per_day, cooldown_seconds,
          seconds_since_last_trade, min_signal_score, exit_quality_floor, allowed_tokens,
          authoritative, live_execution_authorized, network_submission_authorized, signer_required, updated_at
        )
        SELECT
          p.id, p.follower_user_id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
          TRUE, FALSE, FALSE, FALSE, $3
        FROM copy_policies p
        WHERE p.id = $1 AND p.follower_user_id = $2 AND p.enabled = TRUE
        ON CONFLICT (policy_id) DO UPDATE SET
          follower_user_id = EXCLUDED.follower_user_id,
          observed_at = EXCLUDED.observed_at,
          capital_limit_usd = EXCLUDED.capital_limit_usd,
          available_capital_usd = EXCLUDED.available_capital_usd,
          daily_realized_pnl_usd = EXCLUDED.daily_realized_pnl_usd,
          trades_today = EXCLUDED.trades_today,
          max_trades_per_day = EXCLUDED.max_trades_per_day,
          cooldown_seconds = EXCLUDED.cooldown_seconds,
          seconds_since_last_trade = EXCLUDED.seconds_since_last_trade,
          min_signal_score = EXCLUDED.min_signal_score,
          exit_quality_floor = EXCLUDED.exit_quality_floor,
          allowed_tokens = EXCLUDED.allowed_tokens,
          authoritative = TRUE,
          live_execution_authorized = FALSE,
          network_submission_authorized = FALSE,
          signer_required = FALSE,
          updated_at = EXCLUDED.updated_at
        RETURNING policy_id, follower_user_id, observed_at
      `, [
        policyId, followerUserId, observedAt, facts.capital_limit_usd, facts.available_capital_usd,
        facts.daily_realized_pnl_usd, facts.trades_today, facts.max_trades_per_day, facts.cooldown_seconds,
        facts.seconds_since_last_trade, facts.min_signal_score, facts.exit_quality_floor, JSON.stringify(facts.allowed_tokens)
      ]);

      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) throw new Error('runtime_risk_snapshot_refresh_rejected');
      return Object.freeze({
        schema: 'aether.autotrade.runtime_risk_refresh.v1',
        policy_id: policyId,
        authenticated_follower_user_id: followerUserId,
        observed_at: observedAt.toISOString(),
        source: 'BACKEND_INTERNAL',
        caller_authority: false,
        live_execution_authorized: false,
        network_submission_authorized: false,
        signer_required: false,
        execution_dispatched: false
      });
    }
  });
}
