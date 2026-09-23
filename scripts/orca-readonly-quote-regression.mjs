import assert from 'node:assert/strict';
import { createOrcaReadonlyQuoteService } from '../services/api/src/orca-readonly-quote.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_USDC_WHIRLPOOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

const service = createOrcaReadonlyQuoteService({
  timeoutMs: 300,
  poolCacheTtlMs: 10 * 60_000,
  snapshotCacheTtlMs: 2850
});

assert.equal(service.safety.read_only, true);
assert.equal(service.safety.transaction_submission, false);
assert.equal(service.safety.signer_requested, false);
assert.equal(service.safety.live_execution_authorized, false);

const warm = await service.warmPair({
  inputMint: SOL,
  outputMint: USDC,
  poolAddress: SOL_USDC_WHIRLPOOL,
  timeoutMs: 10_000
});
assert.ok(warm.pool_address);
// Mirror the production hot-path invariant: refresh the exact direction
// immediately before its <=300 ms quote. Warming both directions concurrently
// can create an artificial RPC burst and let the first snapshot age out while
// waiting for the second on a throttled provider.
const buySnapshot = await service.warmSnapshot({
  inputMint: USDC,
  outputMint: SOL,
  poolAddress: warm.pool_address,
  timeoutMs: 10_000
});

const buy = await service.quote({
  inputMint: USDC,
  outputMint: SOL,
  amount: '100000000',
  slippageBps: 100
});
assert.equal(buy.provider, 'ORCA');
assert.ok(BigInt(buy.outputAmount) > 0n);
assert.ok(Number.isFinite(buy.latency_ms));
assert.ok(buy.latency_ms <= 300);
assert.ok(Number.isFinite(Number(buy.priceImpactPct)));
assert.equal(buy.snapshot_cache_hit, true);

const sellSnapshot = await service.warmSnapshot({
  inputMint: SOL,
  outputMint: USDC,
  poolAddress: warm.pool_address,
  timeoutMs: 10_000
});

const sell = await service.quote({
  inputMint: SOL,
  outputMint: USDC,
  amount: buy.outputAmount,
  slippageBps: 100
});
assert.equal(sell.provider, 'ORCA');
assert.ok(BigInt(sell.outputAmount) > 0n);
assert.ok(sell.latency_ms <= 300);
assert.equal(sell.snapshot_cache_hit, true);

console.log(JSON.stringify({
  ok: true,
  pool_address: warm.pool_address,
  warm_latency_ms: warm.discovery_latency_ms,
  buy_snapshot_warm_ms: buySnapshot.latency_ms,
  sell_snapshot_warm_ms: sellSnapshot.latency_ms,
  buy_latency_ms: buy.latency_ms,
  sell_latency_ms: sell.latency_ms,
  buy_output_raw: buy.outputAmount,
  roundtrip_usdc_raw: sell.outputAmount,
  buy_price_impact_bps: Number(buy.priceImpactPct) * 10000,
  sell_price_impact_bps: Number(sell.priceImpactPct) * 10000
}, null, 2));