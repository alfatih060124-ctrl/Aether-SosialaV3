import crypto from 'node:crypto';

const base = process.env.AETHER_TEST_API || 'http://127.0.0.1:8080';
const adminToken = process.env.ADMIN_API_TOKEN || '';
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function adminHeaders() {
  assert(adminToken, 'ADMIN_API_TOKEN is required for trader/copy HTTP regression');
  return { authorization: `Bearer ${adminToken}` };
}

const execution = await request('/api/execution/status');
assert(execution.response.ok, 'execution status unavailable');
assert(execution.body.mode === 'SHADOW', 'execution mode must remain SHADOW');
assert(execution.body.live_enabled === false, 'LIVE must remain disabled');

const initialMarket = await request('/api/traders');
assert(initialMarket.response.ok, 'public trader list unavailable');
const copyTarget = (initialMarket.body.items || []).find(t => t.verified === true && t.mode === 'SHADOW');
assert(copyTarget?.trader_id, 'no verified SHADOW fixture trader available for copy mandate regression');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const walletAddress = encodeBase58(spki.subarray(spki.length - 32));

const loginChallengeResult = await request('/api/auth/challenge', {
  method: 'POST',
  body: JSON.stringify({ wallet_address: walletAddress, purpose: 'LOGIN' }),
});
assert(loginChallengeResult.response.status === 201, `login challenge failed: ${loginChallengeResult.response.status}`);
const loginChallenge = loginChallengeResult.body.challenge;
const loginSignature = crypto.sign(null, Buffer.from(loginChallenge.message, 'utf8'), privateKey).toString('base64');

const login = await request('/api/auth/verify', {
  method: 'POST',
  body: JSON.stringify({
    challenge_id: loginChallenge.challenge_id,
    wallet_address: walletAddress,
    signature: loginSignature,
    signature_encoding: 'base64',
    consents: [
      { type: 'TERMS', version: 'integration-v1' },
      { type: 'RISK_DISCLOSURE', version: 'integration-v1' },
      { type: 'FEE_DISCLOSURE', version: 'integration-v1' },
    ],
  }),
});
assert(login.response.status === 200, `wallet login failed: ${login.response.status}`);
const sessionToken = login.body.session?.token;
assert(sessionToken, 'session token missing');
const sessionHeaders = { authorization: `Bearer ${sessionToken}` };

const traderChallengeResult = await request('/api/account/trader/challenge', {
  method: 'POST',
  headers: sessionHeaders,
  body: '{}',
});
assert(traderChallengeResult.response.status === 201, `trader challenge failed: ${traderChallengeResult.response.status}`);
const traderChallenge = traderChallengeResult.body.challenge;
assert(traderChallenge?.purpose === 'BECOME_TRADER', 'trader challenge purpose mismatch');
assert(traderChallenge?.funds_authorized === false, 'trader ownership challenge must not authorize funds');
const traderSignature = crypto.sign(null, Buffer.from(traderChallenge.message, 'utf8'), privateKey).toString('base64');

const traderApply = await request('/api/account/trader/apply', {
  method: 'POST',
  headers: sessionHeaders,
  body: JSON.stringify({
    challenge_id: traderChallenge.challenge_id,
    wallet_address: walletAddress,
    signature: traderSignature,
    signature_encoding: 'base64',
    display_name: 'Integration Trader',
    strategy_summary: 'Integration-only SHADOW strategy used to validate trader verification and publication gates.',
    bio: 'Automated regression fixture. No live trading authority.',
  }),
});
assert(traderApply.response.status === 201, `trader application failed: ${traderApply.response.status}`);
const ownedTrader = traderApply.body.trader;
assert(ownedTrader?.onboarding_status === 'PENDING', 'new trader onboarding must start PENDING');
assert(ownedTrader?.verification_status === 'PENDING_DATA', 'new trader verification must start PENDING_DATA');
assert(ownedTrader?.published === false, 'new trader must not auto-publish');
assert(ownedTrader?.verified === false, 'new trader must not auto-verify');
assert(ownedTrader?.mode === 'SHADOW', 'new trader must remain SHADOW');
assert(traderApply.body.live_execution_authorized === false, 'trader application must not authorize LIVE');

