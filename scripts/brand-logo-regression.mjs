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
  ['Metallic A monogram', 'mark'],
  ['id="orbit"', 'mark'],
  ['id="orb"', 'mark'],
]) requireText(publicMark, needle, label);

const favicon = read('public/favicon.svg');
requireText(favicon, 'id="orbit"', 'favicon');
requireText(favicon, 'id="orb"', 'favicon');

const og = read('public/og-aether.svg');
requireText(og, 'AETHER — Trade with proof.', 'og');
requireText(og, 'TRADE WITH PROOF.', 'og');
requireText(og, 'SHADOW MODE', 'og');
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

console.log('AETHER brand logo regression: PASS');
