import fs from 'node:fs';

const page = fs.readFileSync('public/autotrade-demo.html', 'utf8');
const service = fs.readFileSync('services/api/src/member-autotrade-demo.mjs', 'utf8');
const route = fs.readFileSync('services/api/src/member-autotrade-route.mjs', 'utf8');
const migration = fs.readFileSync('migrations/024_member_autotrade_arbitrage_history.sql', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const fail = message => { throw new Error(message); };

for (const required of [
  'Auto Trade Simulator',
  '/api/account/auto-strategy/demo',
  '/api/account/auto-strategy/simulate',
  'Demo balance',
  'Performance fee',
  'Start Auto Scan',
  'TWO_LEG_ARBITRAGE',
  'ORCA ↔ Raydium',
  'Expected NET edge ≥ 0.20%',
  'SHADOW',
  'LIVE OFF',
  'funds_moved=false'
]) {
  if (!page.includes(required)) fail(`demo_page_contract_missing:${required}`);
}
for (const forbidden of ['Training scenario', 'qualified_entry', 'healthy_position', 'trailing_stop_exit', 'stop_loss_exit', 'runAutoTradeTraining']) {
  if (page.includes(forbidden) || service.includes(forbidden)) fail(`demo_training_contract_forbidden:${forbidden}`);
}
if (!page.includes('textContent') || page.includes('div.innerHTML=`')) fail('demo_history_text_safe_rendering_required');
if (!service.includes('settleDemoArbitrage') || !service.includes("training_fixture: false")) fail('demo_real_market_settlement_required');
if (!route.includes('real_market_shadow_runtime_unconfigured') || !route.includes('realMarketRuntime')) fail('demo_real_market_failclosed_route_required');
if (!migration.includes("'ARBITRAGE_SETTLE'") || !migration.includes("'ARBITRAGE_CLOSED'")) fail('demo_arbitrage_history_schema_required');
if (page.includes('LIVE_ENABLED=true') || page.includes('live_execution_authorized: true')) fail('demo_page_live_enablement_forbidden');
const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
if (!routes.some(route => route?.src === '/autotrade-demo/?' && route?.dest === '/public/autotrade-demo.html')) fail('autotrade_demo_route_missing');
console.log('Member Auto Trade Simulator page regression: PASS');
