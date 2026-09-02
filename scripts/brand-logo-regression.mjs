import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const requireText = (value, needle, label) => {
  if (!value.includes(needle)) throw new Error(`${label}:missing:${needle}`);
};
const rejectText = (value, needle, label) => {
  if (value.includes(needle)) throw new Error(`${label}:forbidden:${needle}`);
};

const publicMark = read('public/aether-mark.svg');
const webMark = read('web/aether-mark.svg');
if (publicMark !== webMark) throw new Error('brand_mark_public_web_mismatch');

for (const [needle, label] of [
  ['AETHER official mark', 'mark'],
  ['White A monogram with red orbital swoosh', 'mark'],
  ['id="swoosh"', 'mark'],
  ['#ef1826', 'mark'],
]) requireText(publicMark, needle, label);
rejectText(publicMark, 'electric-blue orbital ring', 'mark');

const favicon = read('public/favicon.svg');
requireText(favicon, 'White A monogram with red orbital swoosh', 'favicon');
requireText(favicon, 'id="swoosh"', 'favicon');

const og = read('public/og-aether.svg');
requireText(og, 'AETHER — Trade with proof.', 'og');
requireText(og, 'TRADE WITH PROOF.', 'og');
requireText(og, 'SHADOW MODE', 'og');
requireText(og, 'id="red-swoosh"', 'og');
rejectText(og, 'V3', 'og');

const publicPages = [
  'public/index.html',
  'public/dashboard.html',
  'public/onboarding.html',
  'public/account.html',
  'public/market.html',
];
for (const path of publicPages) {
  const page = read(path);
  requireText(page, '/aether-mark.svg', path);
  requireText(page, '/favicon.svg', path);
}

const legacyLanding = read('web/index.html');
requireText(legacyLanding, '/aether-mark.svg', 'web/index.html');
requireText(legacyLanding, 'rel="icon" href="/aether-mark.svg"', 'web/index.html');
rejectText(legacyLanding, '<span class="mark">A</span>', 'web/index.html');

const vmDashboard = read('web/dashboard.html');
requireText(vmDashboard, '/aether-mark.svg', 'web/dashboard.html');

const vercel = JSON.parse(read('vercel.json'));
const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
const fallbackIndex = routes.findIndex(route => route?.src === '/(.*)' && route?.dest === '/public/index.html');
if (fallbackIndex < 0) throw new Error('vercel_spa_fallback_missing');
for (const [src, dest] of [
  ['/aether-mark.svg', '/public/aether-mark.svg'],
  ['/favicon.svg', '/public/favicon.svg'],
  ['/og-aether.svg', '/public/og-aether.svg'],
]) {
  const index = routes.findIndex(route => route?.src === src && route?.dest === dest);
  if (index < 0) throw new Error(`vercel_brand_asset_route_missing:${src}`);
  if (index > fallbackIndex) throw new Error(`vercel_brand_asset_route_after_fallback:${src}`);
}

console.log('AETHER brand logo regression: PASS');
