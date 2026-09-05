import { evaluateRealMarketArbitrageShadow } from './real-market-arbitrage-shadow.mjs';
import { settleDemoArbitrage } from './demo-autotrade-ledger.mjs';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function verifiedNetworkFee(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new Error('shadow_network_fee_evidence_required');
  const fee = finite(evidence.network_fee_usdc);
  if (fee === null || fee < 0) throw new Error('shadow_network_fee_usdc_required');
  if (evidence.network_fee_verified !== true) throw new Error('shadow_network_fee_unverified');
  return fee;
}

function verifiedRiskEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new Error('shadow_risk_evidence_required');
  if (evidence.verified !== true) throw new Error('shadow_risk_evidence_unverified');
  return evidence.data && typeof evidence.data === 'object' ? evidence.data : evidence;
}

export function createOrcaRaydiumShadowQualificationRuntime({
  scannerRuntime,
  loadNetworkFeeEvidence,
  loadRiskEvidence,
  notionalUsdc,
  performanceFeeBps = 1000,
  now = () => Date.now()
} = {}) {
  if (!scannerRuntime || typeof scannerRuntime.scanPair !== 'function') throw new Error('shadow_scanner_runtime_required');
  if (typeof loadNetworkFeeEvidence !== 'function') throw new Error('shadow_network_fee_loader_required');
  if (typeof loadRiskEvidence !== 'function') throw new Error('shadow_risk_evidence_loader_required');
  const notional = finite(notionalUsdc);
  if (!(notional > 0)) throw new Error('shadow_qualification_notional_required');

  return Object.freeze({
    async scanAndQualifyPair({ token_mint, quote_mint, demo_account } = {}) {
      const scan = await scannerRuntime.scanPair({ token_mint, quote_mint });
      const results = [];

      for (const rawOpportunity of scan.opportunities || []) {
        const [feeEvidence, riskEvidence] = await Promise.all([
          loadNetworkFeeEvidence({ opportunity: rawOpportunity, notional_usdc: notional }),
          loadRiskEvidence({ opportunity: rawOpportunity, notional_usdc: notional })
        ]);

        const opportunity = Object.freeze({
          ...rawOpportunity,
          network_fee_usdc: verifiedNetworkFee(feeEvidence),
          network_fee_verified: true
        });
        const assessment = evaluateRealMarketArbitrageShadow({
          opportunity,
          notional_usdc: notional,
          risk_evidence: verifiedRiskEvidence(riskEvidence),
          now: now()
        });

        let settlement = null;
        if (assessment.decision.action === 'ARBITRAGE_SETTLE') {
          if (!demo_account || typeof demo_account !== 'object') throw new Error('shadow_demo_account_required');
          settlement = settleDemoArbitrage({
            account: demo_account,
            notionalUsdc: assessment.arbitrage.notional_usdc,
            finalUsdc: assessment.arbitrage.final_usdc,
            performanceFeeBps
          });
        }

        results.push(Object.freeze({
          opportunity,
          assessment,
          settlement,
          qualified: assessment.decision.action === 'ARBITRAGE_SETTLE',
          mode: 'SHADOW',
          execution_dispatched: false,
          transaction_created: false,
          signer_requested: false,
          funds_moved: false,
          network_submission_authorized: false,
          live_execution_authorized: false
        }));
      }

      return Object.freeze({
        token_mint,
        quote_mint,
        market_source: scan.source,
        results: Object.freeze(results),
        qualified_count: results.filter(item => item.qualified).length,
        mode: 'SHADOW',
        strategy: 'TWO_LEG_ARBITRAGE',
        read_only_market_data: true,
        execution_dispatched: false,
        transaction_created: false,
        signer_requested: false,
        funds_moved: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  min_expected_net_edge_bps: 20,
  requires_verified_network_fee: true,
  requires_verified_risk_evidence: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
