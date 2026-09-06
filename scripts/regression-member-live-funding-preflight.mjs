import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateMemberLiveFundingPreflight, MEMBER_LIVE_FUNDING_PREFLIGHT } from '../services/api/src/member-live-funding-preflight.mjs';

const now = new Date('2026-09-06T10:30:00.000Z');
const wallet = '11111111111111111111111111111111';
const session = { user_id: 'member-1', primary_wallet: wallet };

function pool({ subscriptionActive = true, authorityActive = true, authorityExpired = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM member_subscriptions')) return { rows: [{
        subscription_id: 'sub-1', status: subscriptionActive ? 'ACTIVE' : 'EXPIRED',
        service_started_at: '2026-09-01T00:00:00.000Z',
        service_expires_at: subscriptionActive ? '2026-10-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z'
      }] };
      if (sql.includes('FROM member_delegated_authorities')) return { rows: [{
        authority_id: 'auth-1', wallet_address: wallet, status: authorityActive ? 'ACTIVE' : 'REVOKED',
        allowed_strategy: 'TWO_LEG_ARBITRAGE', allowed_dex_pair: 'ORCA_RAYDIUM', min_net_edge_bps: 20,
        max_notional_usdc_atomic: '20000000', max_daily_loss_usdc_atomic: '1000000',
        expires_at: authorityExpired ? '2026-09-06T10:00:00.000Z' : '2026-09-07T10:30:00.000Z'
      }] };
      throw new Error('unexpected_query');
    }
  };
}

function portfolio(usdcAtomic = '50000000', solLamports = '10000') {
  return {
    async getPortfolio(address, options) {
      assert.equal(address, wallet);
      assert.equal(options.force, true);
      return {
        wallet,
        source: 'SOLANA_RPC',
        observed_at: now.toISOString(),
        read_only: true,
        balances: { sol: { lamports: solLamports } },
        assets: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount_raw: usdcAtomic, decimals: 6 }]
      };
    }
  };
}

const passing = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio(), now, minSolReserveLamports: '5000'
});
assert.equal(passing.funding_preflight_passed, true);
assert.deepEqual(passing.blockers, []);
assert.equal(passing.funding.minimum_usdc_atomic, '50000000');
assert.equal(passing.live_execution_authorized, false);
assert.equal(passing.transaction_submission_authorized, false);
assert.equal(passing.signer_authorized, false);
assert.equal(passing.fund_movement_authorized, false);

const lowUsdc = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio('49999999'), now, minSolReserveLamports: '5000'
});
assert.equal(lowUsdc.funding_preflight_passed, false);
assert.ok(lowUsdc.blockers.includes('USDC_BELOW_50_MINIMUM'));

const lowSol = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio('50000000', '4999'), now, minSolReserveLamports: '5000'
});
assert.ok(lowSol.blockers.includes('SOL_FEE_RESERVE_BELOW_MINIMUM'));

const reserveUnconfigured = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio(), now, minSolReserveLamports: undefined
});
assert.ok(reserveUnconfigured.blockers.includes('SOL_FEE_RESERVE_THRESHOLD_UNCONFIGURED'));

const inactive = await evaluateMemberLiveFundingPreflight(pool({ subscriptionActive: false, authorityExpired: true }), session, {
  portfolioService: portfolio(), now, minSolReserveLamports: '5000'
});
assert.ok(inactive.blockers.includes('SUBSCRIPTION_INACTIVE'));
assert.ok(inactive.blockers.includes('DELEGATED_AUTHORITY_EXPIRED'));

assert.equal(MEMBER_LIVE_FUNDING_PREFLIGHT.minimum_usdc, '50');
assert.equal(MEMBER_LIVE_FUNDING_PREFLIGHT.sol_reserve_threshold_source, 'LIVE_MIN_SOL_RESERVE_LAMPORTS');

const route = fs.readFileSync(new URL('../services/api/src/member-live-funding-preflight-route.mjs', import.meta.url), 'utf8');
const dispatcher = fs.readFileSync(new URL('../services/api/src/member-positions-route.mjs', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
assert.match(route, /\/api\/account\/live-preflight/);
assert.match(route, /live_execution_authorized: false/);
assert.match(dispatcher, /handleMemberLiveFundingPreflightRoute/);
assert.match(caddy, /\/api\/account\/live-preflight/);
for (const source of [route, fs.readFileSync(new URL('../services/api/src/member-live-funding-preflight.mjs', import.meta.url), 'utf8')]) {
  assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|seed phrase/i);
}

console.log('Member LIVE funding preflight regression: PASS');
