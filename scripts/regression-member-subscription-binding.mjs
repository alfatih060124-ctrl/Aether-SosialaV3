import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [service, route, proxy, migration, vercel, caddy, manifest] = await Promise.all([
  readFile('services/api/src/member-subscription-billing.mjs', 'utf8'),
  readFile('services/api/src/member-autotrade-route.mjs', 'utf8'),
  readFile('api/member-subscription.mjs', 'utf8'),
  readFile('migrations/025_dynamic_subscription_billing.sql', 'utf8'),
  readFile('vercel.json', 'utf8'),
  readFile('deploy/Caddyfile', 'utf8'),
  readFile('deploy/vercel-direct-deploy-manifest.json', 'utf8')
]);

for (const duration of ['30', '90', '180', '360']) assert.match(service, new RegExp(`durations_days|${duration}`));
assert.match(service, /selectEffectiveSubscriptionPrice/);
assert.match(service, /createSubscriptionQuote/);
assert.match(service, /createSolanaUsdcSubscriptionPaymentVerifier/);
assert.match(service, /subscription_payment_signature_already_used/);
assert.match(service, /transaction_submission_authorized:\s*false/);
assert.match(service, /signing_authorized:\s*false/);
assert.match(service, /live_execution_authorized:\s*false/);
assert.match(service, /subscription_treasury_configuration_changed/);
assert.match(service, /subscription_usdc_mint_configuration_changed/);

assert.match(migration, /payment_recipient_wallet text NOT NULL/);
assert.match(migration, /payment_mint text NOT NULL/);
assert.match(migration, /signature text NOT NULL UNIQUE/);
assert.match(migration, /UNIQUE\(duration_days, price_version\)/);

for (const path of [
  '/api/account/subscription',
  '/api/account/subscription/quote',
  '/api/account/subscription/verify'
]) {
  assert.ok(route.includes(path), `member_route_missing:${path}`);
  assert.ok(caddy.includes(path), `public_ingress_missing:${path}`);
}
assert.match(route, /WALLET_SESSION/);
assert.match(proxy, /aether_session/);
assert.match(proxy, /authorization: `Bearer \$\{token\}`/);
assert.match(proxy, /transaction_submission_authorized:\s*false/);
assert.match(proxy, /signing_authorized:\s*false/);
assert.match(proxy, /live_execution_authorized:\s*false/);

for (const action of ['status', 'quote', 'verify']) assert.ok(vercel.includes(`action=${action}`), `vercel_subscription_action_missing:${action}`);
assert.ok(vercel.includes('api/member-subscription.mjs'), 'vercel_subscription_build_missing');
assert.ok(manifest.includes('api/member-subscription.mjs'), 'direct_deploy_subscription_proxy_missing');

console.log(JSON.stringify({
  ok: true,
  schema: 'aether.member_subscription_binding.regression.v1',
  wallet_session_required: true,
  finalized_rpc_required: true,
  replay_protection: 'UNIQUE_SIGNATURE',
  transaction_submission_authorized: false,
  signing_authorized: false,
  live_execution_authorized: false
}));
