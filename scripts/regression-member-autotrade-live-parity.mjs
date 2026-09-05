import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLiveArbitrageIntent, getLiveArbitrageGate } from '../services/api/src/live-arbitrage-execution.mjs';

const result = {
  strategy: 'TWO_LEG_ARBITRAGE',
  market_data_mode: 'REAL_MARKET_SHADOW',
  training_fixture: false,
  observed_at: '2026-09-05T02:00:00.000Z',
  assessment: { verdict: 'QUALIFIED', token_mint: 'TOKEN', snapshot: { token_mint: 'TOKEN', quote_mint: 'USDC' } },
  decision: { action: 'ARBITRAGE_SETTLE' },
  arbitrage: {
    notional_usdc: 100,
    net_edge_bps: 35,
    cost_breakdown: { costs_verified: true },
    buy_route: { dex_id: 'orca', pool_address: 'orca-pool', quote_verified: true },
    sell_route: { dex_id: 'raydium', pool_address: 'ray-pool', quote_verified: true }
  }
};

const closed = getLiveArbitrageGate({ EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false', FIXTURE_GATE_PASSED: 'false', OPERATOR_APPROVED: 'false', REAL_MONEY_APPROVED: 'false' });
assert.equal(closed.ready, false);
assert.equal(closed.fail_closed, true);
assert.deepEqual([...closed.allowed_dex], ['ORCA', 'RAYDIUM']);
assert.throws(() => buildLiveArbitrageIntent({ result, member: { user_id: 'u1', primary_wallet: 'wallet1' }, env: { EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false' } }), /live_execution_gate_closed/);

const liveEnv = { EXECUTION_MODE: 'LIVE', LIVE_ENABLED: 'true', FIXTURE_GATE_PASSED: 'true', OPERATOR_APPROVED: 'true', REAL_MONEY_APPROVED: 'true' };
const intent = buildLiveArbitrageIntent({ result, member: { user_id: 'u1', primary_wallet: 'wallet1' }, env: liveEnv });
assert.equal(intent.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(intent.buy_route.dex_id, 'orca');
assert.equal(intent.sell_route.dex_id, 'raydium');
assert.equal(intent.requires_wallet_signature, true);
assert.equal(intent.funds_moved, false);

const sameDex = structuredClone(result);
sameDex.arbitrage.sell_route.dex_id = 'orca';
assert.throws(() => buildLiveArbitrageIntent({ result: sameDex, member: { user_id: 'u1', primary_wallet: 'wallet1' }, env: liveEnv }), /live_cross_dex_required/);
const otherDex = structuredClone(result);
otherDex.arbitrage.sell_route.dex_id = 'meteora';
assert.throws(() => buildLiveArbitrageIntent({ result: otherDex, member: { user_id: 'u1', primary_wallet: 'wallet1' }, env: liveEnv }), /live_dex_not_allowed/);

const shell = fs.readFileSync(new URL('../public/account-member-autotrade.js', import.meta.url), 'utf8');
assert.match(shell, /\/api\/auth\/session/);
assert.match(shell, /\/api\/auth\/logout/);
assert.match(shell, /\/autotrade-demo/);
assert.match(shell, /location\.replace\('\/'\)/);

const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.equal(vercel.git?.deploymentEnabled, false);
const accountLoader = vercel.routes.find(route => route.src === '/account-auto-strategy.js');
assert.equal(accountLoader?.dest, '/public/account-member-autotrade.js');
const memberRedirect = vercel.routes.find(route => route.src === '/' && route.status === 307);
assert.equal(memberRedirect?.has?.[0]?.type, 'cookie');
assert.equal(memberRedirect?.has?.[0]?.key, 'aether_session');
assert.equal(memberRedirect?.headers?.Location, '/account');

console.log('member auto trade + live parity regression: ok');
