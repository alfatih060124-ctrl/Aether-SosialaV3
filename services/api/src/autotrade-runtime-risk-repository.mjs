const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalId(value, error) {
  if (typeof value !== 'string' || value !== value.trim() || !CANONICAL_UUID_RE.test(value)) throw new Error(error);
  return value;
}

function numeric(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${field}`);
  return parsed;
}

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid_${field}`);
  return parsed;
}

function tokenArray(value) {
  if (!Array.isArray(value)) throw new Error('invalid_allowed_tokens');
  const tokens = value.map((token) => {
    if (typeof token !== 'string' || token.trim() === '' || token !== token.trim()) throw new Error('invalid_allowed_token');
    return token;
  });
  if (new Set(tokens).size !== tokens.length) throw new Error('duplicate_allowed_token');
  return Object.freeze(tokens);
}

export function createAutoTradeRuntimeRiskRepository(db) {
  if (!db || typeof db.query !== 'function') throw new Error('autotrade_runtime_risk_db_required');

  return Object.freeze({
    async getRuntimeRiskSnapshot({ authenticated_follower_user_id, policy_id }) {
      const followerUserId = canonicalId(authenticated_follower_user_id, 'invalid_authenticated_follower_user_id');
      const policyId = canonicalId(policy_id, 'invalid_policy_id');

      const result = await db.query(`
        SELECT
          r.policy_id,
          r.follower_user_id,
          r.observed_at,
          r.capital_limit_usd,
          r.available_capital_usd,
          r.daily_realized_pnl_usd,
          r.trades_today,
          r.max_trades_per_day,
          r.cooldown_seconds,
          r.seconds_since_last_trade,
          r.min_signal_score,
          r.exit_quality_floor,
          r.allowed_tokens,
          r.authoritative,
          r.live_execution_authorized,
          r.network_submission_authorized,
          r.signer_required
        FROM autotrade_runtime_risk_snapshots r
        JOIN copy_policies p ON p.id = r.policy_id
        WHERE r.policy_id = $1
          AND r.follower_user_id = $2
          AND p.follower_user_id = $2
          AND p.enabled = true
        LIMIT 1
      `, [policyId, followerUserId]);

      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
        throw new Error('autotrade_runtime_risk_snapshot_not_found');
      }

      const row = result.rows[0];
      if (!(row.observed_at instanceof Date) || !Number.isFinite(row.observed_at.getTime())) {
        throw new Error('invalid_runtime_risk_observed_at');
      }

      return Object.freeze({
        schema: 'aether.autotrade.runtime_risk_snapshot.v1',
        source: 'BACKEND_PERSISTED',
        authoritative: row.authoritative === true,
        authenticated_follower_user_id: row.follower_user_id,
        policy_id: row.policy_id,
        observed_at: row.observed_at.toISOString(),
        capital_limit_usd: numeric(row.capital_limit_usd, 'capital_limit_usd'),
        available_capital_usd: numeric(row.available_capital_usd, 'available_capital_usd'),
        daily_realized_pnl_usd: numeric(row.daily_realized_pnl_usd, 'daily_realized_pnl_usd'),
        trades_today: integer(row.trades_today, 'trades_today'),
        max_trades_per_day: integer(row.max_trades_per_day, 'max_trades_per_day'),
        cooldown_seconds: integer(row.cooldown_seconds, 'cooldown_seconds'),
        seconds_since_last_trade: integer(row.seconds_since_last_trade, 'seconds_since_last_trade'),
        min_signal_score: numeric(row.min_signal_score, 'min_signal_score'),
        exit_quality_floor: numeric(row.exit_quality_floor, 'exit_quality_floor'),
        allowed_tokens: tokenArray(row.allowed_tokens),
        live_execution_authorized: row.live_execution_authorized === true,
        network_submission_authorized: row.network_submission_authorized === true,
        signer_required: row.signer_required === true
      });
    }
  });
}
