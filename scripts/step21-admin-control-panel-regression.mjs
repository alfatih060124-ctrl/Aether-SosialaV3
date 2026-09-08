import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../services/api/src/server.mjs', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../deploy/vercel-direct-deploy-manifest.json', import.meta.url), 'utf8'));
const feeMigration = fs.readFileSync(new URL('../migrations/028_platform_fee_config_versions.sql', import.meta.url), 'utf8');

for (const needle of [
  'Engine Control','Subscription & Payments','Fee Configuration',
  'Members & LIVE Access','Treasury & Payment Monitoring','Trader Verification',
  'Audit & Risk','Parked Modules','ORCA ↔ Raydium','0.20%','Emergency Kill',
  '30 days','90 days','180 days','360 days','SERVER-AUTHORITATIVE',
  'Finalized Solana evidence required','Database-enforced','PARKED — Follower Copy Mandates'
]) assert.ok(html.includes(needle), `step21_admin_missing:${needle}`);

for (const endpoint of [
  '/api/admin/live-control','/api/admin/subscriptions','/api/admin/subscriptions/prices',
  '/api/admin/members','/api/admin/fees/apply-shadow','/api/admin/fees/history',
  '/api/admin/wallets','/api/admin/traders/applications','/api/admin/risk','/api/admin/audit'
]) {
  assert.ok(server.includes(endpoint), `step21_admin_server_route_missing:${endpoint}`);
  assert.ok(html.includes(endpoint), `step21_admin_ui_binding_missing:${endpoint}`);
}

assert.match(html, /Activate LIVE — LOCKED<\/button>/);
assert.match(html, /SHADOW · FAIL-CLOSED · LIVE OFF/);
assert.match(html, /Member Area remains a separate five-menu product surface/);
assert.doesNotMatch(html, /35 USDC|89\.25 USDC|157\.50 USDC|273\.00 USDC/);
assert.doesNotMatch(html, /Copy Trading & Mandates/);
assert.match(server, /route==='\/api\/admin\/fees'[\s\S]*fee_control_lifecycle_required/);
assert.match(server, /confirm_shadow_only/);
assert.match(feeMigration, /platform_fee_config_versions/);
assert.match(feeMigration, /live_execution_authorized boolean NOT NULL DEFAULT false/);
assert.match(caddy, /@admin_ui path \/ \/admin \/admin\.html[\s\S]*root \* \/opt\/aether-v3\/web[\s\S]*rewrite \* \/admin\.html/);
assert.ok(!manifest.files.includes('public/admin.html'), 'public edge deploy must not include Admin control panel');
assert.ok(!fs.existsSync(new URL('../public/admin.html', import.meta.url)), 'duplicate public Admin page must remain removed');

console.log('step21 admin control panel regression: PASS');
