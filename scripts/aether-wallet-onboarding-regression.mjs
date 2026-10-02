import fs from 'node:fs';
const page=fs.readFileSync('public/onboarding.html','utf8');
const must=[
  'https://wallet.aether.boats/sdk/aether-wallet.js',
  'Connect AETHER Wallet & Enter Member Area',
  "location.replace('/member')",
  "createConnectLink({chain:'solana'",
  "createSignMessageLink({chain:'solana'",
  "'/api/auth/challenge'",
  "'/api/auth/verify'",
  "purpose:'LOGIN'",
  "signature_encoding:signatureEncoding",
  "aether_aitrade_member_login_v2"
];
for(const needle of must)if(!page.includes(needle))throw new Error('aether_wallet_onboarding_missing:'+needle);
for(const forbidden of ['data-wallet="phantom"','data-wallet="solflare"','Choose a wallet','Continue to your AETHER account'])if(page.includes(forbidden))throw new Error('legacy_wallet_selector_present:'+forbidden);
console.log('AETHER Wallet member onboarding regression: PASS');