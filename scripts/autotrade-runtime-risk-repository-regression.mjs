import assert from 'node:assert/strict';
import { createAutoTradeRuntimeRiskRepository } from '../services/api/src/autotrade-runtime-risk-repository.mjs';

const follower = '22222222-2222-4222-8222-222222222222';
const policy = '11111111-1111-4111-8111-111111111111';
const observedAt = new Date('2026-09-03T03:59:30.000Z');
const baseRow = Object.freeze({
  policy_id: policy,
  follower_user_id: follower,
  observed_at: observedAt,
  capital_limit_usd: '1000.00',
  available_capital_usd: '800.00',
  daily_realized_pnl_usd: '-10.00',
  trades_today: 2,
  max_trades_per_day: 20,
  cooldown_seconds: 60,
  seconds_since_last_trade: 120,
  min_signal_score: '70.00',
  exit_quality_floor: '50.00',
  allowed_tokens: ['SOL', 'USDC'],
  authoritative: true,
  live_execution_authorized: false,
  network_submission_authorized: false,
  signer_required: false
});

let calls = 0;
const db = {
  async query(sql, params) {
    calls += 1;
    assert.match(sql, /JOIN copy_policies p ON p\.id = r\.policy_id/);
    assert.match(sql, /p\.follower_user_id = \$2/);
    assert.match(sql, /p\.enabled = true/);
    assert.deepEqual(params, [policy, follower]);
    return { rows: [{ ...baseRow }] };
  }
};

const repository = createAutoTradeRuntimeRiskRepository(db);
const snapshot = await repository.getRuntimeRiskSnapshot({
  authenticated_follower_user_id: follower,
  policy_id: policy,
  assessment: { signal: 'BUY' },
  position: { token: 'SOL' }
});

assert.equal(calls, 1);
assert.equal(snapshot.schema, 'aether.autotrade.runtime_risk_snapshot.v1');
assert.equal(snapshot.source, 'BACKEND_PERSISTED');
assert.equal(snapshot.authoritative, true);
assert.equal(snapshot.authenticated_follower_user_id, follower);
assert.equal(snapshot.policy_id, policy);
assert.equal(snapshot.observed_at, observedAt.toISOString());
assert.equal(snapshot.capital_limit_usd, 1000);
assert.equal(snapshot.available_capital_usd, 800);
assert.deepEqual(snapshot.allowed_tokens, ['SOL', 'USDC']);
assert.equal(snapshot.live_execution_authorized, false);
assert.equal(snapshot.network_submission_authorized, false);
assert.equal(snapshot.signer_required, false);

let malformedCalls = 0;
const malformedRepo = createAutoTradeRuntimeRiskRepository({ async query() { malformedCalls += 1; return { rows: [] }; } });
await assert.rejects(
  () => malformedRepo.getRuntimeRiskSnapshot({ authenticated_follower_user_id: follower, policy_id: 'not-a-uuid' }),
  /invalid_policy_id/
);
assert.equal(malformedCalls, 0);

const missingRepo = createAutoTradeRuntimeRiskRepository({ async query() { return { rows: [] }; } });
await assert.rejects(
  () => missingRepo.getRuntimeRiskSnapshot({ authenticated_follower_user_id: follower, policy_id: policy }),
  /autotrade_runtime_risk_snapshot_not_found/
);

const invalidTokenRepo = createAutoTradeRuntimeRiskRepository({ async query() { return { rows: [{ ...baseRow, allowed_tokens: ['SOL', 'SOL'] }] }; } });
await assert.rejects(
  () => invalidTokenRepo.getRuntimeRiskSnapshot({ authenticated_follower_user_id: follower, policy_id: policy }),
  /duplicate_allowed_token/
);

const migrationText = await (await import('node:fs/promises')).readFile(new URL('../database/migrations/002_autotrade_runtime_risk_snapshots.sql', import.meta.url), 'utf8');
for (const invariant of [
  'authoritative = true',
  'live_execution_authorized = false',
  'network_submission_authorized = false',
  'signer_required = false'
]) assert.ok(migrationText.includes(invariant), `missing DB fail-closed invariant: ${invariant}`);

console.log('Auto Trade Runtime Risk Repository Regression: PASS');
