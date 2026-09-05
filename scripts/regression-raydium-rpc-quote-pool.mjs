import assert from 'node:assert/strict';
import { createRaydiumRpcQuotePool, RAYDIUM_RPC_QUOTE_DEFAULTS } from '../services/api/src/raydium-rpc-quote-pool.mjs';

const token = 'TOKEN_MINT_TEST';
const usdc = 'USDC_MINT_TEST';
const clmmPool = 'RAYDIUM_CLMM_POOL_TEST';
const cpmmPool = 'RAYDIUM_CPMM_POOL_TEST';
const clmmProgram = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const cpmmProgram = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const splProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

class FakeBN {
  constructor(value) { this.value = BigInt(String(value)); }
  toString() { return this.value.toString(); }
}

class FakePublicKey {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
  toBase58() { return this.value; }
}

const connection = {
  async getSlot(commitment) {
    assert.equal(commitment, 'confirmed');
    return 123456;
  },
  async getBlockTime(slot) {
    assert.equal(slot, 123456);
    return 1788613200;
  }
};

const poolInfo = (programId, tokenProgram = splProgram) => ({
  id: programId === clmmProgram ? clmmPool : cpmmPool,
  programId,
  price: 2,
  mintA: { address: token, decimals: 6, programId: tokenProgram },
  mintB: { address: usdc, decimals: 6, programId: splProgram }
});

function sdkLoader({ tokenProgram = splProgram, pairOk = true, actualProgramOverride } = {}) {
  return async () => {
    const clmmInfo = poolInfo(actualProgramOverride || clmmProgram, tokenProgram);
    if (!pairOk) clmmInfo.mintA = { ...clmmInfo.mintA, address: 'OTHER_TOKEN' };
    const cpmmInfo = poolInfo(actualProgramOverride || cpmmProgram, tokenProgram);
    if (!pairOk) cpmmInfo.mintA = { ...cpmmInfo.mintA, address: 'OTHER_TOKEN' };

    return {
      connection,
      BN: FakeBN,
      web3: { PublicKey: FakePublicKey },
      sdk: {
        PoolUtils: {
          computeAmountOut({ baseMint, amountIn, slippage, blockTimestamp, catchLiquidityInsufficient }) {
            assert.equal(slippage, 0);
            assert.equal(blockTimestamp, 1788613200);
            assert.equal(catchLiquidityInsufficient, true);
            if (String(baseMint) === usdc) {
              assert.equal(amountIn.toString(), '100000000');
              return {
                amountOut: { amount: new FakeBN('49500000'), fee: new FakeBN('0') },
                fee: new FakeBN('300000')
              };
            }
            assert.equal(String(baseMint), token);
            assert.equal(amountIn.toString(), '50000000');
            return {
              amountOut: { amount: new FakeBN('99000000'), fee: new FakeBN('0') },
              fee: new FakeBN('150000')
            };
          }
        }
      },
      raydium: {
        async fetchEpochInfo() { return { epoch: 1 }; },
        clmm: {
          async getPoolInfoFromRpc(poolAddress) {
            assert.equal(poolAddress, clmmPool);
            return {
              poolInfo: clmmInfo,
              rpcPoolInfo: { programId: new FakePublicKey(actualProgramOverride || clmmProgram) },
              computePoolInfo: { exBitmapInfo: {} },
              tickData: { [clmmPool]: { 0: {} } }
            };
          }
        },
        cpmm: {
          async getPoolInfoFromRpc(poolAddress) {
            assert.equal(poolAddress, cpmmPool);
            return {
              poolInfo: cpmmInfo,
              rpcData: { programId: new FakePublicKey(actualProgramOverride || cpmmProgram) },
              computePoolInfo: { id: cpmmPool }
            };
          },
          computeSwapAmount({ amountIn, outputMint, slippage, swapBaseIn }) {
            assert.equal(slippage, 0);
            assert.equal(swapBaseIn, true);
            if (String(outputMint) === token) {
              assert.equal(amountIn.toString(), '100000000');
              return { amountOut: new FakeBN('49500000'), fee: new FakeBN('300000') };
            }
            assert.equal(String(outputMint), usdc);
            assert.equal(amountIn.toString(), '50000000');
            return { amountOut: new FakeBN('99000000'), fee: new FakeBN('150000') };
          }
        }
      }
    };
  };
}

const quotePool = createRaydiumRpcQuotePool({
  connection,
  sdkLoader: sdkLoader(),
  usdcMint: usdc,
  slippageToleranceBps: 0
});

for (const request of [
  { pool_address: clmmPool, program_id: clmmProgram, pool_type: 'CLMM' },
  { pool_address: cpmmPool, program_id: cpmmProgram, pool_type: 'CPMM' }
]) {
  const result = await quotePool({
    ...request,
    token_mint: token,
    quote_mint: usdc,
    notional_usdc: 100,
    read_only: true,
    strategy: 'TWO_LEG_ARBITRAGE'
  });
  assert.ok(result.buy_price_usd > 2);
  assert.ok(result.sell_price_usd < 2);
  assert.equal(Math.round(result.buy_fee_bps), 30);
  assert.equal(Math.round(result.sell_fee_bps), 30);
  assert.ok(result.buy_price_impact_bps > 0);
  assert.ok(result.sell_price_impact_bps > 0);
  assert.equal(result.quote_verified, true);
  assert.equal(result.costs_verified, true);
  assert.equal(result.observed_slot, 123456);
  assert.match(result.quote_source, /^RAYDIUM_ONCHAIN_RPC_(CLMM|CPMM)_SLOT_123456$/);
  assert.equal(result.live_execution_authorized, false);
}

await assert.rejects(
  quotePool({ pool_address: clmmPool, program_id: clmmProgram, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: false, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_read_only_required/
);
await assert.rejects(
  quotePool({ pool_address: clmmPool, program_id: clmmProgram, token_mint: token, quote_mint: 'OTHER_QUOTE', notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_quote_mint_not_usdc/
);
await assert.rejects(
  quotePool({ pool_address: clmmPool, program_id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_program_unsupported/
);

const token2022QuotePool = createRaydiumRpcQuotePool({ connection, sdkLoader: sdkLoader({ tokenProgram: 'TokenzQdYUnsupported2022' }), usdcMint: usdc });
await assert.rejects(
  token2022QuotePool({ pool_address: clmmPool, program_id: clmmProgram, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_token2022_unsupported_fail_closed/
);

const mismatchQuotePool = createRaydiumRpcQuotePool({ connection, sdkLoader: sdkLoader({ pairOk: false }), usdcMint: usdc });
await assert.rejects(
  mismatchQuotePool({ pool_address: clmmPool, program_id: clmmProgram, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_pair_mismatch/
);

const wrongProgramQuotePool = createRaydiumRpcQuotePool({ connection, sdkLoader: sdkLoader({ actualProgramOverride: cpmmProgram }), usdcMint: usdc });
await assert.rejects(
  wrongProgramQuotePool({ pool_address: clmmPool, program_id: clmmProgram, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /raydium_rpc_program_mismatch/
);

assert.equal(RAYDIUM_RPC_QUOTE_DEFAULTS.clmm_program_id, clmmProgram);
assert.equal(RAYDIUM_RPC_QUOTE_DEFAULTS.cpmm_program_id, cpmmProgram);
assert.equal(RAYDIUM_RPC_QUOTE_DEFAULTS.live_execution_authorized, false);

console.log('raydium rpc quote regression: ok');
