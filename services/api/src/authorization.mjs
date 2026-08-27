const ROLES = new Set(['USER', 'TRADER', 'ADMIN', 'OPERATOR']);

export function requireRole(user, ...allowedRoles) {
  if (!user || !ROLES.has(user.role) || !allowedRoles.includes(user.role)) {
    const error = new Error('forbidden');
    error.statusCode = 403;
    throw error;
  }
}

export function assertLiveExecutionAllowed({ mode, liveEnabled, fixtureGatePassed, operatorApproved }) {
  if (mode !== 'LIVE') return;
  if (!(liveEnabled && fixtureGatePassed && operatorApproved)) {
    const error = new Error('live_execution_blocked');
    error.statusCode = 423;
    throw error;
  }
}
