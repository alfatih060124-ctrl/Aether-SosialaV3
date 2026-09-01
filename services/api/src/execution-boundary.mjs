import crypto from 'node:crypto';

const SIDES = new Set(['BUY', 'SELL']);
const STATES = Object.freeze(['CREATED','RISK_CHECKED','QUOTED','SIMULATED','AUTHORIZED','DISPATCHED','CONFIRMED','RECONCILED','REJECTED','FAILED']);
const TERMINAL = new Set(['RECONCILED','REJECTED','FAILED']);
const TRANSITIONS = Object.freeze({
  CREATED: new Set(['RISK_CHECKED','REJECTED','FAILED']),
  RISK_CHECKED: new Set(['QUOTED','REJECTED','FAILED']),
  QUOTED: new Set(['SIMULATED','REJECTED','FAILED']),
  SIMULATED: new Set(['AUTHORIZED','REJECTED','FAILED']),
  AUTHORIZED: new Set(['DISPATCHED','REJECTED','FAILED']),
  DISPATCHED: new Set(['CONFIRMED','FAILED']),
  CONFIRMED: new Set(['RECONCILED','FAILED']),
  RECONCILED: new Set(),
  REJECTED: new Set(),
  FAILED: new Set()
});
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SENSITIVE_CONTEXT_KEYS = new Set(['privatekey','secretkey','seedphrase','mnemonic','keypair','signingkey','signer']);

const text = (value, name, min = 1, max = 200) => {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
};
const uuid = (value, name) => {
  const s = text(value, name, 36, 36);
  if (!UUID.test(s)) throw new Error(`invalid_${name}`);
  return s;
};
const money = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) throw new Error(`invalid_${name}`);
  return Math.round(n * 1e6) / 1e6;
};
const bps = (value, name, min = 0, max = 10000) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
};

function decodedBase58ByteLength(value) {
  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return -1;
    decoded = decoded * 58n + BigInt(digit);
  }
  let significantBytes = 0;
  for (let current = decoded; current > 0n; current >>= 8n) significantBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  return leadingZeroBytes + significantBytes;
}

function solanaMint(value, name) {
  const mint = text(value, name, 32, 44);
  if (!BASE58.test(mint) || decodedBase58ByteLength(mint) !== 32) throw new Error(`invalid_${name}`);
  return mint;
}

function dateIso(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_${name}`);
  return date.toISOString();
}

function sanitizeContext(value, name = 'risk_context') {
  const visit = (node) => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`invalid_${name}`);
      return node;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') throw new Error(`invalid_${name}`);
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SENSITIVE_CONTEXT_KEYS.has(normalized)) throw new Error('signing_material_forbidden');
      out[key] = visit(child);
    }
    return out;
  };
  const clean = visit(value && typeof value === 'object' ? value : {});
  const serialized = JSON.stringify(clean);
  if (Buffer.byteLength(serialized, 'utf8') > 8192) throw new Error(`invalid_${name}`);
  return clean;
}

function sanitizeHookOutput(value, hookName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${hookName}_hook_output`);
  return sanitizeContext(value, `${hookName}_hook_output`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function executionIdempotencyPayload(intent) {
  return {
    schema_version:intent.schema_version,chain:intent.chain,network:intent.network,
    source_decision_id:intent.source_decision_id,signal_assessment_id:intent.signal_assessment_id,
    trader_id:intent.trader_id,follower_user_id:intent.follower_user_id,mandate_id:intent.mandate_id,
    token_mint:intent.token_mint,quote_mint:intent.quote_mint,side:intent.side,
    requested_amount_usd:intent.requested_amount_usd,max_slippage_bps:intent.max_slippage_bps,
    mode:intent.mode,source:intent.source
  };
}

function executionIdempotencyKey(intent) {
  return crypto.createHash('sha256').update(canonicalJson(executionIdempotencyPayload(intent))).digest('hex');
}

export function assertCanonicalExecutionIntent(intent = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('invalid_execution_intent');
  sanitizeContext(intent, 'execution_intent');
  if (intent.schema_version !== 2) throw new Error('unsupported_execution_intent_schema');
  if (intent.chain !== 'SOLANA' || intent.network !== 'mainnet-beta') throw new Error('invalid_execution_network');
  if (intent.mode !== 'SHADOW' || intent.live_execution_authorized !== false) throw new Error('execution_intent_fail_closed');
  uuid(intent.intent_id, 'intent_id');
  text(intent.source_decision_id, 'source_decision_id', 8, 200);
  if (intent.signal_assessment_id !== null && intent.signal_assessment_id !== undefined) text(intent.signal_assessment_id, 'signal_assessment_id');
  uuid(intent.trader_id, 'trader_id');
  const followerUserId = intent.follower_user_id === null || intent.follower_user_id === undefined ? null : uuid(intent.follower_user_id, 'follower_user_id');
  const mandateId = intent.mandate_id === null || intent.mandate_id === undefined ? null : uuid(intent.mandate_id, 'mandate_id');
  if (Boolean(followerUserId) !== Boolean(mandateId)) throw new Error('invalid_execution_mandate_link');
  solanaMint(intent.token_mint, 'token_mint');
  solanaMint(intent.quote_mint, 'quote_mint');
  if (!SIDES.has(intent.side)) throw new Error('invalid_execution_side');
  if (typeof intent.requested_amount_usd !== 'number' || money(intent.requested_amount_usd, 'requested_amount_usd') !== intent.requested_amount_usd) throw new Error('invalid_requested_amount_usd');
  if (typeof intent.max_slippage_bps !== 'number' || bps(intent.max_slippage_bps, 'max_slippage_bps', 1, 5000) !== intent.max_slippage_bps) throw new Error('invalid_max_slippage_bps');
  const createdAt = dateIso(intent.created_at, 'execution_created_at');
  const expiresAt = dateIso(intent.expires_at, 'execution_expires_at');
  if (createdAt !== intent.created_at || expiresAt !== intent.expires_at) throw new Error('non_canonical_execution_timestamp');
  const expiryWindow = Date.parse(expiresAt) - Date.parse(createdAt);
  if (expiryWindow < 1_000 || expiryWindow > 300_000) throw new Error('invalid_execution_expiry_window');
  sanitizeContext(intent.risk_context || {}, 'risk_context');
  text(intent.source, 'execution_source', 3, 80);
  const idempotencyKey = text(intent.idempotency_key, 'idempotency_key', 64, 64);
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey) || idempotencyKey !== executionIdempotencyKey(intent)) throw new Error('execution_idempotency_mismatch');
  return intent;
}

