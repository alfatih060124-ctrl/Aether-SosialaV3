import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createDelegatedAuthorityIntent } from '../services/api/src/member-delegated-authority.mjs';
import { verifySolanaMessageSignature } from '../services/api/src/wallet-auth.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buffer) {
  let value = BigInt('0x' + Buffer.from(buffer).toString('hex'));
  let out = '';
  while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of buffer) { if (byte !== 0) break; out = '1' + out; }
  return out || '1';
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const der = publicKey.export({ format: 'der', type: 'spki' });
const wallet = base58(der.subarray(der.length - 32));
const issued = new Date('2026-09-06T10:00:00.000Z');
const intent = createDelegatedAuthorityIntent({
  user_id: 'member-1', wallet_address: wallet,
  max_notional_usdc_atomic: '20000000', max_daily_loss_usdc_atomic: '1000000',
  issued_at: issued, expires_at: new Date(issued.getTime() + 86400000)
});
const signature = crypto.sign(null, Buffer.from(intent.consent_message, 'utf8'), privateKey).toString('base64');
assert.equal(verifySolanaMessageSignature({ walletAddress: wallet, message: intent.consent_message, signature, signatureEncoding: 'base64' }), true);
assert.equal(verifySolanaMessageSignature({ walletAddress: wallet, message: intent.consent_message + 'x', signature, signatureEncoding: 'base64' }), false);

const route = fs.readFileSync(new URL('../services/api/src/member-delegated-authority-route.mjs', import.meta.url), 'utf8');
const dispatcher = fs.readFileSync(new URL('../services/api/src/member-positions-route.mjs', import.meta.url), 'utf8');
const proxy = fs.readFileSync(new URL('../api/member-authority.mjs', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const manifest = fs.readFileSync(new URL('../deploy/vercel-direct-deploy-manifest.json', import.meta.url), 'utf8');

for (const path of [
  '/api/account/delegated-authority',
  '/api/account/delegated-authority/challenge',
  '/api/account/delegated-authority/verify',
  '/api/account/delegated-authority/revoke'
]) {
  assert.match(route, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(vercel, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(caddy, new RegExp(path.replaceAll('/', '\\/')));
}
assert.match(route, /verifySolanaMessageSignature/);
assert.match(route, /ownership_verified:true/);
assert.match(route, /transaction_submission_authorized:false/);
assert.match(dispatcher, /handleMemberDelegatedAuthorityRoute/);
assert.match(proxy, /SESSION_COOKIE = 'aether_session'/);
assert.match(proxy, /authorization: `Bearer \$\{token\}`/);
assert.match(manifest, /api\/member-authority\.mjs/);
for (const source of [route, proxy]) {
  assert.doesNotMatch(source, /sendTransaction|private[_ ]?key|seed phrase/i);
}
console.log('Member delegated authority binding regression: PASS');
