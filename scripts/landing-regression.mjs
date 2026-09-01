import fs from 'node:fs';

const landing = fs.readFileSync('public/index.html', 'utf8');
const onboarding = fs.readFileSync('public/onboarding.html', 'utf8');
const market = fs.readFileSync('public/market.html', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const visibleText = source => source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const exactPositioning = 'Social Trading + On-chain Intelligence + Verified Performance + Automated Risk + Non-Custodial Execution.';
const landingText = visibleText(landing);

requireMatch(landing, /<title>[^<]*AETHER/i, 'Landing page title must use AETHER branding.');
requireMatch(landingText, /Trade with proof\./i, 'Landing page must retain the Trade with proof headline.');
if (!landingText.includes(exactPositioning)) failures.push('Landing page must contain the exact AETHER core positioning statement in visible copy.');
requireMatch(landingText, /Verifiable Social Trading/i, 'Landing page must contain the public value proposition.');
requireMatch(landingText, /Connect Wallet/i, 'Landing page must expose a Connect Wallet CTA shell.');
requireMatch(landingText, /non[- ]custodial/i, 'Landing page must explain non-custodial design.');
requireMatch(landingText, /verifiable|on-chain/i, 'Landing page must explain verifiability/on-chain transparency.');
requireMatch(landingText, /marketplace/i, 'Landing page must include marketplace/trader preview.');
requireMatch(landingText, /risk/i, 'Landing page must include risk transparency.');
requireMatch(landingText, /execution/i, 'Landing page must include execution transparency.');
requireMatch(landingText, /fee/i, 'Landing page must include fee transparency.');
requireMatch(landingText, /Become a Trader/i, 'Landing page must include Become a Trader path.');
requireMatch(landingText, /seed phrase|private key/i, 'Landing page wallet safety copy must explicitly reject secret collection.');
requireMatch(landing, /viewport/i, 'Landing page must include a responsive viewport meta tag.');
requireMatch(landing, /description/i, 'Landing page must include SEO description metadata.');
requireMatch(landing, /favicon\.svg/i, 'Landing page must expose the AETHER favicon.');
requireMatch(landing, /og-aether\.svg/i, 'Landing page must expose AETHER social preview branding.');

if (/AETHER\s*V3|Execution Engine V3/i.test(landingText)) {
  failures.push('Public landing page must not expose internal V3 branding.');
}

requireMatch(onboarding, /wallet ownership only|proves wallet ownership only/i, 'Onboarding must explain that login signature proves wallet ownership only.');
requireMatch(onboarding, /does not authorize a trade|no trade or fund transfer is authorized/i, 'Onboarding must explicitly reject trading/fund authority from login signatures.');
requireMatch(onboarding, /single-use,? short-lived nonce|single-use.*nonce|short-lived server challenge/i, 'Onboarding must disclose the single-use, short-lived authentication challenge.');
requireMatch(onboarding, /seed phrase|private key/i, 'Onboarding must explicitly reject secret collection.');
requireMatch(onboarding, /HttpOnly/i, 'Onboarding must disclose secure HttpOnly session storage.');

requireMatch(market, /Solana Token Mint Address|Token Mint Address/i, 'Market page must identify token lookup by Solana mint address.');
requireMatch(market, /\/api\/market\/token\?mint=/i, 'Market page must use the canonical read-only market token API.');
requireMatch(market, /stale/i, 'Market page must expose stale-data handling.');
requireMatch(market, /invalid|not found|unavailable/i, 'Market page must expose invalid/not-found/unavailable states.');
if (/signTransaction|sendTransaction|signAndSendTransaction|\/api\/execution|\/api\/trade/i.test(market)) {
  failures.push('Market page must remain read-only and must not expose signer or execution paths.');
}

const routeMap = new Map((vercel.routes || []).map(route => [route.src, route.dest]));
if (routeMap.get('/') !== '/public/index.html') failures.push('Vercel root route must serve public/index.html.');
if (routeMap.get('/dashboard/?') !== '/public/dashboard.html') failures.push('Vercel must preserve the separate /dashboard SHADOW route.');
if (routeMap.get('/onboarding/?') !== '/public/onboarding.html') failures.push('Vercel must preserve the /onboarding route.');
if (routeMap.get('/market/?') !== '/public/market.html') failures.push('Vercel must expose the read-only /market token intelligence route.');

if (failures.length) {
  console.error('Landing regression failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Landing regression passed. Public AETHER branding, onboarding safety, market read-only guarantees, and routing are intact.');
