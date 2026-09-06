import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createMemberAutoTradeRealMarketRuntime, MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME } from '../services/api/src/member-autotrade-real-market-runtime.mjs';
import { createConfiguredMemberAutoTradeRealMarketRuntime, MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY } from '../services/api/src/member-autotrade-real-market-runtime-factory.mjs';
import { createMemberAutoTradeShadowScheduler, MEMBER_AUTOTRADE_SHADOW_SCHEDULER } from '../services/api/src/member-autotrade-shadow-scheduler.mjs';
import { createOrcaRaydiumShadowNetworkFeeSource, ORCA_RAYDIUM_SHADOW_NETWORK_FEE_SOURCE } from '../services/api/src/orca-raydium-shadow-network-fee-source.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const runtime = createMemberAutoTradeRealMarketRuntime({
  discoveryService: { async getDiscovery() { return { items: [], freshness: { stale: false }, source: 'TEST' }; } },
  qualificationRuntime: { async scanAndQualifyPair() { throw new Error('should_not_scan'); } },
  quoteMint: USDC,
  maxCandidates: 5
});
const noCandidate = await runtime.runNextOpportunity({ demo_account: { cash_balance_usdc: 100 } });
assert.equal(noCandidate.selected, null);
assert.equal(noCandidate.candidate_count, 0);
assert.equal(noCandidate.mode, 'SHADOW');
assert.equal(noCandidate.live_execution_authorized, false);

assert.throws(() => createConfiguredMemberAutoTradeRealMarketRuntime({ env: { EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false', SOLANA_RPC_URL: '' } }), /solana_rpc_unconfigured/);
assert.throws(() => createConfiguredMemberAutoTradeRealMarketRuntime({ env: { EXECUTION_MODE: 'LIVE', LIVE_ENABLED: 'false', SOLANA_RPC_URL: 'https:\/\/rpc.invalid' } }), /autotrade_shadow_execution_mode_required/);
assert.throws(() => createConfiguredMemberAutoTradeRealMarketRuntime({ env: { EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'true', SOLANA_RPC_URL: 'https:\/\/rpc.invalid' } }), /autotrade_shadow_live_must_be_off/);

let calls = 0;
let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
const scheduler = createMemberAutoTradeShadowScheduler({
  pool: {},
  runtime: { async runNextOpportunity() {} },
  intervalMs: 5000,
  runBatch: async () => { calls += 1; if (calls === 1) await firstGate; return { processed: 0, mode: 'SHADOW' }; }
});
const first = scheduler.runOnce();
const overlap = await scheduler.runOnce();
assert.equal(overlap.status, 'SKIPPED_OVERLAP');
releaseFirst();
await first;
assert.equal(calls, 1);
assert.equal(scheduler.status().scheduler_started, false);
assert.equal(scheduler.start(), true);
assert.equal(scheduler.start(), false);
assert.equal(scheduler.status().scheduler_started, true);
assert.equal(scheduler.stop(), true);
assert.equal(scheduler.stop(), false);

assert.throws(() => createOrcaRaydiumShadowNetworkFeeSource({ rpcUrl: 'http://rpc.invalid', scannerRuntime: { scanPair() {} } }), /shadow_network_fee_rpc_https_required/);
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME.min_expected_net_edge_bps, 20);
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.transaction_count_per_day_capped, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_SCHEDULER.overlap_allowed, false);
assert.equal(ORCA_RAYDIUM_SHADOW_NETWORK_FEE_SOURCE.live_execution_authorized, false);

const primary = await fs.readFile(new URL('../services/api/src/server-primary.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await fs.readFile(new URL('../services/api/package.json', import.meta.url), 'utf8'));
const envExample = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
const compose = await fs.readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
assert.equal(packageJson.scripts.start, 'node src/server-primary.mjs');
assert.match(primary, /AUTOTRADE_SHADOW_SCHEDULER_ENABLED/);
assert.match(primary, /executionMode !== 'SHADOW' \|\| liveEnabled/);
assert.match(primary, /createConfiguredMemberAutoTradeRealMarketRuntime/);
assert.match(primary, /createMemberAutoTradeShadowScheduler/);
assert.match(envExample, /AUTOTRADE_SHADOW_SCHEDULER_ENABLED=false/);
assert.match(envExample, /AUTOTRADE_SHADOW_NOTIONAL_USDC=10/);
assert.match(compose, /AUTOTRADE_SHADOW_SCHEDULER_ENABLED: \$\{AUTOTRADE_SHADOW_SCHEDULER_ENABLED:-false\}/);
assert.match(compose, /EXECUTION_MODE: SHADOW/);
assert.match(compose, /LIVE_ENABLED: "false"/);

for (const path of [
  '../services/api/src/member-autotrade-real-market-runtime.mjs',
  '../services/api/src/member-autotrade-real-market-runtime-factory.mjs',
  '../services/api/src/member-autotrade-shadow-scheduler.mjs',
  '../services/api/src/orca-raydium-shadow-network-fee-source.mjs',
  '../services/api/src/server-primary.mjs'
]) {
  const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|signTransaction|signAllTransactions/i);
}

console.log('Member Auto Trade SHADOW runtime composition regression: PASS');
