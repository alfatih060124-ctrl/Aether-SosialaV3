// Expanded candidate-universe wrapper for the existing SHADOW cross-venue net-edge probe.
// This file only broadens discovery defaults. All qualification, risk, fee,
// price-impact, simulation, and minimum-net-edge gates remain implemented by
// vm-cross-venue-net-edge-probe.mjs as the single source of truth.

if (!String(process.env.AETHER_MARKET_VIEWS || '').trim()) {
  process.env.AETHER_MARKET_VIEWS = 'trending,new,gainers,volume';
}

if (!String(process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT || '').trim()) {
  process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT = '60';
}

if (!String(process.env.AETHER_MARKET_PROBE_LIMIT || '').trim()) {
  process.env.AETHER_MARKET_PROBE_LIMIT = '20';
}

await import('./vm-cross-venue-net-edge-probe.mjs');
