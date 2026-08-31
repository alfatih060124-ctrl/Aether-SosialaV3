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
  if (exists(path)) failures.push(`legacy or duplicate runtime source must remain removed: ${path}`);
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
requireText('gateway', gateway, 'SESSION_GET_ROUTES');
requireText('gateway', gateway, 'SESSION_POST_ROUTES');
requireText('gateway', gateway, '/api/auth/challenge');
requireText('gateway', gateway, '/api/auth/verify');
requireText('gateway', gateway, '/api/auth/logout');
requireText('gateway', gateway, '/api/account/trader');
requireText('gateway', gateway, '/api/account/trader/challenge');
requireText('gateway', gateway, '/api/account/trader/apply');
requireText('gateway', gateway, 'HTTP_ONLY_COOKIE');
requireText('gateway', gateway, 'public_gateway_route_blocked');
forbidText('gateway', gateway, 'API_SERVICE_TOKEN');
forbidText('gateway', gateway, 'API_SERVICE_URL');
forbidText('gateway', gateway, 'ADMIN_API_TOKEN');
forbidText('gateway', gateway, 'req.headers.authorization');
forbidText('gateway', gateway, 'localStorage.setItem');
forbidText('gateway', gateway, 'localStorage.getItem');

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
requireText('caddy', caddy, '/api/auth/session /api/account/trader');
requireText('caddy', caddy, '/api/account/trader/challenge /api/account/trader/apply');
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

const server = read('services/api/src/server.mjs');
requireText('primary server', server, "route==='/api/account/trader'");
requireText('primary server', server, "route==='/api/account/trader/challenge'");
requireText('primary server', server, "route==='/api/account/trader/apply'");
requireText('primary server', server, "purpose:'BECOME_TRADER'");
requireText('primary server', server, "route==='/api/admin/traders/applications'");
requireText('primary server', server, "p[2]==='traders'");
requireText('primary server', server, 'publication_authorized:false');
requireText('primary server', server, 'live_execution_authorized:false');

const marketplace = read('services/api/src/repositories/marketplace.mjs');
requireText('marketplace', marketplace, "onboarding_status='APPROVED'");
requireText('marketplace', marketplace, "verification_status='VERIFIED'");
requireText('marketplace', marketplace, 'published=true');
requireText('marketplace', marketplace, 'createTraderApplication');
requireText('marketplace', marketplace, 'reviewTraderApplication');

const traderMigration = read('migrations/013_trader_onboarding.sql');
requireText('trader migration', traderMigration, 'onboarding_status');
requireText('trader migration', traderMigration, 'verification_status');
requireText('trader migration', traderMigration, 'published');
requireText('trader migration', traderMigration, 'strategy_summary');

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
forbidText('onboarding', onboarding, 'localStorage.setItem');
forbidText('onboarding', onboarding, 'localStorage.getItem');
requireText('account', account, '/api/auth/session');
requireText('account', account, '/api/auth/logout');
requireText('account', account, '/api/account/trader');
requireText('account', account, '/api/account/trader/challenge');
requireText('account', account, '/api/account/trader/apply');
requireText('account', account, 'provider.signMessage');
requireText('account', account, 'Purpose: BECOME_TRADER');
requireText('account', account, 'LIVE EXECUTION LOCKED');
forbidText('account', account, 'Become a Trader — next integration');
forbidText('account', account, 'localStorage.setItem');
forbidText('account', account, 'localStorage.getItem');

const admin = read('web/admin.html');
requireText('admin', admin, '/api/admin/traders/applications');
requireText('admin', admin, '/review');
requireText('admin', admin, 'verifiable history');

const traderDeploy = read('scripts/vm-deploy-trader-onboarding.sh');
requireText('trader deploy', traderDeploy, '/usr/local/sbin/aether-db-backup');
requireText('trader deploy', traderDeploy, 'EXECUTION_MODE=SHADOW');
requireText('trader deploy', traderDeploy, 'LIVE_ENABLED=false');
requireText('trader deploy', traderDeploy, 'migrations/013_trader_onboarding.sql');
requireText('trader deploy', traderDeploy, 'PostgreSQL host publishing is forbidden');

requireMissing('apps/web/index.html');
requireMissing('apps/web/app.js');
requireMissing('apps/admin/index.html');
requireMissing('services/api/src/trader-onboarding.mjs');

if (failures.length) {
  console.error('Infrastructure topology regression failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Infrastructure topology contract: PASS');
console.log('GitHub=source, public/=Vercel UI, Vercel API=read+wallet-auth/account BFF, VM=PRIMARY_VM, web/admin.html=Admin UI, Render=STANDBY_RENDER');
