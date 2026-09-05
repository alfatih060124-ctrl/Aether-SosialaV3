import assert from 'node:assert/strict';
import {
  EXECUTION_PORT_CONTRACT,
  assertExecutionPortSet,
  assertDispatcherInterface,
  assertShadowPortResult,
  createShadowExecutionPorts,
  assertShadowDispatcherOutcome,
  describeFutureLiveDispatcherBoundary
} from '../services/api/src/execution-ports.mjs';

assert.equal(EXECUTION_PORT_CONTRACT.schema, 'aether.execution.ports.v1');
assert.equal(EXECUTION_PORT_CONTRACT.auto_trade_role, 'INTENT_PRODUCER_ONLY');
assert.equal(EXECUTION_PORT_CONTRACT.future_live_dispatcher.implemented, false);
assert.equal(EXECUTION_PORT_CONTRACT.future_live_dispatcher.requires_auto_trade_changes, false);

const basePorts = {
  quote: async () => ({ ok:true, shadow:true }),
  simulate: async () => ({ ok:true, shadow:true }),
  authorize: async () => ({ ok:true, shadow:true, signer_required:false, live_execution_authorized:false }),
  confirm: async () => ({ ok:true, shadow:true, signature:null }),
  reconcile: async () => ({ ok:true, shadow:true })
};

assert.equal(assertExecutionPortSet(basePorts), basePorts);
assert.throws(() => assertExecutionPortSet({ ...basePorts, submit: async()=>({}) }), /unsupported_execution_port:submit/);
assert.throws(() => assertExecutionPortSet({ ...basePorts, confirm: undefined }), /missing_execution_port:confirm/);
assert.throws(() => assertExecutionPortSet({ ...basePorts, signer: {} }), /signing_material_forbidden/);

const shadowPorts = createShadowExecutionPorts(basePorts);
for (const name of EXECUTION_PORT_CONTRACT.ports) {
  const out = await shadowPorts[name]({ intent_id:'test-intent' });
  assert.equal(out.execution_dispatched, false);
  assert.equal(out.network_submission, false);
  assert.equal(out.network_submission_authorized, false);
  assert.equal(out.live_execution_authorized, false);
  assert.equal(out.signer_required, false);
  assert.equal(out.signer_used, false);
}

assert.throws(() => assertShadowPortResult('authorize', { ok:true, live_execution_authorized:true }), /shadow_authorize_live_authorization_forbidden/);
assert.throws(() => assertShadowPortResult('authorize', { ok:true, signer_required:true }), /shadow_authorize_signer_forbidden/);
assert.throws(() => assertShadowPortResult('quote', { ok:true, network_submission:true }), /shadow_quote_network_submission_forbidden/);
assert.throws(() => assertShadowPortResult('confirm', { ok:true, signature:'fake-signature' }), /shadow_chain_signature_forbidden/);
assert.throws(() => assertShadowPortResult('reconcile', { ok:true, signing_key:'forbidden' }), /signing_material_forbidden/);

const shadowDispatcherShape = {
  interface_name:'aether.execution.dispatcher.v1',
  kind:'SHADOW',
  dispatch: async()=>({ execution_dispatched:false, network_submission:false, live_execution_authorized:false, signer_used:false })
};
assert.equal(assertDispatcherInterface(shadowDispatcherShape), shadowDispatcherShape);
assert.throws(() => assertDispatcherInterface({ ...shadowDispatcherShape, dispatch:null }), /missing_dispatch_method/);
assert.throws(() => assertDispatcherInterface({ ...shadowDispatcherShape, kind:'LIVE' }), /invalid_dispatcher_kind/);
assert.throws(() => assertDispatcherInterface({ ...shadowDispatcherShape, signer:{ publicKey:'forbidden' } }), /signing_material_forbidden/);

const outcome = {
  state:'RECONCILED', execution_dispatched:false, network_submission:false,
  live_execution_authorized:false, signer_used:false, signature:null
};
assert.equal(assertShadowDispatcherOutcome(outcome), outcome);
assert.throws(() => assertShadowDispatcherOutcome({ ...outcome, execution_dispatched:true }), /shadow_execution_dispatched_must_be_false/);
assert.throws(() => assertShadowDispatcherOutcome({ ...outcome, network_submission:true }), /shadow_network_submission_must_be_false/);
assert.throws(() => assertShadowDispatcherOutcome({ ...outcome, live_execution_authorized:true }), /shadow_live_execution_authorized_must_be_false/);
assert.throws(() => assertShadowDispatcherOutcome({ ...outcome, signer_used:true }), /shadow_signer_used_must_be_false/);
assert.throws(() => assertShadowDispatcherOutcome({ ...outcome, signature:'fake' }), /shadow_chain_signature_forbidden/);

const future = describeFutureLiveDispatcherBoundary();
assert.equal(future.kind, 'SOLANA_LIVE');
assert.equal(future.implementation, 'NOT_PRESENT');
assert.equal(future.auto_trade_contract, 'UNCHANGED_INTENT_PRODUCER');
assert.equal(future.signer_material_exposed_to_auto_trade, false);
assert.equal(future.live_execution_authorized, false);
assert.equal(future.network_submission_authorized, false);

console.log('execution port contract regression: PASS');