const traderId = ownedTrader.trader_id;
const review = await request(`/api/admin/traders/${encodeURIComponent(traderId)}/review`, {
  method: 'PATCH',
  headers: adminHeaders(),
  body: JSON.stringify({ decision: 'APPROVE', review_note: 'Integration onboarding approval only.' }),
});
assert(review.response.status === 200, `admin onboarding review failed: ${review.response.status}`);
assert(review.body.trader?.onboarding_status === 'APPROVED', 'trader onboarding was not approved');
assert(review.body.trader?.verification_status === 'PENDING_DATA', 'onboarding approval must not auto-verify data');
assert(review.body.trader?.published === false, 'onboarding approval must not auto-publish');
assert(review.body.publication_authorized === false, 'onboarding review must not authorize publication');

const prematurePublish = await request(`/api/admin/traders/${encodeURIComponent(traderId)}/publication`, {
  method: 'PATCH',
  headers: adminHeaders(),
  body: JSON.stringify({ published: true }),
});
assert(prematurePublish.response.status === 409, `premature publication should be 409, got ${prematurePublish.response.status}`);
assert(prematurePublish.body.error === 'trader_publication_gate_failed', 'premature publication gate error mismatch');

const observedAt = new Date(Date.now() - 60_000).toISOString();
const evidenceCreate = await request(`/api/admin/traders/${encodeURIComponent(traderId)}/evidence`, {
  method: 'POST',
  headers: adminHeaders(),
  body: JSON.stringify({
    source_type: 'INTERNAL_RECONCILIATION',
    source_reference: `integration://verified-history/${traderId}`,
    observed_at: observedAt,
    trades_count: 25,
    total_return_bps: 1200,
    win_rate_bps: 6000,
    drawdown_bps: 500,
    reputation_score: 80,
    review_note: 'Deterministic integration evidence fixture.',
  }),
});
assert(evidenceCreate.response.status === 201, `verification evidence recording failed: ${evidenceCreate.response.status}`);
const evidence = evidenceCreate.body.evidence;
assert(evidence?.evidence_status === 'RECORDED', 'evidence must begin RECORDED');
assert(evidenceCreate.body.publication_authorized === false, 'recording evidence must not authorize publication');

const verification = await request(`/api/admin/traders/${encodeURIComponent(traderId)}/verification`, {
  method: 'PATCH',
  headers: adminHeaders(),
  body: JSON.stringify({
    decision: 'VERIFY',
    evidence_id: evidence.evidence_id,
    review_note: 'Integration verification passed.',
  }),
});
assert(verification.response.status === 200, `trader verification failed: ${verification.response.status}`);
assert(verification.body.trader?.verification_status === 'VERIFIED', 'trader data not marked VERIFIED');
assert(verification.body.trader?.verified === true, 'trader verified flag not set');
assert(verification.body.trader?.published === false, 'verification must not auto-publish');
assert(verification.body.publication_authorized === false, 'verification must not auto-authorize publication');
assert(verification.body.publication_requires_explicit_action === true, 'explicit publication action must remain required');

const publish = await request(`/api/admin/traders/${encodeURIComponent(traderId)}/publication`, {
  method: 'PATCH',
  headers: adminHeaders(),
  body: JSON.stringify({ published: true, review_note: 'Integration publication after verified evidence.' }),
});
assert(publish.response.status === 200, `verified trader publication failed: ${publish.response.status}`);
assert(publish.body.trader?.published === true, 'verified trader was not published');
assert(publish.body.trader?.mode === 'SHADOW', 'published trader must remain SHADOW');
assert(publish.body.live_execution_authorized === false, 'publication must not authorize LIVE');

const publicTrader = await request(`/api/traders/${encodeURIComponent(traderId)}`);
assert(publicTrader.response.status === 200, `published trader not publicly readable: ${publicTrader.response.status}`);
assert(publicTrader.body.verified === true, 'public trader must be verified');
assert(publicTrader.body.mode === 'SHADOW', 'public trader must remain SHADOW');
assert(publicTrader.body.verification_source === 'INTERNAL_RECONCILIATION', 'public verification source missing');
assert(!Object.prototype.hasOwnProperty.call(publicTrader.body, 'owner_user_id'), 'public trader must not expose owner_user_id');

const selfCopy = await request('/api/account/copy-mandates', {
  method: 'POST',
  headers: sessionHeaders,
  body: JSON.stringify({
    trader_id: traderId,
    max_copy_amount_usd: 10,
    max_position_amount_usd: 50,
    allocation_bps: 1000,
    max_slippage_bps: 100,
    max_daily_loss_bps: 300,
    stop_drawdown_bps: 1500,
  }),
});
assert(selfCopy.response.status === 403, `self-copy should be 403, got ${selfCopy.response.status}`);
assert(selfCopy.body.error === 'self_copy_not_allowed', 'self-copy error mismatch');

