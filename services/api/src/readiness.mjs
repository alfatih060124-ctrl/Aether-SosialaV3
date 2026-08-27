import { URL } from 'node:url';

export async function readiness({ pool }) {
  try {
    await pool.query('SELECT 1');
    return { status: 'ready', database: 'ok' };
  } catch (error) {
    return { status: 'not_ready', database: 'unavailable', error: error.code || 'DB_ERROR' };
  }
}

export function healthPayload() {
  return { status: 'ok', service: 'aether-api', mode: process.env.EXECUTION_MODE || 'SHADOW' };
}
