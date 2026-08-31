import assert from 'node:assert/strict';
import { createExecutionRequestRepository } from '../services/api/src/repositories/execution-requests.mjs';

const VALID_FOLLOWER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_TRADER_ID = '22222222-2222-4222-8222-222222222222';
const VALID_EXECUTION_ID = '33333333-3333-4333-8333-333333333333';

const calls = [];
const pool = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (String(sql).includes('INSERT INTO execution_requests')) {
      return {
        rows: [{
          execution_request_id: params[0],
          idempotency_key: params[1],
          event_id: params[2],
          follower_user_id: params[3],
          trader_id: params[4],
          requested_amount_usd: params[5],
          mode: params[6],
          status: params[7]
        }]
      };
    }
    return { rows: [] };
  }
};

const repo = createExecutionRequestRepository(pool);

const assertRejectedBeforeQuery = async (fn, expectedMessage) => {
  const before = calls.length;
  await assert.rejects(fn, error => error?.message === expectedMessage);
  assert.equal(calls.length, before, `${expectedMessage} must fail before reaching PostgreSQL`);
};

await assertRejectedBeforeQuery(
  () => repo.create({
    idempotency_key: 'bad-follower',
    event_id: 'event-1',
    follower_user_id: 'not-a-uuid',
    trader_id: VALID_TRADER_ID,
    requested_amount_usd: 10
  }),
  'invalid_follower_user_id_uuid'
);

await assertRejectedBeforeQuery(
  () => repo.create({
    idempotency_key: 'bad-trader',
    event_id: 'event-2',
    follower_user_id: VALID_FOLLOWER_ID,
    trader_id: 'not-a-uuid',
    requested_amount_usd: 10
  }),
  'invalid_trader_id_uuid'
);

await assertRejectedBeforeQuery(
  () => repo.create({
    execution_request_id: 'bad-id',
    idempotency_key: 'bad-execution-id',
    event_id: 'event-3',
    follower_user_id: VALID_FOLLOWER_ID,
    trader_id: VALID_TRADER_ID,
    requested_amount_usd: 10
  }),
  'invalid_execution_request_id_uuid'
);

await assertRejectedBeforeQuery(
  () => repo.getById('bad-id'),
  'invalid_execution_request_id_uuid'
);

await assertRejectedBeforeQuery(
  () => repo.updateStatus('bad-id', 'SIMULATED'),
  'invalid_execution_request_id_uuid'
);

const created = await repo.create({
  execution_request_id: VALID_EXECUTION_ID,
  idempotency_key: 'valid-request',
  event_id: 'shadow_event_1',
  follower_user_id: VALID_FOLLOWER_ID,
  trader_id: VALID_TRADER_ID,
  requested_amount_usd: 25,
  mode: 'SHADOW',
  status: 'SIMULATED'
});

assert.equal(created.execution_request_id, VALID_EXECUTION_ID);
assert.equal(created.mode, 'SHADOW');
assert.equal(created.status, 'SIMULATED');
assert.equal(calls.length, 1, 'Only the valid request may reach PostgreSQL');

console.log('Execution UUID fail-closed regression: PASS');
