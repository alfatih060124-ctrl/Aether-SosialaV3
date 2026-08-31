import crypto from 'node:crypto';

const SIDES = new Set(['BUY','SELL']);
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
  RECONCILED: new Set(), REJECTED: new Set(), FAILED: new Set()
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, name, min=1, max=200) => {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new Error(`invalid_${name}`);
  return s;
};
const uuid = (value, name) => {
  const s = text(value, name, 36, 36);
  if (!UUID_PATTERN.test(s)) throw new Error(`invalid_${name}`);
  return s.toLowerCase();
};
const money = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) throw new Error(`invalid_${name}`);
  return Math.round(n * 1e6) / 1e6;
};
const bps = (value, name, min=0, max=10000) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid_${name}`);
  return n;
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function buildExecutionIntent(input = {}) {
  const side = String(input.side || '').toUpperCase();
  if (!SIDES.has(side)) throw new Error('invalid_execution_side');
  const mode = String(input.mode || 'SHADOW').toUpperCase();
  if (mode !== 'SHADOW') throw new Error('non_shadow_execution_intent_blocked');
  const intent = {
    schema_version: 1,
    intent_id: uuid(input.intent_id || crypto.randomUUID(), 'intent_id'),
    trader_id: uuid(input.trader_id, 'trader_id'),
    follower_user_id: input.follower_user_id ? uuid(input.follower_user_id, 'follower_user_id') : null,
    mandate_id: input.mandate_id ? uuid(input.mandate_id, 'mandate_id') : null,
    signal_assessment_id: input.signal_assessment_id ? text(input.signal_assessment_id, 'signal_assessment_id') : null,
    token_mint: text(input.token_mint, 'token_mint', 8, 100),
    quote_mint: text(input.quote_mint || 'USDC', 'quote_mint', 2, 100),
    side,
    requested_amount_usd: money(input.requested_amount_usd, 'requested_amount_usd'),
    max_slippage_bps: bps(input.max_slippage_bps ?? 100, 'max_slippage_bps', 1, 5000),
    mode: 'SHADOW',
    live_execution_authorized: false,
    created_at: new Date(input.created_at || Date.now()).toISOString(),
    risk_context: input.risk_context && typeof input.risk_context === 'object' ? input.risk_context : {},
    source: text(input.source || 'AUTO_TRADE_ENGINE', 'execution_source', 3, 80)
  };
  if (Number.isNaN(Date.parse(intent.created_at))) throw new Error('invalid_execution_created_at');
  intent.idempotency_key = crypto.createHash('sha256').update(canonicalJson({
    trader_id:intent.trader_id,follower_user_id:intent.follower_user_id,mandate_id:intent.mandate_id,
    signal_assessment_id:intent.signal_assessment_id,token_mint:intent.token_mint,quote_mint:intent.quote_mint,
    side:intent.side,requested_amount_usd:intent.requested_amount_usd,max_slippage_bps:intent.max_slippage_bps,
    mode:intent.mode,source:intent.source
  })).digest('hex');
  return intent;
}

export function transitionExecution(state, nextState, metadata = {}) {
  const current = String(state || '').toUpperCase();
  const next = String(nextState || '').toUpperCase();
  if (!STATES.includes(current) || !STATES.includes(next)) throw new Error('invalid_execution_state');
  if (!TRANSITIONS[current].has(next)) throw new Error('invalid_execution_transition');
  return { state: next, terminal: TERMINAL.has(next), metadata: { ...metadata }, transitioned_at: new Date().toISOString() };
}

export function assertRiskRecheck({ intent, risk = {} } = {}) {
  if (!intent || intent.mode !== 'SHADOW' || intent.live_execution_authorized !== false) throw new Error('execution_intent_fail_closed');
  const reasons = [];
  if (risk.allowed !== true) reasons.push('RISK_POLICY_NOT_ALLOWED');
  if (risk.mandate_active !== true) reasons.push('MANDATE_NOT_ACTIVE');
  if (risk.trader_verified !== true) reasons.push('TRADER_NOT_VERIFIED');
  if (risk.marketplace_published !== true) reasons.push('TRADER_NOT_PUBLISHED');
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

  async dispatch(intent, { risk } = {}) {
    const riskCheck = assertRiskRecheck({ intent, risk });
    if (!riskCheck.passed) return { intent_id:intent.intent_id, state:'REJECTED', reason_codes:riskCheck.reason_codes, execution_dispatched:false, live_execution_authorized:false };
    const quote = this.quoteHook ? await this.quoteHook(intent) : { ok:true, shadow:true };
    if (quote?.ok !== true) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['QUOTE_REJECTED'],execution_dispatched:false,live_execution_authorized:false };
    const simulation = this.simulationHook ? await this.simulationHook(intent, quote) : { ok:true, shadow:true };
    if (simulation?.ok !== true) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['SIMULATION_REJECTED'],execution_dispatched:false,live_execution_authorized:false };
    const authorization = this.authorizationHook ? await this.authorizationHook(intent, simulation) : { ok:true, shadow:true, signer_required:false };
    if (authorization?.ok !== true || authorization?.signer_required === true) return { intent_id:intent.intent_id,state:'REJECTED',reason_codes:['SHADOW_AUTHORIZATION_REJECTED'],execution_dispatched:false,live_execution_authorized:false };
    const confirmation = this.confirmationHook ? await this.confirmationHook(intent) : { ok:true, shadow:true, signature:null };
    const reconciliation = this.reconciliationHook ? await this.reconciliationHook(intent, confirmation) : { ok:true, shadow:true };
    return {
      intent_id:intent.intent_id,
      idempotency_key:intent.idempotency_key,
      state: reconciliation?.ok === true ? 'RECONCILED' : 'FAILED',
      quote, simulation, authorization, confirmation, reconciliation,
      execution_dispatched:false,
      live_execution_authorized:false,
      signer_used:false
    };
  }
}

export function createLiveDispatcherBoundary() {
  throw new Error('live_dispatcher_not_implemented');
}
