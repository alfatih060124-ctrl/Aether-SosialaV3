import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCoreRepositories } from '../services/api/src/repositories/core.mjs';

const goodTrader = Object.freeze({
  trader_id: 'trader-1',
  owner_user_id: 'other-user',
  status: 'ACTIVE',
  verified: true,
  mode: 'SHADOW',
  onboarding_status: 'APPROVED',
  verification_status: 'VERIFIED',
  published: true
});

function makePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM traders WHERE trader_id=$1')) return { rows: [goodTrader] };
      if (sql.includes('FROM copy_policies WHERE follower_user_id=$1 AND trader_id=$2')) return { rows: [] };
      if (sql.includes('INSERT INTO copy_policies')) {
        return {
          rows: [{
            policy_id: params[0], follower_user_id: params[1], trader_id: params[2], enabled: true,
            max_copy_amount_usd: params[3], max_position_amount_usd: params[4], mode: 'SHADOW', status: 'ACTIVE',
            allocation_bps: params[5], max_slippage_bps: params[6], max_daily_loss_bps: params[7], stop_drawdown_bps: params[8],
            live_execution_authorized: false, policy_type: params[9], policy_value: params[10], consent_version: params[11], consented_at: params[12]
          }]
        };
      }
      throw new Error(`unexpected_query:${sql}`);
    }
  };
}

const baseInput = Object.freeze({
  trader_id: 'trader-1',
  consent_accepted: true,
  consent_version: 'aether.copy_mandate.consent.v1',
  policy_type: 'FIXED_USD',
  policy_value: 25,
  max_copy_amount_usd: 25,
  max_position_amount_usd: 100,
  allocation_bps: 1000,
  max_slippage_bps: 100,
  max_daily_loss_bps: 300,
  stop_drawdown_bps: 1500
});

{
  const pool = makePool();
  await assert.rejects(createCoreRepositories(pool).copyPolicies.createForFollower('follower-1', { ...baseInput, consent_accepted: false }), /copy_mandate_consent_required/);
  assert.equal(pool.calls.length, 0);
}

{
  const pool = makePool();
  await assert.rejects(createCoreRepositories(pool).copyPolicies.createForFollower('follower-1', { ...baseInput, consent_version: 'legacy' }), /invalid_consent_version/);
  assert.equal(pool.calls.length, 0);
}

{
  const pool = makePool();
  const mandate = await createCoreRepositories(pool).copyPolicies.createForFollower('follower-1', { ...baseInput, consented_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(mandate.mode, 'SHADOW');
  assert.equal(mandate.live_execution_authorized, false);
  assert.equal(mandate.policy_type, 'FIXED_USD');
  assert.equal(Number(mandate.policy_value), 25);
  assert.equal(mandate.consent_version, 'aether.copy_mandate.consent.v1');
  assert.notEqual(mandate.consented_at, '2099-01-01T00:00:00.000Z');
  assert.equal(new Date(mandate.consented_at).toISOString(), mandate.consented_at);
  const insert = pool.calls.find(call => call.sql.includes('INSERT INTO copy_policies'));
  for (const column of ['policy_type', 'policy_value', 'consent_version', 'consented_at']) assert.match(insert.sql, new RegExp(column));
}

const ui = fs.readFileSync(new URL('../public/account-auto-strategy.js', import.meta.url), 'utf8');
for (const invariant of [
  'I understand this creates a SHADOW Copy Mandate only.',
  "consent_version: 'aether.copy_mandate.consent.v1'",
  "policy_type: 'FIXED_USD'",
  'policy_value: maxCopy',
  'does not sign a transaction',
  'does not sign a transaction, move funds, or enable LIVE execution'
]) assert.ok(ui.includes(invariant), `missing UI consent invariant: ${invariant}`);

assert.match(ui, /createMandateButton\.addEventListener\('click',[\s\S]*true\);/);
assert.match(ui, /event\.stopImmediatePropagation\(\)/);

console.log('copy mandate consent integration regression: ok');
