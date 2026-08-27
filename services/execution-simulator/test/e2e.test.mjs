import assert from 'node:assert/strict';
import { runE2E } from '../src/e2e-harness.mjs';

const event = {
  event_id: 'e2e-001', chain: 'solana', dex: 'jupiter', trader_wallet: 'wallet-1',
  token_in: 'TOKEN_A', token_out: 'TOKEN_B', amount_in_raw: '1000', amount_out_raw: '990',
  confidence: 0.99, observed_at: new Date().toISOString()
};
const policy = { max_copy_amount_usd: 100, max_position_amount_usd: 100 };
const trader = { reputation_score: 100, drawdown_bps: 100 };
const executionRequest = { id: 'req-001', idempotency_key: 'idem-001', requested_amount_usd: 25 };

const result = runE2E({ event, trader, policy, executionRequest });
assert.equal(result.status, 'SIMULATED');
assert.equal(result.risk.decision, 'APPROVED');
assert.equal(result.receipt.live_submission, false);
assert.equal(result.receipt.mode, 'SIMULATION');
console.log('E2E simulation gate: PASS');
