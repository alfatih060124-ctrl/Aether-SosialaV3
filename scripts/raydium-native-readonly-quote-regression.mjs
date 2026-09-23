import assert from 'node:assert/strict';
import { createRaydiumNativeReadonlyQuoteService } from '../services/api/src/raydium-native-readonly-quote.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

const service = createRaydiumNativeReadonlyQuoteService({
  // Cold provider/pool warm-up is outside the scanner SLA clock.
  timeoutMs: Number(process.env.RAYDIUM_NATIVE_REGRESSION_TIMEOUT_MS || 1800)
});

assert.equal(service.safety.read_only, true);
assert.equal(service.safety.transaction_submission, false);
assert.equal(service.safety.signer_requested, false);
assert.equal(service.safety.live_execution_authorized, false);

await service.warm();
const warmedPool = await service.warmPool({ poolAddress: POOL });
const quote = await service.quote({
  inputMint: USDC,
  outputMint: SOL,
  amount: '100000000',
  slippageBps: 100,
  poolAddress: POOL
});
assert.equal(quote.provider, 'RAYDIUM_NATIVE');
assert.ok(BigInt(quote.outputAmount) > 0n);
assert.equal(quote.transaction_built, false);
assert.equal(quote.costs_verified, false);
assert.ok(Number.isFinite(quote.latency_ms));
assert.ok(quote.latency_ms <= 300, `Raydium hot quote SLA exceeded: ${quote.latency_ms}ms`);

// Historical false-positive guard: this CLMM is USDC/USDT, so it must never
// accept a WSOL/STONK quote just because its owner program is Raydium CLMM.
const HISTORICAL_MISMATCH_POOL = 'BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU';
const STONK = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
await assert.rejects(
  () => service.quote({
    inputMint: SOL,
    outputMint: STONK,
    amount: '100000000',
    slippageBps: 50,
    poolAddress: HISTORICAL_MISMATCH_POOL
  }),
  /raydium_clmm_mint_pair_mismatch/
);

console.log(JSON.stringify({
  ok: true,
  warm_pool_latency_ms: warmedPool.latency_ms,
  provider: quote.provider,
  pool_address: quote.pool_address,
  output_amount: quote.outputAmount,
  fee_amount: quote.tradeFeeAmount,
  price_impact_bps: quote.priceImpactPct === null ? null : quote.priceImpactPct * 10000,
  latency_ms: quote.latency_ms,
  scanner_sla_ms: 300,
  scanner_sla_passed: quote.latency_ms <= 300,
  safety: service.safety
}, null, 2));