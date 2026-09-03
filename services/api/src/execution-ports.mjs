const PORT_NAMES = Object.freeze(['quote','simulate','authorize','confirm','reconcile']);
const FORBIDDEN_KEYS = new Set(['privatekey','secretkey','seedphrase','mnemonic','keypair','signingkey','signer']);

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNoSigningMaterial(value, path = 'value') {
  const visit = (node, currentPath) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(normalizeKey(key))) throw new Error(`signing_material_forbidden:${currentPath}.${key}`);
      visit(child, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
  return value;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${name}`);
  return value;
}

export const EXECUTION_PORT_CONTRACT = Object.freeze({
  schema: 'aether.execution.ports.v1',
  dispatcher_interface: 'aether.execution.dispatcher.v1',
  ports: PORT_NAMES,
  auto_trade_role: 'INTENT_PRODUCER_ONLY',
  shadow: Object.freeze({
    mode: 'SHADOW',
    execution_dispatched: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    signer_required: false,
    chain_signature_allowed: false
  }),
  future_live_dispatcher: Object.freeze({
    interface_name: 'SolanaLiveDispatcher',
    implemented: false,
    requires_auto_trade_changes: false
  })
});

export function assertExecutionPortSet(ports = {}) {
  assertObject(ports, 'execution_ports');
  assertNoSigningMaterial(ports, 'execution_ports');
  for (const name of PORT_NAMES) {
    if (typeof ports[name] !== 'function') throw new Error(`missing_execution_port:${name}`);
  }
  for (const key of Object.keys(ports)) {
    if (!PORT_NAMES.includes(key)) throw new Error(`unsupported_execution_port:${key}`);
  }
  return ports;
}

export function assertDispatcherInterface(dispatcher = {}) {
  assertObject(dispatcher, 'execution_dispatcher');
  assertNoSigningMaterial(dispatcher, 'execution_dispatcher');
  if (typeof dispatcher.dispatch !== 'function') throw new Error('missing_dispatch_method');
  if (dispatcher.interface_name !== EXECUTION_PORT_CONTRACT.dispatcher_interface) throw new Error('invalid_dispatcher_interface');
  if (!['SHADOW','SOLANA_LIVE'].includes(dispatcher.kind)) throw new Error('invalid_dispatcher_kind');
  return dispatcher;
}

export function assertShadowPortResult(portName, result = {}) {
  if (!PORT_NAMES.includes(portName)) throw new Error('invalid_execution_port_name');
  assertObject(result, `${portName}_result`);
  assertNoSigningMaterial(result, `${portName}_result`);
  if (result.network_submission === true || result.network_submission_authorized === true) throw new Error(`shadow_${portName}_network_submission_forbidden`);
  if (result.live_execution_authorized === true) throw new Error(`shadow_${portName}_live_authorization_forbidden`);
  if (result.signer_required === true || result.signer_used === true) throw new Error(`shadow_${portName}_signer_forbidden`);
  if (portName === 'confirm' && result.signature) throw new Error('shadow_chain_signature_forbidden');
  return {
    ...result,
    execution_dispatched: false,
    network_submission: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    signer_required: false,
    signer_used: false
  };
}

export function createShadowExecutionPorts(ports = {}) {
  const checked = assertExecutionPortSet(ports);
  return Object.freeze(Object.fromEntries(PORT_NAMES.map((name) => [name, async (...args) => {
    const result = await checked[name](...args);
    return assertShadowPortResult(name, result);
  }])));
}

export function assertShadowDispatcherOutcome(outcome = {}) {
  assertObject(outcome, 'shadow_dispatcher_outcome');
  assertNoSigningMaterial(outcome, 'shadow_dispatcher_outcome');
  if (outcome.execution_dispatched !== false) throw new Error('shadow_execution_dispatched_must_be_false');
  if (outcome.network_submission !== false) throw new Error('shadow_network_submission_must_be_false');
  if (outcome.live_execution_authorized !== false) throw new Error('shadow_live_execution_authorized_must_be_false');
  if (outcome.signer_used !== false) throw new Error('shadow_signer_used_must_be_false');
  if (outcome.signature) throw new Error('shadow_chain_signature_forbidden');
  return outcome;
}

export function describeFutureLiveDispatcherBoundary() {
  return {
    interface_name: EXECUTION_PORT_CONTRACT.dispatcher_interface,
    kind: 'SOLANA_LIVE',
    implementation: 'NOT_PRESENT',
    auto_trade_contract: 'UNCHANGED_INTENT_PRODUCER',
    signer_material_exposed_to_auto_trade: false,
    live_execution_authorized: false,
    network_submission_authorized: false
  };
}
