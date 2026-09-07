import fs from 'node:fs';

const page = fs.readFileSync('public/autotrade-demo.html', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const fail = message => { throw new Error(message); };

for (const required of [
  'Real-Market Shadow Runtime',
  'Auto Trade Simulator',
  '/api/account/auto-strategy/market-shadow',
  'Run One Scan',
  'Start Auto Trade',
  'Stop Auto Trade',
  'Minimum net edge',
  '0.20%',
  'SHADOW',
  'LIVE OFF',
  'transaction_signed=false',
  'network_submission_authorized=false'
]) {
  if (!page.includes(required)) fail(`market_shadow_page_contract_missing:${required}`);
}

for (const forbidden of [
  'Training scenario',
  'Start Auto Demo',
  'LIVE_ENABLED=true',
  'live_execution_authorized: true'
]) {
  if (page.includes(forbidden)) fail(`market_shadow_page_forbidden:${forbidden}`);
}

const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
if (!routes.some(route => route?.src === '/autotrade-demo/?' && route?.dest === '/public/autotrade-demo.html')) {
  fail('autotrade_demo_route_missing');
}
if (!routes.some(route => route?.src === '/api/account/auto-strategy/market-shadow/?' && route?.dest === '/api/market-shadow.mjs')) {
  fail('market_shadow_api_route_missing');
}

console.log('Member Auto Trade real-market SHADOW page regression: PASS');
