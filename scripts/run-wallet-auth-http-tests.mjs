import crypto from 'node:crypto';

const base = process.env.AETHER_TEST_API || 'http://127.0.0.1:8080';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(buffer) {
  const bytes = [...buffer];
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  for (let i = 0; i < bytes.length - 1 && bytes[i] === 0; i++) digits.push(0);
  return digits.reverse().map(d => alphabet[d]).join('');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const walletAddress = encodeBase58(spki.subarray(spki.length - 32));

const status = await request('/api/execution/status');
assert(status.response.ok, 'execution status unavailable');
assert(status.body.live_enabled === false, 'LIVE must remain disabled during auth tests');

const challengeResult = await request('/api/auth/challenge', {
  method: 'POST',
  body: JSON.stringify({ wallet_address: walletAddress, purpose: 'LOGIN' }),
});
assert(challengeResult.response.status === 201, `challenge failed: ${challengeResult.response.status}`);
const challenge = challengeResult.body.challenge;
assert(challenge?.challenge_id, 'challenge_id missing');
assert(challenge?.message?.includes('AETHER WALLET AUTHENTICATION'), 'challenge message invalid');
assert(challenge.transaction_required === false, 'auth challenge must not require a transaction');
assert(challenge.funds_authorized === false, 'auth challenge must not authorize funds');

const signature = crypto.sign(null, Buffer.from(challenge.message, 'utf8'), privateKey).toString('base64');
const verifyPayload = {
  challenge_id: challenge.challenge_id,
  wallet_address: walletAddress,
  signature,
  signature_encoding: 'base64',
};

const missingConsent = await request('/api/auth/verify', {
  method: 'POST',
  body: JSON.stringify(verifyPayload),
});
assert(missingConsent.response.status === 403, `new account without consent should be 403, got ${missingConsent.response.status}`);
assert(missingConsent.body.error === 'required_consents_missing', 'missing-consent error mismatch');

const verified = await request('/api/auth/verify', {
  method: 'POST',
  body: JSON.stringify({
    ...verifyPayload,
    consents: [
      { type: 'TERMS', version: 'integration-v1' },
      { type: 'RISK_DISCLOSURE', version: 'integration-v1' },
      { type: 'FEE_DISCLOSURE', version: 'integration-v1' },
    ],
  }),
});
assert(verified.response.status === 200, `wallet verify failed: ${verified.response.status}`);
assert(verified.body.account_created === true, 'first verified login should create an account');
assert(verified.body.user?.primary_wallet === walletAddress, 'verified wallet mismatch');
assert(verified.body.session?.token, 'opaque session token missing from primary API response');
assert(!JSON.stringify(verified.body).toLowerCase().includes('private_key'), 'auth response must not contain private key material');

const sessionToken = verified.body.session.token;
const session = await request('/api/auth/session', {
  headers: { authorization: `Bearer ${sessionToken}` },
});
assert(session.response.status === 200, `session lookup failed: ${session.response.status}`);
assert(session.body.authenticated === true, 'session not authenticated');
assert(session.body.user?.primary_wallet === walletAddress, 'session wallet mismatch');

const logout = await request('/api/auth/logout', {
  method: 'POST',
  headers: { authorization: `Bearer ${sessionToken}` },
});
assert(logout.response.status === 200 && logout.body.revoked === true, 'logout did not revoke session');

const revoked = await request('/api/auth/session', {
  headers: { authorization: `Bearer ${sessionToken}` },
});
assert(revoked.response.status === 401, `revoked session should be 401, got ${revoked.response.status}`);

console.log('Wallet auth HTTP regression: PASS');
console.log('challenge -> consent gate -> Ed25519 verify -> session -> revoke');
console.log('LIVE remained disabled throughout the test');
