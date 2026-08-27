export const API_CONTRACT = {
  public: [
    'GET /api/health',
    'GET /api/traders/:wallet'
  ],
  authenticated: [
    'POST /api/trade-events',
    'GET /api/trade-events/:eventId',
    'POST /api/follows',
    'DELETE /api/follows/:traderId',
    'POST /api/copy-policies',
    'GET /api/copy-policies',
    'POST /api/risk-decisions',
    'POST /api/execution-requests'
  ],
  admin: [
    'GET /api/admin/system-health',
    'GET /api/admin/circuit-breakers'
  ]
};
