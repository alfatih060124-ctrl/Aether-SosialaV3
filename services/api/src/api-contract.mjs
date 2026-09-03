export const API_CONTRACT = {
  deployment_roles: {
    public_edge: 'PUBLIC_EDGE',
    primary_runtime: 'PRIMARY_VM',
    public_edge_primary_origin: 'https://api.aether.boats'
  },

  public_edge_local: [
    'GET /api/market/token?mint=:mint'
  ],

  primary_public: [
    'GET /api/health',
    'GET /api/readiness',
    'GET /api/version',
    'GET /api/execution/status',
    'GET /api/signals/config',
    'GET /api/autotrade/status',
    'GET /api/trades',
    'GET /api/traders',
    'GET /api/traders/:traderId',
    'GET /api/marketplace/fees'
  ],

  wallet_auth: [
    'POST /api/auth/challenge',
    'POST /api/auth/verify',
    'GET /api/auth/session',
    'POST /api/auth/logout'
  ],

  wallet_session: [
    'GET /api/account/wallet-portfolio',
    'GET /api/account/trader',
    'POST /api/account/trader/challenge',
    'POST /api/account/trader/apply',
    'GET /api/account/copy-mandates',
    'GET /api/account/copy-trades',
    'GET /api/account/positions',
    'POST /api/account/copy-mandates',
    'PATCH /api/account/copy-mandates/:policyId',
    'POST /api/account/autotrade/evaluate'
  ],

  token_authenticated: [
    'POST /api/signals/evaluate',
    'GET /api/signals/recent',
    'GET /api/autotrade/decisions',
    'GET /api/execution/rental/status',
    'POST /api/execution/rental',
    'PATCH /api/execution/rental/payment',
    'GET /api/execution/rentals',
    'POST /api/executions',
    'GET /api/executions',
    'POST /api/internal/traders/:traderId/reconciled-trades',
    'GET /api/internal/traders/:traderId/reconciled-trades'
  ],

  disabled_legacy: [
    'POST /api/autotrade/evaluate'
  ],

  primary_shadow_only: [
    'POST /api/shadow/simulate'
  ],

  admin: [
    'GET /api/admin/wallets',
    'GET /api/admin/wallets/readiness',
    'PUT /api/admin/wallets/:role',
    'GET /api/admin/risk',
    'GET /api/admin/audit',
    'GET /api/admin/traders/applications',
    'PATCH /api/admin/traders/:traderId/review',
    'GET /api/admin/traders/:traderId/evidence/collections',
    'POST /api/admin/traders/:traderId/evidence/collect',
    'POST /api/admin/traders/:traderId/evidence/reconcile',
    'GET /api/admin/traders/:traderId/evidence',
    'POST /api/admin/traders/:traderId/evidence',
    'PATCH /api/admin/traders/:traderId/verification',
    'PATCH /api/admin/traders/:traderId/publication',
    'GET /api/admin/copy-policies',
    'PATCH /api/admin/copy-policies/:policyId',
    'PATCH /api/admin/fees',
    'GET /api/admin/rentals',
    'GET /api/admin/billing/ledger'
  ],

  invariants: {
    execution_mode: 'SHADOW',
    live_execution_authorized: false,
    signer_exposed_to_api: false,
    public_edge_blocks_internal_and_admin_routes: true,
    market_token_lookup_is_read_only: true,
    wallet_portfolio_is_session_bound: true,
    wallet_portfolio_is_read_only: true,
    wallet_portfolio_never_authorizes_live: true,
    copy_trade_activity_is_session_bound: true,
    copy_trade_activity_never_authorizes_live: true,
    copy_trade_open_positions_not_inferred_from_execution_requests: true,
    follower_positions_are_session_bound: true,
    follower_positions_are_shadow_simulated_only: true,
    follower_positions_fail_closed_when_accounting_incomplete: true,
    follower_position_pnl_requires_fresh_mark: true,
    follower_positions_never_authorize_live: true,
    copy_mandate_consent_is_versioned: true,
    copy_mandate_requires_published_verified_trader: true,
    member_autotrade_is_session_bound: true,
    member_autotrade_uses_persisted_mandate: true,
    member_autotrade_caller_risk_authority: false,
    member_autotrade_execution_dispatched: false,
    legacy_caller_mandate_autotrade_disabled: true,
    evidence_collection_does_not_verify: true,
    evidence_recording_does_not_verify: true,
    reconciled_performance_evidence_does_not_verify: true,
    direct_reconciliation_metrics_ingest_blocked: true,
    coordinated_reconciliation_sources_required: true,
    incomplete_reconciliation_sources_do_not_write_ledger: true,
    verification_does_not_publish: true,
    publication_requires_prior_verification: true,
    auto_trade_execution_dispatched: false,
    shadow_simulation_never_authorizes_live: true,
    shadow_simulation_requires_api_token: true
  }
};
