import assert from 'node:assert/strict';
import { createSolanaOnchainSolUsdEvidenceLoader } from '../services/api/src/solana-onchain-sol-usd-evidence-loader.mjs';

const POOL = 'Pool111111111111111111111111111111111111111';
const baseQuote = Object.freeze({
  buy_price_usd: 201,
  sell_price_usd: 199,
  quote_verified: true,
  costs_verified: true,
  quote_source: 'ORCA_WHIRLPOOLS_ONCHAIN_RPC_SLOT_500',
  observed_at: '2026-09-06T00:43:50.000Z',
  observed_slot: 500,
  read_only: true,
  live_execution_authorized: false
});

let request = null;
const loader = createSolanaOnchainSolUsdEvidenceLoader({
  poolAddress: POOL,
  notionalUsdc: 100,
  quoteSolUsdcPool: async value => {
    request = value;
    return baseQuote;
  }
});

const evidence = await loader({ source_slot: 499, read_only: true, live_execution_authorized: false });
assert.equal(request.pool_address, POOL);
assert.equal(request.token_mint, 'So11111111111111111111111111111111111111112');
assert.equal(request.quote_mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
assert.equal(request.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(request.read_only, true);
assert.equal(evidence.verified, true);
assert.equal(evidence.sol_usd, 200);
assert.equal(evidence.bid_usd, 199);
assert.equal(evidence.ask_usd, 201);
assert.equal(evidence.source_slot, 500);
assert.equal(evidence.network_submission_authorized, false);
assert.equal(evidence.transaction_signing_authorized, false);
assert.equal(evidence.live_execution_authorized, false);
assert.match(evidence.source_reference, /^SOL_USD_ONCHAIN:/);

const stale = createSolanaOnchainSolUsdEvidenceLoader({
  poolAddress: POOL,
  quoteSolUsdcPool: async () => ({ ...baseQuote, observed_slot: 498 })
});
await assert.rejects(() => stale({ source_slot: 499, read_only: true }), /sol_usd_slot_before_message/);

const unverified = createSolanaOnchainSolUsdEvidenceLoader({
  poolAddress: POOL,
  quoteSolUsdcPool: async () => ({ ...baseQuote, quote_verified: false })
});
await assert.rejects(() => unverified({ source_slot: 499, read_only: true }), /sol_usd_quote_unverified/);

const crossed = createSolanaOnchainSolUsdEvidenceLoader({
  poolAddress: POOL,
  quoteSolUsdcPool: async () => ({ ...baseQuote, buy_price_usd: 198, sell_price_usd: 199 })
});
await assert.rejects(() => crossed({ source_slot: 499, read_only: true }), /sol_usd_crossed_quote_invalid/);

await assert.rejects(() => loader({ source_slot: 499, read_only: false }), /sol_usd_read_only_required/);
await assert.rejects(() => loader({ source_slot: 499, read_only: true, live_execution_authorized: true }), /sol_usd_live_boundary_violation/);

console.log('solana onchain SOL USD evidence loader regression ok');
