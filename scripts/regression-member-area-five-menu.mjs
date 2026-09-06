import assert from 'node:assert/strict';
import fs from 'node:fs';

const member = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../services/api/src/member-autotrade-route.mjs', import.meta.url), 'utf8');
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
assert.match(member, /Start remains fail-closed/);
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
for (const src of ['/account/?','/autotrade/?','/performance/?','/subscription/?','/account/profile/?','/autotrade-demo/?']) {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(vercel, new RegExp(`"src": "${escaped}"[\\s\\S]*?"dest": "\\/public\\/member\\.html"`));
}
assert.doesNotMatch(vercel, /"src": "\/autotrade-demo\/\?"[\s\S]*?"dest": "\/public\/autotrade-demo\.html"/);

console.log('Member area five-menu regression: PASS');
