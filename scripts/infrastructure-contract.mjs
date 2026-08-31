import fs from 'node:fs';

const fileUrl = path => new URL(`../${path}`, import.meta.url);
const read = path => fs.readFileSync(fileUrl(path), 'utf8');
const exists = path => fs.existsSync(fileUrl(path));
const failures = [];
const requireText = (name, text, needle) => {
  if (!text.includes(needle)) failures.push(`${name}: missing ${JSON.stringify(needle)}`);
};
const forbidText = (name, text, needle) => {
  if (text.includes(needle)) failures.push(`${name}: forbidden ${JSON.stringify(needle)}`);
};
const requireMissing = path => {
  if (exists(path)) failures.push(`legacy runtime source must remain removed: ${path}`);
};

const compose = read('docker-compose.yml');
requireText('compose', compose, 'AETHER_DEPLOYMENT_ROLE: PRIMARY_VM');
requireText('compose', compose, '127.0.0.1:8080:8080');
requireText('compose', compose, 'EXECUTION_MODE: SHADOW');
requireText('compose', compose, 'LIVE_ENABLED: "false"');
requireText('compose', compose, 'FIXTURE_GATE_PASSED: "false"');
requireText('compose', compose, 'OPERATOR_APPROVED: "false"');
forbidText('compose', compose, '- "8080:8080"');
forbidText('compose', compose, '- "5432:5432"');
forbidText('compose', compose, '0.0.0.0:8080:8080');
forbidText('compose', compose, '0.0.0.0:5432:5432');

const render = read('render.yaml');
requireText('render', render, 'STANDBY_RENDER');
requireText('render', render, 'standby-server.mjs');
requireText('render', render, 'autoDeployTrigger: off');
forbidText('render', render, 'DATABASE_URL');
forbidText('render', render, 'API_TOKEN');
forbidText('render', render, 'ADMIN_API_TOKEN');

const standby = read('services/api/src/standby-server.mjs');
requireText('standby', standby, "ROLE = 'STANDBY_RENDER'");
requireText('standby', standby, 'traffic_authorized: false');
requireText('standby', standby, 'database_attached: false');
forbidText('standby', standby, "from 'pg'");
forbidText('standby', standby, 'DATABASE_URL');

const gateway = read('api/index.mjs');
requireText('gateway', gateway, "PRIMARY_API_ORIGIN = 'https://api.aether.boats'");
requireText('gateway', gateway, "SESSION_COOKIE = 'aether_session'");
requireText('gateway', gateway, 'PUBLIC_GET_ROUTES');
requireText('gateway', gateway, 'AUTH_POST_ROUTES');
requireText('gateway', gateway, '/api/auth/challenge');
requireText('gateway', gateway, '/api/auth/verify');
requireText('gateway', gateway, '/api/auth/logout');
requireText('gateway', gateway, 'HTTP_ONLY_COOKIE');
requireText('gateway', gateway, 'public_gateway_route_blocked');
forbidText('gateway', gateway, 'API_SERVICE_TOKEN');
forbidText('gateway', gateway, 'API_SERVICE_URL');
forbidText('gateway', gateway, 'ADMIN_API_TOKEN');
forbidText('gateway', gateway, 'req.headers.authorization');
forbidText('gateway', gateway, 'localStorage');

const vercel = read('vercel.json');
requireText('vercel', vercel, '"src": "api/index.mjs"');
requireText('vercel', vercel, '"src": "public/**"');
requireText('vercel', vercel, '"dest": "/public/dashboard.html"');
requireText('vercel', vercel, '"dest": "/public/onboarding.html"');
requireText('vercel', vercel, '"dest": "/public/account.html"');
requireText('vercel', vercel, '"dest": "/public/index.html"');
forbidText('vercel', vercel, 'apps/web');
forbidText('vercel', vercel, 'apps/admin');
forbidText('vercel', vercel, 'web/admin.html');

const caddy = read('deploy/Caddyfile');
requireText('caddy', caddy, 'api.aether.boats');
requireText('caddy', caddy, 'a.aether.boats');
requireText('caddy', caddy, 'method GET');
requireText('caddy', caddy, '@wallet_auth_write');
requireText('caddy', caddy, 'method POST');
requireText('caddy', caddy, '/api/auth/challenge /api/auth/verify /api/auth/logout');
requireText('caddy', caddy, '/api/auth/session');
requireText('caddy', caddy, 'respond "public API route not available" 404');
requireText('caddy', caddy, '@admin_api path /api/admin /api/admin/*');
requireText('caddy', caddy, '@admin_ui path / /admin /admin.html');
requireText('caddy', caddy, 'respond "admin route not available" 404');
const publicCaddy = caddy.split('a.aether.boats {')[0]
  .split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n');
forbidText('public caddy', publicCaddy, '/api/admin');
forbidText('public caddy', publicCaddy, '/api/shadow');
forbidText('public caddy', publicCaddy, '/api/executions');
forbidText('public caddy', publicCaddy, '/api/signals/evaluate');

const dashboard = read('public/dashboard.html');
const shadow = read('public/shadow.html');
const onboarding = read('public/onboarding.html');
const account = read('public/account.html');
forbidText('public dashboard', dashboard, '/api/shadow/simulate');
forbidText('public shadow page', shadow, '/api/shadow/simulate');
requireText('public dashboard', dashboard, 'PUBLIC • READ ONLY • SHADOW');
requireText('public shadow page', shadow, "location.replace('/dashboard')");
requireText('onboarding', onboarding, '/api/auth/challenge');
requireText('onboarding', onboarding, '/api/auth/verify');
requireText('onboarding', onboarding, 'provider.signMessage');
requireText('onboarding', onboarding, 'HttpOnly cookie');
forbidText('onboarding', onboarding, 'not enabled yet');
forbidText('onboarding', onboarding, 'localStorage');
requireText('account', account, '/api/auth/session');
requireText('account', account, '/api/auth/logout');
requireText('account', account, 'LIVE EXECUTION LOCKED');

requireMissing('apps/web/index.html');
requireMissing('apps/web/app.js');
requireMissing('apps/admin/index.html');

if (failures.length) {
  console.error('Infrastructure topology regression failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Infrastructure topology contract: PASS');
console.log('GitHub=source, public/=Vercel UI, Vercel API=read+wallet-auth BFF, VM=PRIMARY_VM, web/admin.html=Admin UI, Render=STANDBY_RENDER');
