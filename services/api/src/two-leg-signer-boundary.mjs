const STRATEGY = 'TWO_LEG_ARBITRAGE';
const DEX_PAIR = 'ORCA_RAYDIUM';
const MIN_NET_EDGE_BPS = 20;

function text(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function toUsdcAtomic(value, code) {
  const raw = text(value, code);
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error(code);
  const [whole, fraction = ''] = raw.split('.');
  const atomic = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  if (atomic <= 0n) throw new Error(code);
  return atomic;
}

function requireDecision(decision) {
  if (!decision || typeof decision !== 'object') throw new Error('two_leg_signer_decision_required');
  if (decision.strategy !== STRATEGY || decision.dex_pair !== DEX_PAIR || decision.action !== 'ARBITRAGE_SETTLE') {
    throw new Error('two_leg_signer_decision_scope_invalid');
  }
  if (decision.qualified !== true || decision.risk_verified !== true || decision.costs_verified !== true || decision.freshness_verified !== true) {
    throw new Error('two_leg_signer_decision_not_verified');
  }
  const edge = Number(decision.expected_net_edge_bps);
  if (!Number.isFinite(edge) || edge < MIN_NET_EDGE_BPS) throw new Error('two_leg_signer_net_edge_below_floor');
  const buyDex = text(decision.buy_dex, 'two_leg_signer_buy_dex_required').toUpperCase();
  const sellDex = text(decision.sell_dex, 'two_leg_signer_sell_dex_required').toUpperCase();
  if (!['ORCA', 'RAYDIUM'].includes(buyDex) || !['ORCA', 'RAYDIUM'].includes(sellDex) || buyDex === sellDex) {
    throw new Error('two_leg_signer_route_invalid');
  }
  return Object.freeze({
    ...decision,
    token_mint: text(decision.token_mint, 'two_leg_signer_token_mint_required'),
    quote_mint: text(decision.quote_mint, 'two_leg_signer_quote_mint_required'),
    notional_usdc_atomic: toUsdcAtomic(decision.notional_usdc, 'two_leg_signer_notional_invalid'),
    buy_dex: buyDex,
    sell_dex: sellDex,
    expected_net_edge_bps: edge
  });
}

function requirePreflight(preflight, decision) {
  if (!preflight || typeof preflight !== 'object') throw new Error('two_leg_signer_preflight_required');
  if (preflight.schema !== 'aether.two_leg_atomic_preflight.v1' || preflight.strategy !== STRATEGY || preflight.dex_pair !== DEX_PAIR) {
    throw new Error('two_leg_signer_preflight_scope_invalid');
  }
  if (preflight.preflight_verified !== true || preflight.simulation_ok !== true || preflight.atomic !== true || Number(preflight.leg_count) !== 2) {
    throw new Error('two_leg_signer_preflight_not_verified');
  }
  if (preflight.transaction_signing_authorized === true || preflight.network_submission_authorized === true || preflight.fund_movement_authorized === true || preflight.live_execution_authorized === true) {
    throw new Error('two_leg_signer_preflight_safety_boundary_violation');
  }
  const transactionHash = text(preflight.transaction_hash, 'two_leg_signer_transaction_hash_required');
  if (preflight.token_mint && preflight.token_mint !== decision.token_mint) throw new Error('two_leg_signer_preflight_token_mint_mismatch');
  if (preflight.quote_mint && preflight.quote_mint !== decision.quote_mint) throw new Error('two_leg_signer_preflight_quote_mint_mismatch');
  return Object.freeze({ ...preflight, transaction_hash: transactionHash });
}

function requireAuthority(authority, decision, now) {
  if (!authority || typeof authority !== 'object' || authority.status !== 'ACTIVE') throw new Error('two_leg_signer_active_authority_required');
  if (authority.allowed_strategy !== STRATEGY || authority.allowed_dex_pair !== DEX_PAIR) throw new Error('two_leg_signer_authority_scope_mismatch');
  if (authority.live_execution_authorized === true || authority.private_key_stored === true || authority.signer_material_stored === true) {
    throw new Error('two_leg_signer_authority_safety_boundary_violation');
  }
  const expiresAt = Date.parse(text(authority.expires_at, 'two_leg_signer_authority_expiry_required'));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('two_leg_signer_authority_expired');
  const maxNotional = BigInt(text(authority.max_notional_usdc_atomic, 'two_leg_signer_authority_notional_required'));
  if (maxNotional < decision.notional_usdc_atomic) throw new Error('two_leg_signer_authority_notional_limit');
  const minEdge = Number(authority.min_net_edge_bps);
  if (!Number.isFinite(minEdge) || decision.expected_net_edge_bps < Math.max(MIN_NET_EDGE_BPS, minEdge)) {
    throw new Error('two_leg_signer_authority_net_edge_floor');
  }
  return Object.freeze({
    authority_id: text(authority.authority_id, 'two_leg_signer_authority_id_required'),
    wallet_address: text(authority.wallet_address, 'two_leg_signer_wallet_required')
  });
}

function requireSignerGate(gateState) {
  if (!gateState || typeof gateState !== 'object') throw new Error('two_leg_signer_gate_state_required');
  const executionMode = String(gateState.execution_mode || '').toUpperCase();
  if (executionMode !== 'LIVE') throw new Error('two_leg_signer_execution_mode_not_live');
  if (gateState.live_enabled !== true) throw new Error('two_leg_signer_live_disabled');
  if (gateState.readiness_passed !== true) throw new Error('two_leg_signer_readiness_not_passed');
  if (gateState.admin_live_approved !== true) throw new Error('two_leg_signer_admin_not_approved');
  if (gateState.signer_unlocked !== true) throw new Error('two_leg_signer_locked');
  if (gateState.emergency_kill_switch !== false) throw new Error('two_leg_signer_emergency_kill_switch_active');
  return true;
}

export async function authorizeTwoLegSignerRequest({
  decision,
  preflight,
  authority,
  gateState,
  unsignedTransactionBase64,
  auditWrite,
  now = Date.now()
} = {}) {
  if (typeof auditWrite !== 'function') throw new Error('two_leg_signer_audit_writer_required');
  let phase = 'VALIDATION';
  try {
    const checkedDecision = requireDecision(decision);
    const checkedPreflight = requirePreflight(preflight, checkedDecision);
    const checkedAuthority = requireAuthority(authority, checkedDecision, now);
    requireSignerGate(gateState);
    const unsignedTransaction = text(unsignedTransactionBase64, 'two_leg_signer_unsigned_transaction_required');

    phase = 'SIGNER_REQUEST_AUTHORIZATION';
    const request = Object.freeze({
      schema: 'aether.two_leg_signer_request.v1',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      atomic: true,
      leg_count: 2,
      transaction_hash: checkedPreflight.transaction_hash,
      unsigned_transaction_base64: unsignedTransaction,
      authority_id: checkedAuthority.authority_id,
      wallet_address: checkedAuthority.wallet_address,
      token_mint: checkedDecision.token_mint,
      quote_mint: checkedDecision.quote_mint,
      notional_usdc: String(decision.notional_usdc),
      buy_dex: checkedDecision.buy_dex,
      sell_dex: checkedDecision.sell_dex,
      signer_request_authorized: true,
      transaction_signing_performed: false,
      private_key_requested: false,
      seed_phrase_requested: false,
      network_submission_authorized: false,
      network_submission_performed: false,
      fund_movement_authorized: false,
      live_execution_authorized: false
    });

    await auditWrite({
      event_type: 'TWO_LEG_SIGNER_REQUEST_AUTHORIZED',
      authority_id: request.authority_id,
      wallet_address: request.wallet_address,
      transaction_hash: request.transaction_hash,
      strategy: STRATEGY,
      dex_pair: DEX_PAIR
    });
    return request;
  } catch (error) {
    await auditWrite({
      event_type: 'TWO_LEG_SIGNER_REQUEST_BLOCKED',
      strategy: STRATEGY,
      dex_pair: DEX_PAIR,
      phase,
      blocker: String(error?.message || 'two_leg_signer_unknown_error')
    });
    throw error;
  }
}

export const TWO_LEG_SIGNER_BOUNDARY = Object.freeze({
  schema: 'aether.two_leg_signer_boundary.v1',
  strategy: STRATEGY,
  dex_pair: DEX_PAIR,
  min_expected_net_edge_bps: MIN_NET_EDGE_BPS,
  requires_verified_atomic_preflight: true,
  requires_active_bounded_authority: true,
  requires_live_readiness_and_admin_approval: true,
  requires_signer_unlocked: true,
  transaction_signing_performed: false,
  private_key_allowed: false,
  seed_phrase_allowed: false,
  network_submission_authorized: false,
  fund_movement_authorized: false,
  live_execution_authorized: false,
  fail_closed: true
});
