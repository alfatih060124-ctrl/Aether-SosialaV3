import crypto from 'node:crypto';

const MIN_NET_EDGE_BPS = 20;
const MAX_AUTHORITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function atomic(value, code, { allowZero = false } = {}) {
  try {
    const parsed = BigInt(String(value));
    if (allowZero ? parsed < 0n : parsed <= 0n) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function date(value, code) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function buildDelegatedAuthorityConsentMessage({ authority_id, wallet_address, max_notional_usdc_atomic, max_daily_loss_usdc_atomic, expires_at }) {
  return [
    'AETHER AUTOTRADE DELEGATED AUTHORITY CONSENT',
    `Authority ID: ${text(authority_id, 'authority_id_required')}`,
    `Wallet: ${text(wallet_address, 'wallet_address_required')}`,
    'Strategy: TWO_LEG_ARBITRAGE',
    'DEX Pair: ORCA_RAYDIUM',
    `Minimum NET Edge: ${MIN_NET_EDGE_BPS} bps`,
    `Max Notional (USDC atomic): ${atomic(max_notional_usdc_atomic, 'max_notional_invalid')}`,
    `Max Daily Loss (USDC atomic): ${atomic(max_daily_loss_usdc_atomic, 'max_daily_loss_invalid', { allowZero: true })}`,
    `Expires At: ${date(expires_at, 'expires_at_invalid').toISOString()}`,
    '',
    'This consent records bounded Auto Trade authority only.',
    'It does not reveal or transfer your private key or seed phrase.',
    'LIVE execution remains disabled until separate production gates are satisfied.',
    'You may revoke this authority at any time.'
  ].join('\n');
}

export function createDelegatedAuthorityIntent({
  user_id,
  wallet_address,
  max_notional_usdc_atomic,
  max_daily_loss_usdc_atomic,
  issued_at = new Date(),
  expires_at
}) {
  const issued = date(issued_at, 'issued_at_invalid');
  const expires = date(expires_at, 'expires_at_invalid');
  const ttl = expires.getTime() - issued.getTime();
  if (ttl <= 0 || ttl > MAX_AUTHORITY_TTL_MS) throw new Error('authority_ttl_invalid');
  const authorityId = crypto.randomUUID();
  const intent = {
    authority_id: authorityId,
    user_id: text(user_id, 'user_id_required'),
    wallet_address: text(wallet_address, 'wallet_address_required'),
    authority_type: 'AUTOTRADE_SESSION',
    status: 'PENDING_CONSENT',
    max_notional_usdc_atomic: atomic(max_notional_usdc_atomic, 'max_notional_invalid').toString(),
    max_daily_loss_usdc_atomic: atomic(max_daily_loss_usdc_atomic, 'max_daily_loss_invalid', { allowZero: true }).toString(),
    allowed_strategy: 'TWO_LEG_ARBITRAGE',
    allowed_dex_pair: 'ORCA_RAYDIUM',
    min_net_edge_bps: MIN_NET_EDGE_BPS,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    live_execution_authorized: false,
    private_key_stored: false,
    signer_material_stored: false
  };
  const consentMessage = buildDelegatedAuthorityConsentMessage(intent);
  return Object.freeze({
    ...intent,
    consent_message: consentMessage,
    consent_message_sha256: sha256(consentMessage)
  });
}

export function activateDelegatedAuthority(intent, {
  challenge_id,
  ownership_verified,
  verified_wallet_address,
  verified_authority_id,
  verified_message,
  verified_message_sha256,
  verified_at = new Date()
} = {}) {
  if (!intent || intent.status !== 'PENDING_CONSENT') throw new Error('authority_not_pending_consent');
  if (ownership_verified !== true) throw new Error('authority_wallet_consent_required');

  const expectedMessage = buildDelegatedAuthorityConsentMessage(intent);
  const expectedHash = sha256(expectedMessage);
  if (intent.consent_message !== expectedMessage || intent.consent_message_sha256 !== expectedHash) {
    throw new Error('authority_consent_payload_mutated');
  }
  if (text(verified_wallet_address, 'authority_verified_wallet_required') !== intent.wallet_address) {
    throw new Error('authority_verified_wallet_mismatch');
  }
  if (text(verified_authority_id, 'authority_verified_id_required') !== intent.authority_id) {
    throw new Error('authority_verified_id_mismatch');
  }
  if (text(verified_message, 'authority_verified_message_required') !== expectedMessage) {
    throw new Error('authority_verified_message_mismatch');
  }
  if (text(verified_message_sha256, 'authority_verified_message_hash_required') !== expectedHash) {
    throw new Error('authority_verified_message_hash_mismatch');
  }

  const verified = date(verified_at, 'verified_at_invalid');
  if (verified >= new Date(intent.expires_at)) throw new Error('authority_expired');
  return Object.freeze({
    ...intent,
    status: 'ACTIVE',
    consent_challenge_id: text(challenge_id, 'challenge_id_required'),
    consent_verified_at: verified.toISOString(),
    activated_at: verified.toISOString(),
    live_execution_authorized: false,
    private_key_stored: false,
    signer_material_stored: false
  });
}

export function getDelegatedAuthorityDecision(authority, { now = new Date(), requested_notional_usdc_atomic, realized_daily_loss_usdc_atomic = '0', expected_net_edge_bps }) {
  if (!authority || authority.status !== 'ACTIVE') return Object.freeze({ allowed: false, reason: 'ACTIVE_AUTHORITY_REQUIRED', live_execution_authorized: false });
  const current = date(now, 'authority_now_invalid');
  if (current >= new Date(authority.expires_at)) return Object.freeze({ allowed: false, reason: 'AUTHORITY_EXPIRED', live_execution_authorized: false });
  const requested = atomic(requested_notional_usdc_atomic, 'requested_notional_invalid');
  const maxNotional = atomic(authority.max_notional_usdc_atomic, 'authority_max_notional_invalid');
  if (requested > maxNotional) return Object.freeze({ allowed: false, reason: 'AUTHORITY_NOTIONAL_LIMIT', live_execution_authorized: false });
  const dailyLoss = atomic(realized_daily_loss_usdc_atomic, 'realized_daily_loss_invalid', { allowZero: true });
  const maxDailyLoss = atomic(authority.max_daily_loss_usdc_atomic, 'authority_max_daily_loss_invalid', { allowZero: true });
  if ((maxDailyLoss === 0n && dailyLoss > 0n) || (maxDailyLoss > 0n && dailyLoss >= maxDailyLoss)) {
    return Object.freeze({ allowed: false, reason: 'AUTHORITY_DAILY_LOSS_LIMIT', live_execution_authorized: false });
  }
  const edge = Number(expected_net_edge_bps);
  if (!Number.isFinite(edge) || edge < Number(authority.min_net_edge_bps || MIN_NET_EDGE_BPS)) return Object.freeze({ allowed: false, reason: 'AUTHORITY_NET_EDGE_FLOOR', live_execution_authorized: false });
  if (authority.allowed_strategy !== 'TWO_LEG_ARBITRAGE' || authority.allowed_dex_pair !== 'ORCA_RAYDIUM') return Object.freeze({ allowed: false, reason: 'AUTHORITY_SCOPE_MISMATCH', live_execution_authorized: false });
  return Object.freeze({ allowed: true, reason: 'AUTHORITY_SCOPE_VALID', live_execution_authorized: false, execution_submission_authorized: false });
}

export function revokeDelegatedAuthority(authority, revoked_at = new Date()) {
  if (!authority || !['ACTIVE','PENDING_CONSENT'].includes(authority.status)) throw new Error('authority_not_revocable');
  const revoked = date(revoked_at, 'revoked_at_invalid');
  return Object.freeze({
    ...authority,
    status: 'REVOKED',
    revoked_at: revoked.toISOString(),
    live_execution_authorized: false,
    private_key_stored: false,
    signer_material_stored: false
  });
}

export const MEMBER_DELEGATED_AUTHORITY_CONTRACT = Object.freeze({
  authority_type: 'AUTOTRADE_SESSION',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  min_net_edge_bps: MIN_NET_EDGE_BPS,
  max_ttl_ms: MAX_AUTHORITY_TTL_MS,
  revocable: true,
  exact_consent_payload_required: true,
  private_key_allowed: false,
  seed_phrase_allowed: false,
  signer_material_stored: false,
  transaction_submission_authorized: false,
  live_execution_authorized: false
});
