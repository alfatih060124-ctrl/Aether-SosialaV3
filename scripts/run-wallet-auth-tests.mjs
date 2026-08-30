import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildWalletChallengeMessage,
  validateSolanaWallet,
  verifySolanaMessageSignature
} from '../services/api/src/wallet-auth.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(buffer) {
  const bytes = [...buffer];
  const digits = [0];
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
  let out = '';
  for (let i = 0; i < bytes.length - 1 && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const der = publicKey.export({ format: 'der', type: 'spki' });
const rawPublicKey = der.subarray(der.length - 32);
const walletAddress = encodeBase58(rawPublicKey);

assert.equal(validateSolanaWallet(walletAddress).length, 32);
assert.throws(() => validateSolanaWallet('not-a-solana-wallet'), /invalid_base58|invalid_solana_wallet/);

const message = buildWalletChallengeMessage({
  walletAddress,
  purpose: 'LOGIN',
  nonce: 'test-nonce',
  issuedAt: '2026-08-31T00:00:00.000Z',
  expiresAt: '2026-08-31T00:05:00.000Z'
});
assert.match(message, /does not authorize a trade or transfer of funds/i);
assert.match(message, /never ask for your seed phrase or private key/i);

const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
assert.equal(verifySolanaMessageSignature({ walletAddress, message, signature }), true);
assert.equal(verifySolanaMessageSignature({ walletAddress, message: `${message}\nmodified`, signature }), false);

const other = crypto.generateKeyPairSync('ed25519');
const wrongSignature = crypto.sign(null, Buffer.from(message, 'utf8'), other.privateKey).toString('base64');
assert.equal(verifySolanaMessageSignature({ walletAddress, message, signature: wrongSignature }), false);
assert.throws(
  () => verifySolanaMessageSignature({ walletAddress, message, signature: Buffer.alloc(63).toString('base64') }),
  /invalid_signature/
);

console.log('wallet-auth regression: PASS');
