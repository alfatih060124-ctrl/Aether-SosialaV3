import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

for (const label of ['Dashboard','Auto Trade','Performance','Subscription','Account']) {
  assert.ok(html.includes(label), `missing member menu: ${label}`);
}
for (const parked of ['Copy Trading','Trader Marketplace','Market Discovery']) {
  assert.ok(!html.includes(parked), `parked surface leaked: ${parked}`);
}
for (const required of ['ORCA ↔ Raydium','0.20%','PAPER · SHADOW · LIVE OFF',
  '/api/account/autotrade/state','/api/account/autotrade/${action}','Open SHADOW Simulator']) {
  assert.ok(html.includes(required), `missing member binding: ${required}`);
}

const route = src => vercel.routes.find(x => x.src === src)?.dest;
assert.equal(route('/account/?'), '/public/member.html');
assert.equal(route('/autotrade/?'), '/public/member.html');
assert.equal(route('/performance/?'), '/public/member.html');
assert.equal(route('/subscription/?'), '/public/member.html');
assert.equal(route('/account/profile/?'), '/public/member.html');
assert.equal(route('/autotrade-demo/?'), '/public/autotrade-demo.html');
console.log('step21 member area regression: PASS');
