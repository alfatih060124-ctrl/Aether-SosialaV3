import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMarketShadowRuntimeState } from '../services/api/src/market-shadow-runtime.mjs';

const state = getMarketShadowRuntimeState();
assert.equal(state.status, 'IDLE');
assert.equal(state.mode, 'SHADOW');
assert.equal(state.min_expected_net_edge_bps, 20);
assert.equal(state.execution_dispatched, false);
assert.equal(state.transaction_signed, false);
assert.equal(state.network_submission_authorized, false);
assert.equal(state.live_execution_authorized, false);

const route = fs.readFileSync('services/api/src/member-autotrade-route.mjs', 'utf8');
assert.match(route, /\/api\/account\/auto-strategy\/market-shadow/);
assert.match(route, /real_market_shadow_only/);
assert.match(route, /startMarketShadowRuntimeScan/);

const edge = fs.readFileSync('api/market-shadow.mjs', 'utf8');
assert.match(edge, /api\.aether\.boats\/api\/account\/auto-strategy\/market-shadow/);
assert.match(edge, /aether_session/);

const html = fs.readFileSync('public/autotrade-demo.html', 'utf8');
assert.match(html, /Real-Market Shadow Runtime/);
assert.match(html, /Run One Scan/);
assert.match(html, /Start Auto Trade/);
assert.match(html, /Stop Auto Trade/);
assert.doesNotMatch(html, /Training scenario/);
assert.doesNotMatch(html, /Start Auto Demo/);

const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
assert.match(dockerfile, /COPY scripts \.\/scripts/);

const compose = fs.readFileSync('docker-compose.yml', 'utf8');
assert.match(compose, /SOLANA_RPC_URL: \$\{SOLANA_RPC_URL:\?set SOLANA_RPC_URL\}/);
assert.match(compose, /JUPITER_API_KEY: \$\{JUPITER_API_KEY:\?set JUPITER_API_KEY\}/);
assert.match(compose, /EXECUTION_MODE: SHADOW/);
assert.match(compose, /LIVE_ENABLED: "false"/);

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
assert(vercel.routes.some(item => item.src === '/api/account/auto-strategy/market-shadow/?' && item.dest === '/api/market-shadow.mjs'));

console.log('market-shadow-web-regression: ok');
