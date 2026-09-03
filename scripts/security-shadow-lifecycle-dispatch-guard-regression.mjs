import assert from 'node:assert/strict';
import { createExecutionRequestRepository } from '../services/api/src/repositories/execution-requests.mjs';

const ID = '11111111-1111-4111-8111-111111111111';

let row = {
  execution_request_id: ID,
  status: 'SIMULATED',
  mode: 'SHADOW'
};

const pool = {
  async query(sql, values = []) {
    if (sql.includes('UPDATE execution_requests') && sql.includes('status=$3')) {
      const [id, expectedState, nextState] = values;
      if (row.execution_request_id === id && row.status === expectedState) {
        row = { ...row, status: nextState };
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    }
    if (sql.includes('SELECT status FROM execution_requests')) {
      return { rows: [{ status: row.status }] };
    }
    return { rows: [] };
  }
};

const repo = createExecutionRequestRepository(pool);

// A SHADOW request must never be persisted into an execution-authorized state.
// The lifecycle repository is itself a trust boundary: downstream consumers may
// interpret AUTHORIZED/DISPATCHED as evidence that execution authorization occurred.
await assert.rejects(
  repo.transitionCanonicalState(ID, 'SIMULATED', 'AUTHORIZED'),
  /shadow|execution_mode|not_authorized|invalid_execution_transition/i
);

assert.equal(row.mode, 'SHADOW');
assert.equal(row.status, 'SIMULATED');

console.log('SHADOW lifecycle dispatch guard regression: PASS');
