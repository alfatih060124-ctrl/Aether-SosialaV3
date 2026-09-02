import fs from 'node:fs';

const page = fs.readFileSync('public/index.html', 'utf8');
const onboarding = fs.readFileSync('public/onboarding.html', 'utf8');

const connectLinks = [...page.matchAll(/<a[^>]+class="btn primary"[^>]+href="\/onboarding"[^>]*>Connect Wallet<\/a>/g)];
if (connectLinks.length < 2) throw new Error(`wallet_entrypoint_links_expected_2_found_${connectLinks.length}`);
if (page.includes('Wallet connection is not live yet')) throw new Error('legacy_wallet_shell_still_present');
if (page.includes('data-wallet')) throw new Error('legacy_wallet_modal_trigger_still_present');
if (!onboarding.includes("provider.connect()")) throw new Error('onboarding_provider_connect_missing');
if (!onboarding.includes("'/api/auth/challenge'")) throw new Error('onboarding_auth_challenge_missing');
if (!onboarding.includes("'/api/auth/verify'")) throw new Error('onboarding_auth_verify_missing');
if (!onboarding.includes('LIVE execution remains disabled')) throw new Error('shadow_safety_copy_missing');

console.log('AETHER wallet entrypoint regression: PASS');
