import assert from 'node:assert/strict';
import { createExecutionRequestRepository } from '../services/api/src/repositories/execution-requests.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const FOLLOWER = '22222222-2222-4222-8222-222222222222';
const TRADER = '33333333-3333-4333-8333-333333333333';

let row = { execution_request_id: ID, status: 'SIMULATED', mode: 'SHADOW' };
const calls = [];
const pool = {
  async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('INSERT INTO execution_requests')) {
      return { rows: [{ execution_request_id: values[0], status: values[7], mode: values[6] }] };
    }
    if (sql.includes('UPDATE execution_requests')) {
      const next = values.at(-1);
      if (row.execution_request_id === values[0] && !(row.mode === 'SHADOW' && ['AUTHORIZED','DISPATCHED','CONFIRMED','RECONCILED'].includes(next))) {
        row = { ...row, status: next };
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    }
    if (sql.includes('SELECT status,mode FROM execution_requests')) return { rows: [{ ...row }] };
    return { rows: [] };
  }
};

const repo = createExecutionRequestRepository(pool);

await assert.rejects(
  repo.create({
    execution_request_id: ID,
    idempotency_key: 'a'.repeat(64),
    event_id: 'evt-shadow-authorized',
    follower_user_id: FOLLOWER,
    trader_id: TRADER,
    requested_amount_usd: 10,
    mode: 'SHADOW',
    status: 'AUTHORIZED'
  }),
  /shadow_execution_state_not_authorized/
);
assert.equal(calls.length, 0, 'forbidden SHADOW create must fail before DB access');

await assert.rejects(
  repo.transitionCanonicalState(ID, 'SIMULATED', 'AUTHORIZED'),
  /shadow_execution_state_not_authorized/
);
assert.equal(row.status, 'SIMULATED');
assert.match(calls.at(-2).sql, /mode='SHADOW'/);

await assert.rejects(
  repo.updateStatus(ID, 'DISPATCHED'),
  /shadow_execution_state_not_authorized/
);
assert.equal(row.status, 'SIMULATED');

const terminal = await repo.transitionCanonicalState(ID, 'SIMULATED', 'REJECTED');
assert.equal(terminal.status, 'REJECTED');
assert.equal(terminal.mode, 'SHADOW');

const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../services/api/src/repositories/execution-requests.mjs', import.meta.url), 'utf8'));
assert(!source.includes('sendTransaction'));
assert(!source.includes('privateKey'));
assert(!source.includes('secretKey'));
assert(!source.includes('LIVE_ENABLED=true'));

console.log('shadow lifecycle persistence guard regression: ok');
