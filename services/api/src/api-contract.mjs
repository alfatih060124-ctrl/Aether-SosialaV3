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
    'GET /api/account/trader',
    'POST /api/account/trader/challenge',
    'POST /api/account/trader/apply',
    'GET /api/account/copy-mandates',
    'POST /api/account/copy-mandates',
    'PATCH /api/account/copy-mandates/:policyId'
  ],

  token_authenticated: [
    'POST /api/signals/evaluate',
    'GET /api/signals/recent',
    'POST /api/autotrade/evaluate',
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

  authority_boundaries: {
    trader_evidence_recording: {
      route: 'POST /api/admin/traders/:traderId/evidence',
      may_record_evidence: true,
      may_verify_trader: false,
      may_publish_trader: false,
      live_execution_authorized: false
    },
    trader_verification: {
      route: 'PATCH /api/admin/traders/:traderId/verification',
      requires_recorded_evidence: true,
      may_record_evidence: false,
      may_verify_trader: true,
      may_publish_trader: false,
      live_execution_authorized: false
    },
    trader_publication: {
      route: 'PATCH /api/admin/traders/:traderId/publication',
      requires_prior_verification: true,
      may_record_evidence: false,
      may_verify_trader: false,
      may_publish_trader: true,
      live_execution_authorized: false
    },
    copy_mandate: {
      identity_authority: 'WALLET_SESSION',
      policy_authority: 'BACKEND_PERSISTED',
      caller_policy_authority: false,
      requires_verified_trader: true,
      requires_published_trader: true,
      live_execution_authorized: false
    },
    auto_trade: {
      identity_authority: 'AUTHENTICATED_FOLLOWER_SESSION',
      mandate_authority: 'BACKEND_PERSISTED',
      runtime_risk_authority: 'BACKEND_PERSISTED',
      caller_identity_authority: false,
      caller_mandate_authority: false,
      caller_runtime_risk_authority: false,
      output_authority: 'INTENT_ONLY',
      execution_dispatched: false,
      live_execution_authorized: false,
      network_submission_authorized: false,
      signer_required: false
    },
    fee_control: {
      requester_role: 'FEE_CONFIG_OPERATOR',
      approver_role: 'FEE_CONFIG_APPROVER',
      applier_role: 'FEE_CONFIG_APPLIER',
      requester_must_differ_from_approver: true,
      requester_must_differ_from_applier: true,
      approver_must_differ_from_applier: true,
      live_execution_authorized: false
    }
  },

  invariants: {
    execution_mode: 'SHADOW',
    live_execution_authorized: false,
    signer_exposed_to_api: false,
    public_edge_blocks_internal_and_admin_routes: true,
    market_token_lookup_is_read_only: true,
    evidence_collection_does_not_verify: true,
    evidence_recording_does_not_verify: true,
    reconciled_performance_evidence_does_not_verify: true,
    direct_reconciliation_metrics_ingest_blocked: true,
    coordinated_reconciliation_sources_required: true,
    incomplete_reconciliation_sources_do_not_write_ledger: true,
    verification_does_not_publish: true,
    publication_requires_prior_verification: true,
    copy_mandate_requires_published_verified_trader: true,
    auto_trade_execution_dispatched: false,
    auto_trade_is_intent_only: true,
    caller_cannot_authorize_copy_mandate: true,
    caller_cannot_authorize_runtime_risk: true,
    fee_control_requires_three_party_separation: true,
    shadow_simulation_never_authorizes_live: true,
    shadow_simulation_requires_api_token: true
  }
};
