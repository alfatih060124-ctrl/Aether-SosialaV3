import crypto from 'node:crypto';
import { assertCanonicalExecutionIntent, ShadowDispatcher } from './execution-boundary.mjs';

const OUTCOMES = new Set(['RECONCILED','REJECTED','FAILED']);
const CANONICAL_SHADOW_DISPATCHER = 'ShadowDispatcher';

function iso(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_${name}`);
  return date.toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertShadowResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_execution_dispatch_result');
  if (!OUTCOMES.has(result.state)) throw new Error('invalid_execution_dispatch_outcome');
  if (result.execution_dispatched !== false) throw new Error('shadow_execution_dispatch_flag_violation');
  if (result.network_submission !== false) throw new Error('shadow_network_submission_violation');
  if (result.live_execution_authorized !== false) throw new Error('shadow_live_authorization_violation');
  if (result.signer_used !== false) throw new Error('shadow_signer_violation');
  return result;
}

function assertCanonicalShadowDispatcher(dispatcher) {
  if (dispatcher !== CANONICAL_SHADOW_DISPATCHER) throw new Error('execution_audit_dispatcher_identity_violation');
  return dispatcher;
}

function assertDispatcherOptions(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('invalid_shadow_dispatcher_options');
  const allowed = new Set(['quoteHook','simulationHook','authorizationHook','confirmationHook','reconciliationHook']);
  const detached = {};
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw new Error('invalid_shadow_dispatcher_options');
    if (value !== undefined && typeof value !== 'function') throw new Error('invalid_shadow_dispatcher_options');
    if (typeof value === 'function') {
      // ShadowDispatcher invokes hooks as instance properties (`this.quoteHook(...)`).
      // Never expose that receiver to caller-provided hooks: otherwise a hook could
      // mutate `this.dispatch` and later execute an unaudited implementation while
      // the envelope still records the canonical ShadowDispatcher identity.
      detached[key] = (...args) => Reflect.apply(value, undefined, args);
    }
  }
  return Object.freeze(detached);
}

export function buildExecutionAuditEnvelope({ intent, result, started_at, completed_at, dispatcher = CANONICAL_SHADOW_DISPATCHER } = {}) {
  assertCanonicalExecutionIntent(intent);
  assertShadowResult(result);
  assertCanonicalShadowDispatcher(dispatcher);
  const startedAt = iso(started_at, 'execution_audit_started_at');
  const completedAt = iso(completed_at, 'execution_audit_completed_at');
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error('invalid_execution_audit_time_order');
  if (result.intent_id !== intent.intent_id) throw new Error('execution_audit_intent_mismatch');
  if (result.idempotency_key && result.idempotency_key !== intent.idempotency_key) throw new Error('execution_audit_idempotency_mismatch');

  const lifecycle = Array.isArray(result.lifecycle)
    ? result.lifecycle.map((entry, index) => ({
        sequence: index,
        state: String(entry?.state || ''),
        channel: entry?.channel ? String(entry.channel) : null,
        network_submission: entry?.network_submission === true
      }))
    : [];

  if (lifecycle.some(entry => entry.network_submission === true)) throw new Error('shadow_lifecycle_network_submission_violation');

  const payload = {
    schema_version: 1,
    intent_id: intent.intent_id,
    idempotency_key: intent.idempotency_key,
    source_decision_id: intent.source_decision_id,
    trader_id: intent.trader_id,
    follower_user_id: intent.follower_user_id,
    mandate_id: intent.mandate_id,
    dispatcher: CANONICAL_SHADOW_DISPATCHER,
    mode: 'SHADOW',
    outcome: result.state,
    reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.map(String).sort() : [],
    lifecycle,
    execution_dispatched: false,
    network_submission: false,
    live_execution_authorized: false,
    signer_used: false,
    started_at: startedAt,
    completed_at: completedAt
  };

  return {
    ...payload,
    audit_id: digest(payload),
    intent_digest: digest({
      schema_version: intent.schema_version,
      intent_id: intent.intent_id,
      idempotency_key: intent.idempotency_key,
      source_decision_id: intent.source_decision_id,
      trader_id: intent.trader_id,
      follower_user_id: intent.follower_user_id,
      mandate_id: intent.mandate_id,
      token_mint: intent.token_mint,
      quote_mint: intent.quote_mint,
      side: intent.side,
      requested_amount_usd: intent.requested_amount_usd,
      max_slippage_bps: intent.max_slippage_bps,
      mode: intent.mode,
      live_execution_authorized: intent.live_execution_authorized
    })
  };
}

export class AuditedShadowDispatcher {
  constructor({ dispatcher, dispatcherOptions, clock = () => Date.now() } = {}) {
    // Never accept a dispatcher instance here. Even a ShadowDispatcher subclass can
    // override dispatch() while still passing instanceof checks and then be falsely
    // recorded as the canonical ShadowDispatcher. Accept only detached hook options
    // and construct the concrete boundary implementation inside this trust boundary.
    if (dispatcher !== undefined) throw new Error('shadow_dispatcher_injection_forbidden');
    this.dispatcher = new ShadowDispatcher(assertDispatcherOptions(dispatcherOptions));
    this.clock = clock;
  }

  async dispatch(intent, context = {}) {
    assertCanonicalExecutionIntent(intent);
    const startedAt = iso(this.clock(), 'execution_audit_started_at');
    const result = await this.dispatcher.dispatch(intent, context);
    const completedAt = iso(this.clock(), 'execution_audit_completed_at');
    return {
      ...result,
      audit: buildExecutionAuditEnvelope({ intent, result, started_at: startedAt, completed_at: completedAt, dispatcher: CANONICAL_SHADOW_DISPATCHER })
    };
  }
}
