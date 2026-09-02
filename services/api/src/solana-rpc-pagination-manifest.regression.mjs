import assert from 'node:assert/strict';
import {
  buildSolanaRpcPaginationManifest,
  verifySolanaRpcPaginationManifest
} from './solana-rpc-pagination-manifest.mjs';

// SYNTHETIC / TEST-ONLY fixtures. These are not production signatures, tx hashes,
// trader performance records, or source references collected from a live provider.
const wallet = '1'.repeat(32);
const sigA = '1'.repeat(64);
const sigB = `${'1'.repeat(63)}2`;
const sigC = `${'1'.repeat(63)}3`;

function fixturePages() {
  return [
    {
      request_before: null,
      rows: [
        { signature: sigA, slot: 300, blockTime: 1_700_000_300, err: null, confirmationStatus: 'finalized' },
        { signature: sigB, slot: 299, blockTime: 1_700_000_299, err: null, confirmationStatus: 'finalized' }
      ]
    },
    {
      request_before: sigB,
      rows: [
        { signature: sigC, slot: 298, blockTime: 1_700_000_298, err: null, confirmationStatus: 'finalized' }
      ]
    }
  ];
}

const record = buildSolanaRpcPaginationManifest({
  walletAddress: wallet,
  endpointLabel: 'synthetic-test-rpc',
  commitment: 'finalized',
  pageSize: 2,
  maxPages: 3,
  pages: fixturePages(),
  collectedAt: '2026-09-02T10:00:00.000Z'
});

assert.equal(record.collection_status, 'PENDING_DATA');
assert.equal(record.metrics_available, false);
assert.equal(record.trades_count, null);
assert.equal(record.total_return_bps, null);
assert.equal(record.win_rate_bps, null);
assert.equal(record.drawdown_bps, null);
assert.equal(record.reputation_score, null);
assert.equal(record.verified, false);
assert.equal(record.published, false);
assert.equal(record.live_execution_authorized, false);
assert.equal(record.source_reference, sigA);
assert.equal(record.provenance.pages_fetched, 2);
assert.equal(record.provenance.collection_complete, true);
assert.match(record.manifest_hash, /^[0-9a-f]{64}$/);
assert.equal(verifySolanaRpcPaginationManifest(record), true);

const deterministic = buildSolanaRpcPaginationManifest({
  walletAddress: wallet,
  endpointLabel: 'synthetic-test-rpc',
  commitment: 'finalized',
  pageSize: 2,
  maxPages: 3,
  pages: fixturePages(),
  collectedAt: '2026-09-02T10:00:00.000Z'
});
assert.equal(deterministic.manifest_hash, record.manifest_hash);

assert.throws(() => buildSolanaRpcPaginationManifest({
  walletAddress: wallet,
  endpointLabel: 'synthetic-test-rpc',
  commitment: 'finalized',
  pageSize: 2,
  maxPages: 3,
  pages: [fixturePages()[0], { ...fixturePages()[1], request_before: sigA }],
  collectedAt: '2026-09-02T10:00:00.000Z'
}), /rpc_pagination_cursor_mismatch/);

const tamperedHash = structuredClone(record);
tamperedHash.provenance.pages[0].rows[0].slot = 301;
assert.throws(() => verifySolanaRpcPaginationManifest(tamperedHash), /rpc_pagination_manifest_mismatch/);

const unsafeMetric = structuredClone(record);
unsafeMetric.trades_count = 3;
assert.throws(() => verifySolanaRpcPaginationManifest(unsafeMetric), /unexpected_rpc_performance_metric/);

const unsafeBoundary = structuredClone(record);
unsafeBoundary.verified = true;
assert.throws(() => verifySolanaRpcPaginationManifest(unsafeBoundary), /unsafe_rpc_evidence_boundary/);

const reservedKeyPages = fixturePages();
reservedKeyPages[0].rows[0].err = JSON.parse('{"__proto__":{"polluted":true}}');
const reservedKeyRecord = buildSolanaRpcPaginationManifest({
  walletAddress: wallet,
  endpointLabel: 'synthetic-test-rpc',
  commitment: 'finalized',
  pageSize: 2,
  maxPages: 3,
  pages: reservedKeyPages,
  collectedAt: '2026-09-02T10:00:00.000Z'
});
assert.equal(Object.hasOwn(reservedKeyRecord.provenance.pages[0].rows[0].err, '__proto__'), true);
assert.deepEqual(reservedKeyRecord.provenance.pages[0].rows[0].err.__proto__, { polluted: true });
assert.notEqual(reservedKeyRecord.manifest_hash, record.manifest_hash);
assert.equal(verifySolanaRpcPaginationManifest(reservedKeyRecord), true);
assert.equal({}.polluted, undefined);

console.log('Solana RPC pagination manifest regression: PASS');
