import fs from 'node:fs';

const page = fs.readFileSync('public/autotrade-demo.html', 'utf8');
const fail = message => { throw new Error(message); };

for (const invariant of [
  'SHADOW',
  'LIVE OFF',
  'funds_moved=false',
  'execution_dispatched=false'
]) {
  if (!page.includes(invariant)) fail(`autotrade_demo_safety_invariant_missing:${invariant}`);
}

const renderWalletMatch = page.match(/function\s+renderWallet\s*\([^)]*\)\s*\{([\s\S]*?)\}\nasync\s+function\s+loadWallet/);
if (!renderWalletMatch) fail('autotrade_demo_render_wallet_missing');
const renderWallet = renderWalletMatch[1];

if (/div\.innerHTML\s*=\s*`[\s\S]*\$\{t\.(engine_action|settlement_status|scenario)/.test(renderWallet)) {
  fail('autotrade_demo_persisted_history_dom_xss_sink');
}

for (const field of ['engine_action', 'settlement_status', 'scenario']) {
  if (!renderWallet.includes(`t.${field}`)) fail(`autotrade_demo_history_field_missing:${field}`);
}

if (!/textContent/.test(renderWallet)) {
  fail('autotrade_demo_history_text_safe_rendering_missing');
}

if (page.includes('LIVE_ENABLED=true') || page.includes('live_execution_authorized=true') || page.includes('live_execution_authorized: true')) {
  fail('autotrade_demo_live_enablement_forbidden');
}

console.log('Auto Trade Demo history DOM XSS regression: PASS');
