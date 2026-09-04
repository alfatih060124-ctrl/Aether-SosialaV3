const HARD_MIN_EXPECTED_NET_EDGE_BPS = 20;

function positiveBigInt(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(label);
  const n = BigInt(raw);
  if (n <= 0n) throw new Error(label);
  return n;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ratioToBps(numerator, denominator) {
  if (denominator <= 0n) return null;
  const delta = numerator - denominator;
  return Number((delta * 100_000_000n) / denominator) / 10_000;
}

function reportEntries(payload) {
  const info = payload?.mostReliableAmmsQuoteReport?.info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return [];
  const rows = [];
  for (const [ammAddress, rawOut] of Object.entries(info)) {
    try {
      const out = positiveBigInt(rawOut, 'invalid_amm_quote_output');
      rows.push({ amm_address: String(ammAddress), out_amount: out.toString() });
    } catch {
      // Provider report rows that are malformed are ignored rather than trusted.
    }
  }
  return rows;
}

function observedRouteAmmAddresses(payload) {
  const routePlan = Array.isArray(payload?.routePlan) ? payload.routePlan : [];
  return new Set(routePlan
    .map(item => String(item?.swapInfo?.ammKey || '').trim())
    .filter(Boolean));
}

export function rankCrossVenueReportPairs(quoteEvidence) {
  const buyPayload = quoteEvidence?.buy?.provider_quote_response;
  const sellPayload = quoteEvidence?.sell?.provider_quote_response;
  const initialUsdc = positiveBigInt(quoteEvidence?.buy?.in_amount, 'buy_input_amount_required');
  const sellInput = positiveBigInt(quoteEvidence?.sell?.in_amount, 'sell_input_amount_required');
  const buys = reportEntries(buyPayload);
  const sells = reportEntries(sellPayload);
  const observedBuyAmms = observedRouteAmmAddresses(buyPayload);
  const observedSellAmms = observedRouteAmmAddresses(sellPayload);
  const rows = [];

  for (const buy of buys) {
    const buyOut = positiveBigInt(buy.out_amount, 'buy_report_output_required');
    for (const sell of sells) {
      if (buy.amm_address === sell.amm_address) continue;
      const sellOut = positiveBigInt(sell.out_amount, 'sell_report_output_required');
      const numerator = sellOut * buyOut;
      const denominator = initialUsdc * sellInput;
      const provisionalSpreadBps = ratioToBps(numerator, denominator);
      if (provisionalSpreadBps === null) continue;
      const buyRouteObserved = observedBuyAmms.has(buy.amm_address);
      const sellRouteObserved = observedSellAmms.has(sell.amm_address);
      rows.push(Object.freeze({
        buy_amm_address: buy.amm_address,
        sell_amm_address: sell.amm_address,
        buy_route_observed: buyRouteObserved,
        sell_route_observed: sellRouteObserved,
        routability_score: Number(buyRouteObserved) + Number(sellRouteObserved),
        provisional_cross_venue_spread_bps: provisionalSpreadBps
      }));
    }
  }

  rows.sort((a, b) => {
    const routabilityDelta = b.routability_score - a.routability_score;
    if (routabilityDelta !== 0) return routabilityDelta;
    return b.provisional_cross_venue_spread_bps - a.provisional_cross_venue_spread_bps;
  });
  return Object.freeze(rows);
}

export function computeExecutableRoundTripEdgeBps(initialUsdcRaw, returnedUsdcRaw) {
  const initial = positiveBigInt(initialUsdcRaw, 'initial_usdc_required');
  const returned = positiveBigInt(returnedUsdcRaw, 'returned_usdc_required');
  return ratioToBps(returned, initial);
}

export function computeExactNetworkFeeBps({ exactRoundtripFeeLamports, solUsd, notionalUsdc }) {
  const lamports = Number(exactRoundtripFeeLamports);
  const solPrice = finitePositive(solUsd);
  const notional = finitePositive(notionalUsdc);
  if (!Number.isSafeInteger(lamports) || lamports < 0 || solPrice === null || notional === null) return null;
  const feeUsd = (lamports / 1_000_000_000) * solPrice;
  return (feeUsd / notional) * 10_000;
}

export function finalizeExpectedNetEdge({
  grossExecutableSpreadBps,
  exactRoundtripFeeLamports,
  solUsd,
  notionalUsdc,
  minimumNetEdgeBps = HARD_MIN_EXPECTED_NET_EDGE_BPS
}) {
  const gross = Number(grossExecutableSpreadBps);
  const networkFeeBps = computeExactNetworkFeeBps({ exactRoundtripFeeLamports, solUsd, notionalUsdc });
  const requestedFloor = Number(minimumNetEdgeBps);
  const effectiveFloor = Number.isFinite(requestedFloor)
    ? Math.max(HARD_MIN_EXPECTED_NET_EDGE_BPS, requestedFloor)
    : HARD_MIN_EXPECTED_NET_EDGE_BPS;

  if (!Number.isFinite(gross) || networkFeeBps === null) {
    return Object.freeze({
      gross_executable_spread_bps: Number.isFinite(gross) ? gross : null,
      exact_network_fee_bps: networkFeeBps,
      expected_net_edge_bps: null,
      net_edge_costs_included: false,
      min_expected_net_edge_bps: effectiveFloor,
      net_edge_gate_passed: false,
      reason: 'NET_EDGE_COST_EVIDENCE_INCOMPLETE'
    });
  }

  const expected = gross - networkFeeBps;
  return Object.freeze({
    gross_executable_spread_bps: gross,
    exact_network_fee_bps: networkFeeBps,
    expected_net_edge_bps: expected,
    net_edge_costs_included: true,
    min_expected_net_edge_bps: effectiveFloor,
    net_edge_gate_passed: expected >= effectiveFloor,
    reason: expected >= effectiveFloor ? 'NET_EDGE_QUALIFIED' : 'NET_EDGE_BELOW_FLOOR'
  });
}

export const CROSS_VENUE_NET_EDGE_HARD_FLOOR_BPS = HARD_MIN_EXPECTED_NET_EDGE_BPS;