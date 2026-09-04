const nativeFetch = globalThis.fetch;
if (typeof nativeFetch !== 'function') throw new Error('fetch_unavailable');

process.env.AETHER_MARKET_VIEWS ||= 'volume,trending,new,gainers';
process.env.AETHER_CROSS_VENUE_CANDIDATE_LIMIT ||= '60';

const GECKO_ORIGIN = 'https://api.geckoterminal.com';

globalThis.fetch = async (input, init) => {
  const rawUrl = input instanceof URL ? input.href : String(input?.url || input || '');
  let url = null;
  try { url = new URL(rawUrl); } catch { return nativeFetch(input, init); }

  if (url.origin === GECKO_ORIGIN && url.pathname === '/api/v2/networks/solana/pools') {
    url.searchParams.set('sort', 'h24_volume_usd_desc');
    return nativeFetch(url, init);
  }
  return nativeFetch(input, init);
};

await import('./vm-cross-venue-net-edge-probe.mjs');
