import assert from 'node:assert/strict';
import fs from 'node:fs';

const member = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const authorityUi = fs.readFileSync(new URL('../public/member-authority-ui.js', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../services/api/src/member-autotrade-route.mjs', import.meta.url), 'utf8');
const stateRoute = fs.readFileSync(new URL('../services/api/src/member-autotrade-state-route.mjs', import.meta.url), 'utf8');
const stateProxy = fs.readFileSync(new URL('../api/member-autotrade-state.mjs', import.meta.url), 'utf8');
const proxy = fs.readFileSync(new URL('../api/member-performance.mjs', import.meta.url), 'utf8');

for (const label of ['Dashboard','Auto Trade','Performance','Subscription','Account']) {
  assert.match(member, new RegExp(`>${label}<`));
}
assert.doesNotMatch(member, />Copy Trading</);
assert.doesNotMatch(member, />Trader Marketplace</);
assert.doesNotMatch(member, />Market Discovery</);
assert.doesNotMatch(member, /href="\/autotrade-demo"/);
assert.match(member, /TWO_LEG_ARBITRAGE/);
assert.match(member, /ORCA ↔ Raydium/);
assert.match(member, /0\.20%/);
assert.match(member, /id="start"/);
assert.match(member, /old directional training simulator is intentionally not exposed here/);
assert.match(member, /Prices are server-authoritative and versioned/);
assert.match(member, /\/api\/account\/subscription/);
assert.match(member, /\/api\/account\/subscription\/quote/);
assert.match(member, /\/api\/account\/subscription\/verify/);
assert.match(member, /final_price_usdc_atomic/);
assert.match(member, /base_price_usdc_atomic/);
assert.match(member, /discount_bps/);
assert.match(member, /payment_recipient_wallet/);
assert.match(member, /payment_mint/);
assert.match(member, /finalized Solana signature/i);
assert.match(member, /AETHER never submits the payment transaction/);
assert.doesNotMatch(member, /35\.00 USDC|89\.25 USDC|157\.50 USDC|273\.00 USDC/);
assert.match(member, /LIVE Authorization/);
assert.match(member, />OFF</);

// Member Auto Trade controls are server-authoritative. Markup starts disabled/fail-closed,
// then the authenticated state endpoint decides whether Start or Stop becomes available.
assert.match(authorityUi, /AUTOTRADE_BASE='\/api\/account\/autotrade'/);
assert.match(authorityUi, /request\(`\$\{AUTOTRADE_BASE\}\/state`\)/);
assert.match(authorityUi, /request\(`\$\{AUTOTRADE_BASE\}\/\$\{action\}`/);
assert.match(authorityUi, /start\.addEventListener\('click',\(\)=>commandAutoTrade\('start'\)\)/);
assert.match(authorityUi, /stop\.addEventListener\('click',\(\)=>commandAutoTrade\('stop'\)\)/);
assert.match(authorityUi, /start\.disabled=!\['STOPPED','PAUSED'\]\.includes\(state\)/);
assert.match(authorityUi, /stop\.disabled=state==='STOPPED'/);
assert.match(authorityUi, /if\(start\)start\.disabled=true;if\(stop\)stop\.disabled=true/);
assert.doesNotMatch(authorityUi, /BUY|HOLD|stop.?loss|trailing.?stop/i);

assert.match(stateRoute, /MEMBER_AUTOTRADE_STATE_ROUTE = '\/api\/account\/autotrade\/state'/);
assert.match(stateRoute, /MEMBER_AUTOTRADE_START_ROUTE = '\/api\/account\/autotrade\/start'/);
assert.match(stateRoute, /MEMBER_AUTOTRADE_STOP_ROUTE = '\/api\/account\/autotrade\/stop'/);
assert.match(stateRoute, /authentication: 'WALLET_SESSION'/);
assert.match(stateRoute, /live_execution_authorized: false/);
assert.match(stateProxy, /PRIMARY_API_ORIGIN = 'https:\/\/api\.aether\.boats'/);
assert.match(stateProxy, /SESSION_COOKIE = 'aether_session'/);
assert.match(stateProxy, /state: '\/api\/account\/autotrade\/state'/);
assert.match(stateProxy, /start: '\/api\/account\/autotrade\/start'/);
assert.match(stateProxy, /stop: '\/api\/account\/autotrade\/stop'/);
assert.match(stateProxy, /authorization: `Bearer \$\{token\}`/);
assert.match(stateProxy, /live_execution_authorized: false/);

assert.match(route, /PAPER_PERFORMANCE_ROUTE = '\/api\/account\/paper-arbitrage\/performance'/);
assert.match(route, /getPaperArbitragePerformance/);
assert.match(route, /authentication: 'WALLET_SESSION'/);
assert.match(route, /live_execution_authorized: false/);
assert.match(proxy, /PRIMARY_API_ORIGIN = 'https:\/\/api\.aether\.boats'/);
assert.match(proxy, /SESSION_COOKIE = 'aether_session'/);
assert.match(proxy, /authorization: `Bearer \$\{token\}`/);
assert.match(caddy, /\/api\/account\/paper-arbitrage\/performance/);
assert.match(caddy, /\/api\/account\/subscription/);
assert.match(caddy, /\/api\/account\/subscription\/quote/);
assert.match(caddy, /\/api\/account\/subscription\/verify/);
assert.match(vercel, /api\/account\/paper-arbitrage\/performance/);
assert.match(vercel, /api\/account\/subscription/);
assert.match(vercel, /api\/account\/subscription\/quote/);
assert.match(vercel, /api\/account\/subscription\/verify/);
assert.match(vercel, /api\/account\/autotrade\/state/);
assert.match(vercel, /api\/account\/autotrade\/start/);
assert.match(vercel, /api\/account\/autotrade\/stop/);
assert.match(vercel, /api\/member-autotrade-state\.mjs/);
for (const src of ['/account/?','/autotrade/?','/performance/?','/subscription/?','/account/profile/?','/autotrade-demo/?']) {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(vercel, new RegExp(`"src": "${escaped}"[\\s\\S]*?"dest": "\\/public\\/member\\.html"`));
}
assert.doesNotMatch(vercel, /"src": "\/autotrade-demo\/\?"[\s\S]*?"dest": "\/public\/autotrade-demo\.html"/);

console.log('Member area five-menu + Auto Trade state binding regression: PASS');