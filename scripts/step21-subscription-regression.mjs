import fs from 'node:fs';
import assert from 'node:assert/strict';

const route = fs.readFileSync(new URL('../services/api/src/member-autotrade-route.mjs', import.meta.url), 'utf8');
const proxy = fs.readFileSync(new URL('../api/member-subscription.mjs', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/025_dynamic_subscription_billing.sql', import.meta.url), 'utf8');
const member = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../deploy/vercel-direct-deploy-manifest.json', import.meta.url), 'utf8'));

for (const path of ['/api/account/subscription','/api/account/subscription/quote','/api/account/subscription/verify']) {
  assert.ok(route.includes(path), `missing primary route: ${path}`);
  assert.ok(member.includes(path), `missing member binding: ${path}`);
}
assert.ok(proxy.includes('aether_session'));
assert.ok(proxy.includes('live_execution_authorized: false'));
assert.ok(migration.includes('signature text NOT NULL UNIQUE'));
assert.ok(migration.includes('UNIQUE(duration_days, price_version)'));
assert.ok(member.includes('server-authoritative versioned catalog'));
for (const stale of ['35 USDC','89.25 USDC','157.50 USDC','273.00 USDC']) assert.ok(!member.includes(stale));
for (const action of ['status','quote','verify']) assert.ok(JSON.stringify(vercel).includes(`action=${action}`));
assert.ok(manifest.files.includes('api/member-subscription.mjs'));
assert.ok(manifest.files.includes('public/member.html'));
console.log('step21 subscription regression: PASS');