import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createDelegatedAuthorityIntent,
  activateDelegatedAuthority,
  getDelegatedAuthorityDecision,
  revokeDelegatedAuthority,
  MEMBER_DELEGATED_AUTHORITY_CONTRACT
} from '../services/api/src/member-delegated-authority.mjs';

const issued = new Date('2026-09-06T10:00:00.000Z');
const expires = new Date(issued.getTime() + 24 * 60 * 60_000);
const intent = createDelegatedAuthorityIntent({
  user_id: 'user-1',
  wallet_address: 'Wallet111111111111111111111111111111111111',
  max_notional_usdc_atomic: '20000000',
  max_daily_loss_usdc_atomic: '1000000',
  issued_at: issued,
  expires_at: expires
});
assert.equal(intent.status, 'PENDING_CONSENT');
assert.equal(intent.allowed_strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(intent.allowed_dex_pair, 'ORCA_RAYDIUM');
assert.equal(intent.min_net_edge_bps, 20);
assert.equal(intent.live_execution_authorized, false);
assert.equal(intent.private_key_stored, false);
assert.equal(intent.signer_material_stored, false);
assert.match(intent.consent_message, /You may revoke this authority at any time/);
assert.match(intent.consent_message_sha256, /^[a-f0-9]{64}$/);

const verifiedProof = {
  challenge_id: 'c1',
  ownership_verified: true,
  verified_wallet_address: intent.wallet_address,
  verified_authority_id: intent.authority_id,
  verified_message: intent.consent_message,
  verified_message_sha256: intent.consent_message_sha256,
  verified_at: new Date(issued.getTime() + 1000)
};

assert.throws(() => activateDelegatedAuthority(intent, { ...verifiedProof, ownership_verified: false }), /authority_wallet_consent_required/);
assert.throws(() => activateDelegatedAuthority(intent, { ...verifiedProof, verified_wallet_address: 'OtherWallet' }), /authority_verified_wallet_mismatch/);
assert.throws(() => activateDelegatedAuthority(intent, { ...verifiedProof, verified_message: `${intent.consent_message}\nchanged` }), /authority_verified_message_mismatch/);
assert.throws(() => activateDelegatedAuthority({ ...intent, max_notional_usdc_atomic: '99999999' }, verifiedProof), /authority_consent_payload_mutated/);

const active = activateDelegatedAuthority(intent, verifiedProof);
assert.equal(active.status, 'ACTIVE');

assert.deepEqual(getDelegatedAuthorityDecision(active, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '500000',
  expected_net_edge_bps: 20
}), {
  allowed: true,
  reason: 'AUTHORITY_SCOPE_VALID',
  live_execution_authorized: false,
  execution_submission_authorized: false
});

assert.equal(getDelegatedAuthorityDecision(active, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '20000001',
  realized_daily_loss_usdc_atomic: '0',
  expected_net_edge_bps: 25
}).reason, 'AUTHORITY_NOTIONAL_LIMIT');

assert.equal(getDelegatedAuthorityDecision(active, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '1000000',
  expected_net_edge_bps: 25
}).reason, 'AUTHORITY_DAILY_LOSS_LIMIT');

const zeroTolerance = { ...active, max_daily_loss_usdc_atomic: '0' };
assert.equal(getDelegatedAuthorityDecision(zeroTolerance, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '0',
  expected_net_edge_bps: 25
}).allowed, true);
assert.equal(getDelegatedAuthorityDecision(zeroTolerance, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '1',
  expected_net_edge_bps: 25
}).reason, 'AUTHORITY_DAILY_LOSS_LIMIT');

assert.equal(getDelegatedAuthorityDecision(active, {
  now: new Date(issued.getTime() + 2000),
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '0',
  expected_net_edge_bps: 19
}).reason, 'AUTHORITY_NET_EDGE_FLOOR');

assert.equal(getDelegatedAuthorityDecision(active, {
  now: expires,
  requested_notional_usdc_atomic: '10000000',
  realized_daily_loss_usdc_atomic: '0',
  expected_net_edge_bps: 25
}).reason, 'AUTHORITY_EXPIRED');

const revoked = revokeDelegatedAuthority(active, new Date(issued.getTime() + 3000));
assert.equal(revoked.status, 'REVOKED');
assert.equal(getDelegatedAuthorityDecision(revoked, {
  now: new Date(issued.getTime() + 4000),
  requested_notional_usdc_atomic: '10000000',
  expected_net_edge_bps: 25
}).reason, 'ACTIVE_AUTHORITY_REQUIRED');

const migration = fs.readFileSync(new URL('../migrations/026_member_delegated_authority.sql', import.meta.url), 'utf8');
assert.match(migration, /expire_member_delegated_authorities_before_write/);
assert.match(migration, /status = 'EXPIRED'/);
assert.match(migration, /expires_at <= now\(\)/);
assert.match(migration, /BEFORE INSERT OR UPDATE OF status/);

assert.equal(MEMBER_DELEGATED_AUTHORITY_CONTRACT.exact_consent_payload_required, true);
assert.equal(MEMBER_DELEGATED_AUTHORITY_CONTRACT.private_key_allowed, false);
assert.equal(MEMBER_DELEGATED_AUTHORITY_CONTRACT.seed_phrase_allowed, false);
assert.equal(MEMBER_DELEGATED_AUTHORITY_CONTRACT.transaction_submission_authorized, false);
assert.equal(MEMBER_DELEGATED_AUTHORITY_CONTRACT.live_execution_authorized, false);

console.log('Member delegated authority regression: PASS');
