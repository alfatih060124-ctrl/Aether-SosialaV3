import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateMemberLiveFundingPreflight, MEMBER_LIVE_FUNDING_PREFLIGHT } from '../services/api/src/member-live-funding-preflight.mjs';

const now = new Date('2026-09-06T10:30:00.000Z');
const wallet = '11111111111111111111111111111111';
const session = { user_id: 'member-1', primary_wallet: wallet };

function authorityRow({ active = true, expired = false } = {}) {
  return {
    authority_id: 'auth-1', wallet_address: wallet, status: active ? 'ACTIVE' : 'REVOKED',
    allowed_strategy: 'TWO_LEG_ARBITRAGE', allowed_dex_pair: 'ORCA_RAYDIUM', min_net_edge_bps: 20,
    max_notional_usdc_atomic: '20000000', max_daily_loss_usdc_atomic: '1000000',
    expires_at: expired ? '2026-09-06T10:00:00.000Z' : '2026-09-07T10:30:00.000Z'
  };
}

function pool({ subscriptionActive = true, authorityActive = true, authorityExpired = false, pendingNewest = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM member_subscriptions')) return { rows: [{
        subscription_id: 'sub-1', status: subscriptionActive ? 'ACTIVE' : 'EXPIRED',
        service_started_at: '2026-09-01T00:00:00.000Z',
        service_expires_at: subscriptionActive ? '2026-10-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z'
      }] };
      if (sql.includes('FROM member_delegated_authorities')) {
        if (sql.includes("status='ACTIVE'")) {
          return { rows: authorityActive && !authorityExpired ? [authorityRow()] : [] };
        }
        if (pendingNewest) return { rows: [{ ...authorityRow(), authority_id: 'pending-newest', status: 'PENDING_CONSENT' }] };
        return { rows: [authorityRow({ active: authorityActive, expired: authorityExpired })] };
      }
      throw new Error('unexpected_query');
    }
  };
}

function portfolio(usdcAtomic = '50000000', solLamports = '10000', verified = true) {
  return {
    async getPortfolio(address, options) {
      assert.equal(address, wallet);
      assert.equal(options.force, true);
      return {
        wallet,
        source: 'SOLANA_RPC',
        observed_at: now.toISOString(),
        read_only: true,
        balances: {
          sol: { lamports: solLamports },
          usdc: {
            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            amount_raw: usdcAtomic,
            decimals: 6,
            raw_balance_verified: verified
          }
        },
        assets: []
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

const activeWinsOverPendingNewest = await evaluateMemberLiveFundingPreflight(pool({ pendingNewest: true }), session, {
  portfolioService: portfolio(), now, minSolReserveLamports: '5000'
});
assert.equal(activeWinsOverPendingNewest.funding_preflight_passed, true);
assert.equal(activeWinsOverPendingNewest.delegated_authority.authority_id, 'auth-1');

const lowUsdc = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio('49999999'), now, minSolReserveLamports: '5000'
});
assert.equal(lowUsdc.funding_preflight_passed, false);
assert.ok(lowUsdc.blockers.includes('USDC_BELOW_50_MINIMUM'));

const unverifiedUsdc = await evaluateMemberLiveFundingPreflight(pool(), session, {
  portfolioService: portfolio('55000000', '10000', false), now, minSolReserveLamports: '5000'
});
assert.ok(unverifiedUsdc.blockers.includes('USDC_BALANCE_UNVERIFIED'));

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
const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const walletPortfolio = fs.readFileSync(new URL('../services/api/src/wallet-portfolio.mjs', import.meta.url), 'utf8');
const preflightSource = fs.readFileSync(new URL('../services/api/src/member-live-funding-preflight.mjs', import.meta.url), 'utf8');
assert.match(route, /\/api\/account\/live-preflight/);
assert.match(route, /live_execution_authorized: false/);
assert.match(dispatcher, /handleMemberLiveFundingPreflightRoute/);
assert.match(caddy, /\/api\/account\/live-preflight/);
assert.match(compose, /LIVE_MIN_SOL_RESERVE_LAMPORTS: \$\{LIVE_MIN_SOL_RESERVE_LAMPORTS:-\}/);
assert.match(envExample, /LIVE_MIN_SOL_RESERVE_LAMPORTS=/);
assert.match(preflightSource, /status='ACTIVE'/);
assert.match(preflightSource, /expires_at > \$3/);
assert.match(walletPortfolio, /BigInt\(current\.amount_raw\) \+ raw/);
assert.match(walletPortfolio, /raw_balance_verified/);
for (const source of [route, preflightSource]) {
  assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|seed phrase/i);
}

console.log('Member LIVE funding preflight regression: PASS');
