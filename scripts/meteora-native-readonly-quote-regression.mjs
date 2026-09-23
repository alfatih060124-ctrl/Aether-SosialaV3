import assert from 'node:assert/strict';
import { createMeteoraNativeReadonlyQuoteService } from '../services/api/src/meteora-native-readonly-quote.mjs';

const STONK = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const WSOL = 'So11111111111111111111111111111111111111112';
const POOL = 'zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX';

const service = createMeteoraNativeReadonlyQuoteService({
  timeoutMs: Number(process.env.METEORA_NATIVE_REGRESSION_TIMEOUT_MS || 900),
  stateTtlMs: 250
});
assert.equal(service.safety.read_only, true);
assert.equal(service.safety.transaction_submission, false);
assert.equal(service.safety.signer_requested, false);
assert.equal(service.safety.live_execution_authorized, false);

const warm = await service.warmPool({ poolAddress: POOL });
const xToY = await service.quote({
  inputMint: STONK,
  outputMint: WSOL,
  amount: '1000000',
  slippageBps: 50,
  poolAddress: POOL
});
const yToX = await service.quote({
  inputMint: WSOL,
  outputMint: STONK,
  amount: '1000000',
  slippageBps: 50,
  poolAddress: POOL
});

assert.equal(xToY.provider, 'METEORA_NATIVE');
assert.equal(yToX.provider, 'METEORA_NATIVE');
assert.ok(BigInt(xToY.outputAmount) > 0n);
assert.ok(BigInt(yToX.outputAmount) > 0n);
assert.ok(xToY.native_build_context);
assert.ok(yToX.native_build_context);

console.log(JSON.stringify({
  ok: true,
  provider: 'METEORA_NATIVE',
  warm_latency_ms: warm.latency_ms,
  x_to_y_latency_ms: xToY.latency_ms,
  y_to_x_latency_ms: yToX.latency_ms,
  x_to_y_output_raw: xToY.outputAmount,
  y_to_x_output_raw: yToX.outputAmount,
  x_to_y_price_impact_bps: xToY.priceImpactPct === null ? null : xToY.priceImpactPct * 10000,
  y_to_x_price_impact_bps: yToX.priceImpactPct === null ? null : yToX.priceImpactPct * 10000,
  scanner_sla_ms: 300,
  scanner_sla_passed: xToY.latency_ms <= 300 && yToX.latency_ms <= 300,
  safety: service.safety
}, null, 2));