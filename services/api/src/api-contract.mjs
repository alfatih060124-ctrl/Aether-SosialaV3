export const API_CONTRACT = {
  public: [
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
  auth: [
    'POST /api/auth/challenge',
    'POST /api/auth/verify',
    'GET /api/auth/session',
    'POST /api/auth/logout'
  ],
  authenticated: [
    'GET /api/account/trader',
    'POST /api/account/trader/challenge',
    'POST /api/account/trader/apply',
    'GET /api/account/copy-mandates',
    'POST /api/account/copy-mandates',
    'PATCH /api/account/copy-mandates/:policyId'
  ],
  internal: [
    'POST /api/signals/evaluate',
    'GET /api/signals/recent',
    'POST /api/autotrade/evaluate',
    'GET /api/autotrade/decisions',
    'POST /api/shadow/simulate',
    'POST /api/execution-requests'
  ],
  admin: [
    'GET /api/admin/system-health',
    'GET /api/admin/circuit-breakers',
    'GET /api/admin/risk',
    'GET /api/admin/audit',
    'GET /api/admin/traders/applications',
    'PATCH /api/admin/traders/:traderId/review',
    'GET /api/admin/traders/:traderId/evidence',
    'POST /api/admin/traders/:traderId/evidence',
    'PATCH /api/admin/traders/:traderId/verification',
    'PATCH /api/admin/traders/:traderId/publication',
    'GET /api/admin/copy-policies',
    'PATCH /api/admin/copy-policies/:policyId',
    'PATCH /api/admin/fees',
    'GET /api/admin/rentals',
    'GET /api/admin/billing/ledger',
    'GET /api/admin/wallets',
    'GET /api/admin/wallets/readiness',
    'PUT /api/admin/wallets/:role'
  ],
  invariants: {
    execution_mode: 'SHADOW',
    live_execution_authorized: false,
    publication_requires_prior_verification: true,
    evidence_recording_does_not_verify: true,
    verification_does_not_publish: true,
    auto_trade_produces_intent_only: true
  }
};
