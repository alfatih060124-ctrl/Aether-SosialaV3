import assert from 'node:assert/strict';
import { collectSolanaRpcEvidence } from '../services/api/src/solana-evidence-source.mjs';
import { createAutomaticEvidenceService } from '../services/api/src/automatic-evidence-service.mjs';

// Synthetic/test-only fixture. This wallet is not trader-performance evidence.
const wallet = '11111111111111111111111111111111';

async function expectConfigRejects(config, pattern) {
  let rpcCalls = 0;
  await assert.rejects(
    collectSolanaRpcEvidence({
      walletAddress: wallet,
      rpcCall: async () => {
        rpcCalls += 1;
        return [];
      },
      ...config
    }),
    pattern
  );
  assert.equal(rpcCalls, 0, 'invalid collector config must fail before any RPC request');
}

await expectConfigRejects({ limit: 0 }, /invalid_rpc_page_size/);
await expectConfigRejects({ limit: 1001 }, /invalid_rpc_page_size/);
await expectConfigRejects({ limit: 1.5 }, /invalid_rpc_page_size/);
await expectConfigRejects({ limit: '100' }, /invalid_rpc_page_size/);
await expectConfigRejects({ maxPages: 0 }, /invalid_rpc_max_pages/);
await expectConfigRejects({ maxPages: 21 }, /invalid_rpc_max_pages/);
await expectConfigRejects({ maxPages: 1.5 }, /invalid_rpc_max_pages/);
await expectConfigRejects({ maxPages: '3' }, /invalid_rpc_max_pages/);

async function expectServiceConfigRejects(input, pattern) {
  let databaseCalls = 0;
  let fetchCalls = 0;
  const pool = {
    async query() {
      databaseCalls += 1;
      throw new Error('database_must_not_be_reached_for_invalid_config');
    }
  };
  const service = createAutomaticEvidenceService(pool, {
    rpcUrl: 'https://rpc.invalid.test',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('rpc_must_not_be_reached_for_invalid_config');
    }
  });

  await assert.rejects(service.collectSolana('10000000-0000-0000-0000-000000000001', input), pattern);
  assert.equal(databaseCalls, 0, 'invalid service config must fail before trader/database lookup');
  assert.equal(fetchCalls, 0, 'invalid service config must fail before any RPC request');
}

await expectServiceConfigRejects({ limit: 0 }, /invalid_rpc_page_size/);
await expectServiceConfigRejects({ limit: 1001 }, /invalid_rpc_page_size/);
await expectServiceConfigRejects({ limit: '100' }, /invalid_rpc_page_size/);
await expectServiceConfigRejects({ max_pages: 0 }, /invalid_rpc_max_pages/);
await expectServiceConfigRejects({ max_pages: 21 }, /invalid_rpc_max_pages/);
await expectServiceConfigRejects({ max_pages: '3' }, /invalid_rpc_max_pages/);

let validCalls = 0;
const result = await collectSolanaRpcEvidence({
  walletAddress: wallet,
  rpcCall: async (method, params) => {
    validCalls += 1;
    assert.equal(method, 'getSignaturesForAddress');
    assert.deepEqual(params[1], { limit: 100, commitment: 'finalized' });
    return [];
  }
});

assert.equal(validCalls, 1);
assert.equal(result.verification_status, 'PENDING_DATA');
assert.equal(result.verified, false);
assert.equal(result.published, false);
assert.equal(result.source_reference, null);
assert.equal(result.provenance.page_size, 100);
assert.equal(result.provenance.max_pages, 3);
assert.equal(result.provenance.collection_complete, true);
assert.equal('trades_count' in result, false);
assert.equal('total_return_bps' in result, false);
assert.equal('win_rate_bps' in result, false);
assert.equal('drawdown_bps' in result, false);
assert.equal('reputation_score' in result, false);

console.log('Solana collector config regression passed');
