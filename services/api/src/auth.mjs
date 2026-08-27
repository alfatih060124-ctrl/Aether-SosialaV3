import crypto from 'node:crypto';

export function hashApiToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function requireApiToken(req) {
  const expected = process.env.API_TOKEN;
  if (!expected) throw new Error('API_TOKEN is not configured');
  const supplied = req.headers?.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!supplied || hashApiToken(supplied) !== hashApiToken(expected)) {
    const error = new Error('unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

export function isLiveEnabled() {
  return process.env.EXECUTION_MODE === 'LIVE' && process.env.LIVE_ENABLED === 'true';
}
