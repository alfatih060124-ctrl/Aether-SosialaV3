import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(
  new URL('./vm-cross-venue-net-edge-probe.mjs',import.meta.url),
  'utf8'
);

assert.match(source,/const seedExpectedOutput = String\(seedBuy\.outputAmount \?\? seedBuy\.outAmount/);
assert.match(source,/let sellInputAmount = seedExpectedOutput/);
assert.match(source,/const guaranteedIntermediateAmount = String/);
assert.match(source,/couplingMode = 'EXACT_IN_EXPECTED_OUTPUT_ATOMIC_REVERT_GUARD'/);
assert.match(source,/couplingMode = 'EXACT_OUT_SELF_FINANCING'/);
assert.match(source,/const grossEdge = computeExecutableRoundTripEdgeBps\(buyExpectedInput, sell\.outAmount\)/);
assert.doesNotMatch(
  source,
  /const guaranteedBuyOutput[\s\S]{0,900}amount: guaranteedBuyOutput/
);
assert.match(source,/candidateMaxNotionalUsdc/);
assert.match(source,/candidateProbeNotionalUsdc/);
assert.match(source,/poolLiquidityCap/);
assert.match(source,/grossProfitUsdc/);
assert.match(source,/Two-pass sizing/);
assert.match(source,/nativeExactPairLimit/);
assert.match(source,/nativePreflightEnabled/);

console.log('cross-venue expected-output economics regression: PASS');