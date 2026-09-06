import assert from 'node:assert/strict';
import fs from 'node:fs';

const member = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
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
assert.match(member, /No fixed or promotional price is fabricated/);
assert.match(member, /LIVE Authorization/);
assert.match(member, />OFF</);

assert.match(route, /PAPER_PERFORMANCE_ROUTE = '\/api\/account\/paper-arbitrage\/performance'/);
assert.match(route, /getPaperArbitragePerformance/);
assert.match(route, /authentication: 'WALLET_SESSION'/);
assert.match(route, /live_execution_authorized: false/);
assert.match(proxy, /PRIMARY_API_ORIGIN = 'https:\/\/api\.aether\.boats'/);
assert.match(proxy, /SESSION_COOKIE = 'aether_session'/);
assert.match(proxy, /authorization: `Bearer \$\{token\}`/);
assert.match(vercel, /api\/account\/paper-arbitrage\/performance/);
assert.match(vercel, /"src": "\/account\/?"[\s\S]*"dest": "\/public\/member\.html"/);
assert.match(vercel, /"src": "\/autotrade\/?"[\s\S]*"dest": "\/public\/member\.html"/);
assert.match(vercel, /"src": "\/performance\/?"[\s\S]*"dest": "\/public\/member\.html"/);
assert.match(vercel, /"src": "\/subscription\/?"[\s\S]*"dest": "\/public\/member\.html"/);
assert.match(vercel, /"src": "\/account\/profile\/?"[\s\S]*"dest": "\/public\/member\.html"/);

console.log('Member area five-menu regression: PASS');
