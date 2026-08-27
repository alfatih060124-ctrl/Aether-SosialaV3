import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default async function handler(req, res) {
  // Vercel-safe health/status adapter. Database-backed routes remain on the API container.
  if (req.url === '/api/health') {
    return res.status(200).json({
      status: 'ok',
      service: 'aether-api',
      execution_mode: process.env.EXECUTION_MODE || 'SHADOW',
      live_enabled: process.env.LIVE_ENABLED === 'true' && process.env.EXECUTION_MODE === 'LIVE'
    });
  }

  if (req.url === '/api/execution/status') {
    const liveEnabled = process.env.LIVE_ENABLED === 'true' && process.env.EXECUTION_MODE === 'LIVE';
    return res.status(200).json({ mode: process.env.EXECUTION_MODE || 'SHADOW', live_enabled: liveEnabled, fail_closed: !liveEnabled, signer_exposed_to_api: false });
  }

  return res.status(404).json({ error: 'route_not_configured', message: 'This Vercel deployment exposes the public web safety/status adapter. Database and execution routes run on the API service.' });
}