export function buildExecutionIntent(input = {}) {
  const side = String(input.side || '').toUpperCase();
  if (!SIDES.has(side)) throw new Error('invalid_execution_side');
  const mode = String(input.mode || '').toUpperCase();
  if (mode !== 'SHADOW') throw new Error('non_shadow_execution_intent_blocked');
  const followerUserId = input.follower_user_id ? uuid(input.follower_user_id, 'follower_user_id') : null;
  const mandateId = input.mandate_id ? uuid(input.mandate_id, 'mandate_id') : null;
  if (Boolean(followerUserId) !== Boolean(mandateId)) throw new Error('invalid_execution_mandate_link');

  const createdAt = dateIso(input.created_at ?? Date.now(), 'execution_created_at');
  const createdMs = Date.parse(createdAt);
  const ttlMs = Number(input.ttl_ms ?? 30_000);
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('invalid_execution_ttl_ms');
  const expiresAt = input.expires_at ? dateIso(input.expires_at, 'execution_expires_at') : new Date(createdMs + ttlMs).toISOString();
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= createdMs || expiresMs - createdMs > 300_000) throw new Error('invalid_execution_expiry_window');

  const intent = {
    schema_version: 2,
    intent_id: uuid(input.intent_id || crypto.randomUUID(), 'intent_id'),
    chain: 'SOLANA',
    network: 'mainnet-beta',
    source_decision_id: text(input.source_decision_id, 'source_decision_id', 8, 200),
    signal_assessment_id: input.signal_assessment_id ? text(input.signal_assessment_id, 'signal_assessment_id') : null,
    trader_id: uuid(input.trader_id, 'trader_id'),
    follower_user_id: followerUserId,
    mandate_id: mandateId,
    token_mint: solanaMint(input.token_mint, 'token_mint'),
    quote_mint: solanaMint(input.quote_mint || USDC_MINT, 'quote_mint'),
    side,
    requested_amount_usd: money(input.requested_amount_usd, 'requested_amount_usd'),
    max_slippage_bps: bps(input.max_slippage_bps ?? 100, 'max_slippage_bps', 1, 5000),
    mode: 'SHADOW',
    live_execution_authorized: false,
    created_at: createdAt,
    expires_at: expiresAt,
    risk_context: sanitizeContext(input.risk_context || {}),
    source: text(input.source || 'AUTO_TRADE_ENGINE', 'execution_source', 3, 80)
  };

  intent.idempotency_key = executionIdempotencyKey(intent);
  return intent;
}

export function transitionExecution(state, nextState, metadata = {}) {
  const current = String(state || '').toUpperCase();
  const next = String(nextState || '').toUpperCase();
  if (!STATES.includes(current) || !STATES.includes(next)) throw new Error('invalid_execution_state');
  if (!TRANSITIONS[current].has(next)) throw new Error('invalid_execution_transition');
  return { state: next, terminal: TERMINAL.has(next), metadata: sanitizeContext(metadata, 'transition_metadata'), transitioned_at: new Date().toISOString() };
}

