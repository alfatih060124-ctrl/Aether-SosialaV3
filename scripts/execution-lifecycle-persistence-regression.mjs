import assert from 'node:assert/strict';
import { CANONICAL_EXECUTION_STATES, createExecutionRequestRepository } from '../services/api/src/repositories/execution-requests.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const FOLLOWER = '22222222-2222-4222-8222-222222222222';
const TRADER = '33333333-3333-4333-8333-333333333333';

assert.deepEqual(CANONICAL_EXECUTION_STATES, [
  'CREATED','RISK_CHECKED','QUOTED','SIMULATED','AUTHORIZED','DISPATCHED','CONFIRMED','RECONCILED','REJECTED','FAILED'
]);

const calls = [];
const pool = {
  async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('INSERT INTO execution_requests')) {
      return { rows: [{ execution_request_id: values[0], status: values[7], mode: values[6] }] };
    }
    if (sql.includes('UPDATE execution_requests') && sql.includes('status=$3')) {
      return { rows: [{ execution_request_id: values[0], status: values[2] }] };
    }
    if (sql.includes('SELECT status FROM execution_requests')) return { rows: [{ status: 'CREATED' }] };
    return { rows: [] };
  }
};

const repo = createExecutionRequestRepository(pool);
const created = await repo.create({
  execution_request_id: ID,
  idempotency_key: 'a'.repeat(64),
  event_id: 'evt-1',
  follower_user_id: FOLLOWER,
  trader_id: TRADER,
  requested_amount_usd: 25,
  mode: 'SHADOW',
  status: 'CREATED'
});
assert.equal(created.status, 'CREATED');
assert.equal(created.mode, 'SHADOW');

const transitioned = await repo.transitionCanonicalState(ID, 'CREATED', 'RISK_CHECKED');
assert.equal(transitioned.status, 'RISK_CHECKED');
assert.match(calls.at(-1).sql, /WHERE execution_request_id=\$1 AND status=\$2/);
assert.deepEqual(calls.at(-1).values, [ID, 'CREATED', 'RISK_CHECKED']);

await assert.rejects(
  repo.transitionCanonicalState(ID, 'CREATED', 'CONFIRMED'),
  /invalid_execution_transition/
);

await assert.rejects(
  repo.transitionCanonicalState(ID, 'PENDING', 'CREATED'),
  /invalid_canonical_execution_state/
);

const conflictPool = {
  async query(sql) {
    if (sql.includes('UPDATE execution_requests')) return { rows: [] };
    if (sql.includes('SELECT status FROM execution_requests')) return { rows: [{ status: 'QUOTED' }] };
    return { rows: [] };
  }
};
const conflictRepo = createExecutionRequestRepository(conflictPool);
await assert.rejects(
  conflictRepo.transitionCanonicalState(ID, 'RISK_CHECKED', 'QUOTED'),
  /execution_state_conflict/
);

const missingPool = {
  async query() { return { rows: [] }; }
};
const missingRepo = createExecutionRequestRepository(missingPool);
await assert.rejects(
  missingRepo.transitionCanonicalState(ID, 'CREATED', 'RISK_CHECKED'),
  /execution_request_not_found/
);

// SHADOW posture: lifecycle persistence changes state only. It does not create a signer,
// authorize LIVE, or submit any transaction/network request.
const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../services/api/src/repositories/execution-requests.mjs', import.meta.url), 'utf8'));
assert(!source.includes('privateKey'));
assert(!source.includes('secretKey'));
assert(!source.includes('sendTransaction'));
assert(!source.includes('LIVE_ENABLED=true'));

console.log('execution lifecycle persistence regression: ok');
