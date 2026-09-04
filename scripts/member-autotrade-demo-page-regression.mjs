import fs from 'node:fs';

const page = fs.readFileSync('public/autotrade-demo.html', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const fail = message => { throw new Error(message); };

for (const required of [
  'Auto Trade Demo',
  '/api/account/auto-strategy/demo',
  '/api/account/auto-strategy/simulate',
  'Demo balance',
  'Performance fee',
  'Start Auto Demo',
  'SHADOW',
  'LIVE OFF',
  'funds_moved=false'
]) {
  if (!page.includes(required)) fail(`demo_page_contract_missing:${required}`);
}

if (page.includes('LIVE_ENABLED=true') || page.includes('live_execution_authorized: true')) {
  fail('demo_page_live_enablement_forbidden');
}

const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
if (!routes.some(route => route?.src === '/autotrade-demo/?' && route?.dest === '/public/autotrade-demo.html')) {
  fail('autotrade_demo_route_missing');
}

console.log('Member Auto Trade Demo page regression: PASS');