export function assertRiskRecheck({ intent, risk = {}, now = Date.now() } = {}) {
  assertCanonicalExecutionIntent(intent);
  const reasons = [];
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs) || nowMs > Date.parse(intent.expires_at)) reasons.push('EXECUTION_INTENT_EXPIRED');
  if (risk.allowed !== true) reasons.push('RISK_POLICY_NOT_ALLOWED');
  if (intent.mandate_id && risk.mandate_active !== true) reasons.push('MANDATE_NOT_ACTIVE');
  if (risk.trader_verified !== true) reasons.push('TRADER_NOT_VERIFIED');
  if (risk.marketplace_published !== true) reasons.push('TRADER_NOT_PUBLISHED');
  if (risk.market_data_fresh !== true) reasons.push('MARKET_DATA_STALE_OR_UNVERIFIED');
  if (Number(risk.estimated_price_impact_bps ?? Infinity) > intent.max_slippage_bps) reasons.push('SLIPPAGE_LIMIT_EXCEEDED');
  return { passed: reasons.length === 0, reason_codes: reasons, live_execution_authorized: false };
}

export class ShadowDispatcher {
  constructor({ quoteHook, simulationHook, authorizationHook, confirmationHook, reconciliationHook } = {}) {
    this.quoteHook = quoteHook;
    this.simulationHook = simulationHook;
    this.authorizationHook = authorizationHook;
    this.confirmationHook = confirmationHook;
    this.reconciliationHook = reconciliationHook;
  }

  async dispatch(intent, { risk, now = Date.now() } = {}) {
    assertCanonicalExecutionIntent(intent);
    const trace = [{ state: 'CREATED', network_submission: false }];
    const riskCheck = assertRiskRecheck({ intent, risk, now });
    if (!riskCheck.passed) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:riskCheck.reason_codes,lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    trace.push({ state:'RISK_CHECKED', network_submission:false });

    const quote = sanitizeHookOutput(this.quoteHook ? await this.quoteHook(intent) : { ok:true, shadow:true }, 'quote');
    if (quote.ok !== true || quote.network_submission === true) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['QUOTE_REJECTED'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    trace.push({ state:'QUOTED', network_submission:false });

    const simulation = sanitizeHookOutput(this.simulationHook ? await this.simulationHook(intent, quote) : { ok:true, shadow:true }, 'simulation');
    if (simulation.ok !== true || simulation.network_submission === true) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['SIMULATION_REJECTED'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    trace.push({ state:'SIMULATED', network_submission:false });

    const authorization = sanitizeHookOutput(this.authorizationHook ? await this.authorizationHook(intent, simulation) : { ok:true, shadow:true, signer_required:false, live_execution_authorized:false }, 'authorization');
    if (authorization.ok !== true || authorization.signer_required === true || authorization.live_execution_authorized === true || authorization.network_submission === true) {
      return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['SHADOW_AUTHORIZATION_REJECTED'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    }
    trace.push({ state:'AUTHORIZED', network_submission:false });
    trace.push({ state:'DISPATCHED', channel:'SHADOW', network_submission:false });

    const confirmation = sanitizeHookOutput(this.confirmationHook ? await this.confirmationHook(intent) : { ok:true, shadow:true, signature:null }, 'confirmation');
    if (confirmation.signature) {
      return { intent_id:intent.intent_id,state:'FAILED',reason_codes:['SHADOW_CHAIN_SIGNATURE_FORBIDDEN'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    }
    if (confirmation.ok !== true || confirmation.network_submission === true) return { intent_id:intent.intent_id,state:'FAILED',reason_codes:['SHADOW_CONFIRMATION_FAILED'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    trace.push({ state:'CONFIRMED', channel:'SHADOW', network_submission:false });

    const reconciliation = sanitizeHookOutput(this.reconciliationHook ? await this.reconciliationHook(intent, confirmation) : { ok:true, shadow:true }, 'reconciliation');
    if (reconciliation.ok !== true || reconciliation.network_submission === true) return { intent_id:intent.intent_id,state:'FAILED',reason_codes:['SHADOW_RECONCILIATION_FAILED'],lifecycle:trace,execution_dispatched:false,network_submission:false,live_execution_authorized:false,signer_used:false };
    trace.push({ state:'RECONCILED', channel:'SHADOW', network_submission:false });

    return {
      intent_id:intent.intent_id,
      idempotency_key:intent.idempotency_key,
      state:'RECONCILED',
      lifecycle:trace,
      quote,simulation,authorization,confirmation,reconciliation,
      execution_dispatched:false,
      network_submission:false,
      live_execution_authorized:false,
      signer_used:false
    };
  }
}

export function createLiveDispatcherBoundary() {
  throw new Error('live_dispatcher_not_implemented');
}
