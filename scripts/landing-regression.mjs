import fs from 'node:fs';

const landing = fs.readFileSync('public/index.html', 'utf8');
const onboarding = fs.readFileSync('public/onboarding.html', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};

requireMatch(landing, /<title>[^<]*AETHER/i, 'Landing page title must use AETHER branding.');
requireMatch(landing, /Verifiable Social Trading/i, 'Landing page must contain the public value proposition.');
requireMatch(landing, /Connect Wallet/i, 'Landing page must expose a Connect Wallet CTA shell.');
requireMatch(landing, /non[- ]custodial/i, 'Landing page must explain non-custodial design.');
requireMatch(landing, /verifiable|on-chain/i, 'Landing page must explain verifiability/on-chain transparency.');
requireMatch(landing, /marketplace/i, 'Landing page must include marketplace/trader preview.');
requireMatch(landing, /risk/i, 'Landing page must include risk transparency.');
requireMatch(landing, /execution/i, 'Landing page must include execution transparency.');
requireMatch(landing, /fee/i, 'Landing page must include fee transparency.');
requireMatch(landing, /Become a Trader/i, 'Landing page must include Become a Trader path.');
requireMatch(landing, /seed phrase|private key/i, 'Landing page wallet safety copy must explicitly reject secret collection.');
requireMatch(landing, /viewport/i, 'Landing page must include a responsive viewport meta tag.');
requireMatch(landing, /description/i, 'Landing page must include SEO description metadata.');

if (/AETHER\s*V3|Execution Engine V3/i.test(landing)) {
  failures.push('Public landing page must not expose internal V3 branding.');
}

requireMatch(onboarding, /This is not an authenticated AETHER account session|does not create an authenticated AETHER account/i, 'Onboarding must not claim wallet authentication is active.');
requireMatch(onboarding, /server-issued nonce/i, 'Onboarding must disclose pending nonce/signature verification.');
requireMatch(onboarding, /seed phrase|private key/i, 'Onboarding must explicitly reject secret collection.');

const routeMap = new Map((vercel.routes || []).map(route => [route.src, route.dest]));
if (routeMap.get('/') !== '/public/index.html') failures.push('Vercel root route must serve public/index.html.');
if (routeMap.get('/dashboard/?') !== '/public/dashboard.html') failures.push('Vercel must preserve the separate /dashboard SHADOW route.');
if (routeMap.get('/onboarding/?') !== '/public/onboarding.html') failures.push('Vercel must preserve the /onboarding route.');

if (failures.length) {
  console.error('Landing regression failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Landing regression passed. Public AETHER requirements and safe routing are intact.');
