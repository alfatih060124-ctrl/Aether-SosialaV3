import assert from 'node:assert/strict';
import {
  createOrcaRaydiumShadowRuntime,
  ORCA_RAYDIUM_SHADOW_RUNTIME
} from '../services/api/src/orca-raydium-shadow-runtime.mjs';

const observedAt = new Date().toISOString();
const observedSlot = 1;
const tokenMint = 'TokenMint111111111111111111111111111111111';
const quoteMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const instructionContext = dex => Object.freeze({
  verified: true,
  source: `${dex.toUpperCase()}_TEST_RPC`,
  source_slot: observedSlot,
  observed_at: observedAt,
  pool_type: dex === 'raydium' ? 'CPMM' : undefined,
  buy: Object.freeze({ test_only: true }),
  sell: Object.freeze({ test_only: true }),
  read_only: true,
  private_key_present: false,
  signature_present: false,
  signer_requested: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

const poolQuote = dex => async request => ({
  buy_price_usd: dex === 'orca' ? 1 : 1.01,
  sell_price_usd: dex === 'orca' ? 0.999 : 1.012,
  buy_fee_bps: 1,
  sell_fee_bps: 1,
  buy_price_impact_bps: 1,
  sell_price_impact_bps: 1,
  liquidity_usd: 1_000_000,
  quote_source: `${dex.toUpperCase()}_TEST_RPC`,
  quote_verified: true,
  costs_verified: true,
  observed_at: observedAt,
  observed_slot: observedSlot,
  instruction_context: instructionContext(dex),
  pool_type: 'CPMM',
  read_only: true,
  live_execution_authorized: false,
  request
});

const fetchImpl = async url => {
  const isOrca = String(url).includes('orca.so');
  return {
    ok: true,
    status: 200,
    async json() {
      if (isOrca) {
        return { data: [{ address: 'orca-pool', tokenMintA: tokenMint, tokenMintB: quoteMint, tvlUsdc: 1_000_000 }] };
      }
      return { success: true, data: { data: [{ id: 'raydium-pool', mintA: { address: tokenMint }, mintB: { address: quoteMint }, type: 'CPMM', tvl: 1_000_000 }] } };
    }
  };
};

const runtime = await createOrcaRaydiumShadowRuntime({
  quoteNotionalUsdc: 100,
  orcaQuotePool: poolQuote('orca'),
  raydiumQuotePool: poolQuote('raydium'),
  fetchImpl,
  now: () => Date.parse(observedAt),
  cacheTtlMs: 5_000,
  maxMarketAgeMs: 5_000
});

const scan = await runtime.scanPair({ token_mint: tokenMint, quote_mint: quoteMint });
assert.equal(scan.read_only, true);
assert.equal(scan.live_execution_authorized, false);
assert.equal(scan.pools.length, 2);
assert.equal(scan.opportunities.length, 2);
assert.equal(scan.opportunities[0].buy_route.instruction_context.verified, true);
assert.equal(scan.opportunities[0].sell_route.instruction_context.source_slot, observedSlot);
assert.equal(runtime.mode, 'SHADOW');
assert.equal(runtime.execution_dispatched, false);
assert.equal(runtime.transaction_created, false);
assert.equal(runtime.signer_requested, false);
assert.equal(runtime.network_submission_authorized, false);
assert.deepEqual(ORCA_RAYDIUM_SHADOW_RUNTIME.dex_scope, ['ORCA', 'RAYDIUM']);
assert.equal(ORCA_RAYDIUM_SHADOW_RUNTIME.live_execution_authorized, false);

await assert.rejects(
  () => createOrcaRaydiumShadowRuntime({ quoteNotionalUsdc: 0, orcaQuotePool: poolQuote('orca'), raydiumQuotePool: poolQuote('raydium') }),
  /shadow_runtime_quote_notional_required/
);

console.log('ORCA Raydium SHADOW runtime regression: PASS');
