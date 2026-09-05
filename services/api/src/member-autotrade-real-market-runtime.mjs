const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function candidatePair(item, quoteMint) {
  const base = String(item?.base_token?.mint || '').trim();
  const quote = String(item?.quote_token?.mint || '').trim();
  if (base === quoteMint && quote && quote !== quoteMint) return { token_mint: quote, quote_mint: quoteMint };
  if (quote === quoteMint && base && base !== quoteMint) return { token_mint: base, quote_mint: quoteMint };
  return null;
}

function expectedNetEdge(item) {
  const value = finite(item?.assessment?.arbitrage?.expected_net_edge_bps ?? item?.assessment?.arbitrage?.net_edge_bps);
  return value === null ? -Infinity : value;
}

export function createMemberAutoTradeRealMarketRuntime({
  discoveryService,
  qualificationRuntime,
  quoteMint,
  discoveryView = 'trending',
  maxCandidates = 20
} = {}) {
  if (!discoveryService || typeof discoveryService.getDiscovery !== 'function') throw new Error('member_real_market_discovery_required');
  if (!qualificationRuntime || typeof qualificationRuntime.scanAndQualifyPair !== 'function') throw new Error('member_real_market_qualification_runtime_required');
  const canonicalQuoteMint = text(quoteMint, 'member_real_market_quote_mint_required');
  const limit = Number(maxCandidates);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('member_real_market_candidate_limit_invalid');

  return Object.freeze({
    async runNextOpportunity({ demo_account } = {}) {
      if (!demo_account || typeof demo_account !== 'object') throw new Error('member_real_market_demo_account_required');
      const discovery = await discoveryService.getDiscovery(discoveryView);
      if (!discovery || !Array.isArray(discovery.items)) throw new Error('member_real_market_discovery_invalid');
      if (discovery?.freshness?.stale === true) throw new Error('member_real_market_discovery_stale');

      const seen = new Set();
      const candidates = [];
      for (const item of discovery.items.slice(0, limit)) {
        const pair = candidatePair(item, canonicalQuoteMint);
        if (!pair) continue;
        const key = `${pair.token_mint}:${pair.quote_mint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(pair);
      }
      if (!candidates.length) throw new Error('member_real_market_no_usdc_candidates');

      const scans = [];
      for (const pair of candidates) {
        const result = await qualificationRuntime.scanAndQualifyPair({ ...pair, demo_account });
        if (result?.mode !== 'SHADOW' || result?.strategy !== 'TWO_LEG_ARBITRAGE' || result?.live_execution_authorized !== false) {
          throw new Error('member_real_market_shadow_invariant_failed');
        }
        scans.push(result);
      }

      const qualified = scans.flatMap(scan => (scan.results || []).filter(item => item?.qualified === true && item?.settlement?.settlement_status === 'ARBITRAGE_CLOSED'));
      qualified.sort((a, b) => expectedNetEdge(b) - expectedNetEdge(a));
      return Object.freeze({
        selected: qualified[0] || null,
        qualified_count: qualified.length,
        candidate_count: candidates.length,
        market_source: 'ORCA_RAYDIUM_VERIFIED_FROM_READONLY_DISCOVERY',
        discovery_source: discovery.source || 'GECKOTERMINAL_PUBLIC',
        discovery_execution_ready: false,
        mode: 'SHADOW',
        strategy: 'TWO_LEG_ARBITRAGE',
        execution_dispatched: false,
        funds_moved: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  candidate_discovery_is_execution_evidence: false,
  min_expected_net_edge_bps: 20,
  transaction_signing_authorized: false,
  private_key_allowed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