const mandateCreate = await request('/api/account/copy-mandates', {
  method: 'POST',
  headers: sessionHeaders,
  body: JSON.stringify({
    trader_id: copyTarget.trader_id,
    max_copy_amount_usd: 25,
    max_position_amount_usd: 100,
    allocation_bps: 1000,
    max_slippage_bps: 100,
    max_daily_loss_bps: 300,
    stop_drawdown_bps: 1500,
  }),
});
assert(mandateCreate.response.status === 201, `copy mandate creation failed: ${mandateCreate.response.status}`);
const mandate = mandateCreate.body.mandate;
assert(mandate?.status === 'ACTIVE' && mandate?.enabled === true, 'new copy mandate must be ACTIVE');
assert(mandate?.mode === 'SHADOW', 'copy mandate must be SHADOW');
assert(mandate?.live_execution_authorized === false, 'copy mandate must never authorize LIVE');
assert(mandateCreate.body.live_execution_authorized === false, 'copy API response must keep LIVE unauthorized');

const mandateId = mandate.policy_id;
const adminForceLive = await request(`/api/admin/copy-policies/${encodeURIComponent(mandateId)}`, {
  method: 'PATCH',
  headers: adminHeaders(),
  body: JSON.stringify({ enabled: true, mode: 'LIVE', live_execution_authorized: true }),
});
assert(adminForceLive.response.status === 200, `admin copy policy update failed: ${adminForceLive.response.status}`);
assert(adminForceLive.body.mode === 'SHADOW', 'admin must not be able to set copy policy mode LIVE');
assert(adminForceLive.body.live_execution_authorized === false, 'admin must not be able to authorize LIVE on copy policy');

for (const [action, expectedStatus, expectedEnabled] of [
  ['PAUSE', 'PAUSED', false],
  ['RESUME', 'ACTIVE', true],
  ['CANCEL', 'CANCELLED', false],
]) {
  const changed = await request(`/api/account/copy-mandates/${encodeURIComponent(mandateId)}`, {
    method: 'PATCH',
    headers: sessionHeaders,
    body: JSON.stringify({ action }),
  });
  assert(changed.response.status === 200, `${action} copy mandate failed: ${changed.response.status}`);
  assert(changed.body.mandate?.status === expectedStatus, `${action} status mismatch`);
  assert(changed.body.mandate?.enabled === expectedEnabled, `${action} enabled mismatch`);
  assert(changed.body.mandate?.mode === 'SHADOW', `${action} changed mandate out of SHADOW`);
  assert(changed.body.mandate?.live_execution_authorized === false, `${action} authorized LIVE`);
}

const resumeCancelled = await request(`/api/account/copy-mandates/${encodeURIComponent(mandateId)}`, {
  method: 'PATCH',
  headers: sessionHeaders,
  body: JSON.stringify({ action: 'RESUME' }),
});
assert(resumeCancelled.response.status === 409, `cancelled mandate resume should be 409, got ${resumeCancelled.response.status}`);
assert(resumeCancelled.body.error === 'copy_mandate_cancelled', 'cancelled mandate resume error mismatch');

const ownedMandates = await request('/api/account/copy-mandates', { headers: sessionHeaders });
assert(ownedMandates.response.status === 200, 'owned copy mandates unavailable');
const storedMandate = (ownedMandates.body.items || []).find(item => item.policy_id === mandateId);
assert(storedMandate?.status === 'CANCELLED', 'cancelled mandate missing from follower history');
assert(storedMandate?.mode === 'SHADOW' && storedMandate?.live_execution_authorized === false, 'stored mandate lost SHADOW/live fence');

const adminMandates = await request('/api/admin/copy-policies', { headers: adminHeaders() });
assert(adminMandates.response.status === 200, 'admin copy policy list unavailable');
const adminMandate = (adminMandates.body.items || []).find(item => item.policy_id === mandateId);
assert(adminMandate?.mode === 'SHADOW' && adminMandate?.live_execution_authorized === false, 'admin copy policy view lost SHADOW/live fence');
assert(adminMandates.body.live_execution_authorized === false, 'admin copy policy API must report LIVE unauthorized');

const finalExecution = await request('/api/execution/status');
assert(finalExecution.body.mode === 'SHADOW' && finalExecution.body.live_enabled === false, 'LIVE posture changed during trader/copy test');

console.log('Trader verification + copy mandate HTTP regression: PASS');
console.log('wallet trader ownership -> admin onboarding -> evidence -> verify -> explicit publication -> follower SHADOW mandate lifecycle');
console.log('self-copy blocked; admin cannot force copy policy LIVE; LIVE remained disabled');
