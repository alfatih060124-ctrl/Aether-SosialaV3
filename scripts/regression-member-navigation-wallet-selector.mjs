import fs from 'node:fs';

const member = fs.readFileSync('public/account-member-autotrade.js','utf8');
const onboarding = fs.readFileSync('public/onboarding.html','utf8');
const fail = (message) => { throw new Error(message); };

for (const needle of ['Auto Trade','Market Discovery','Trader Marketplace','Copy Trading','Account & Wallet','System Status']) {
  if (!member.includes(needle)) fail(`member_navigation_missing:${needle}`);
}
for (const needle of ['Phantom','Solflare','TokenPocket','MetaMask','Solana Wallet']) {
  if (!onboarding.includes(needle)) fail(`wallet_option_missing:${needle}`);
}
for (const needle of ['/api/auth/challenge','/api/auth/verify','/api/auth/logout','signMessage']) {
  if (!onboarding.includes(needle)) fail(`auth_flow_missing:${needle}`);
}
if (!onboarding.includes('no trade or fund transfer')) fail('login_signature_safety_copy_missing');
if (!onboarding.includes('seed phrase') || !onboarding.includes('private key')) fail('non_custodial_safety_copy_missing');
console.log('member navigation and wallet selector regression: PASS');
