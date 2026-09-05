import assert from 'node:assert/strict';
import { createRaydiumSdkRpcQuotePool, RAYDIUM_SDK_RPC_QUOTE_POOL } from '../services/api/src/raydium-sdk-rpc-quote-pool.mjs';

class FakeBN {
  constructor(value) { this.value = BigInt(String(value)); }
  toString() { return this.value.toString(); }
}
class FakePublicKey {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

const token = 'TOKEN';
const usdc = 'USDC';
const poolInfo = {
  id: 'pool',
  programId: 'program',
  mintA: { address: token, decimals: 6 },
  mintB: { address: usdc, decimals: 6 },
  price: 2
};

const cpmmSdk = {
  BN: FakeBN,
  FeeOn: { BothToken: 'BOTH', OnlyTokenB: 'B' },
  CurveCalculator: {
    swapBaseInput(input, reserveIn) {
      const isBuy = String(reserveIn) === '2000';
      return {
        inputAmount: input,
        outputAmount: new FakeBN(isBuy ? 24_750_000 : 49_500_000),
        tradeFee: new FakeBN(isBuy ? 150_000 : 75_000)
      };
    }
  }
};

const cpmmRaydium = {
  cpmm: {
    async getPoolInfoFromRpc(id) {
      assert.equal(id, 'pool-cpmm');
      return {
        poolInfo: { ...poolInfo, id },
        rpcData: {
          baseReserve: new FakeBN(1000),
          quoteReserve: new FakeBN(2000),
          configInfo: { tradeFeeRate: 1, creatorFeeRate: 0, protocolFeeRate: 0, fundFeeRate: 0 },
          feeOn: 'BOTH'
        }
      };
    }
  },
  connection: { async getSlot() { return 123; } }
};

const cpmmQuote = createRaydiumSdkRpcQuotePool({
  raydium: cpmmRaydium,
  sdkModule: cpmmSdk,
  now: () => new Date('2026-09-05T14:30:00.000Z')
});
const cpmm = await cpmmQuote({
  pool_address: 'pool-cpmm', pool_type: 'CPMM', token_mint: token, quote_mint: usdc,
  notional_usdc: 50, read_only: true, strategy: 'TWO_LEG_ARBITRAGE'
});
assert.equal(cpmm.pool_type, 'CPMM');
assert.equal(cpmm.quote_verified, true);
assert.equal(cpmm.costs_verified, true);
assert.equal(cpmm.observed_slot, 123);
assert.match(cpmm.quote_source, /^RAYDIUM_CPMM_SDK_ONCHAIN_RPC$/);
assert.ok(cpmm.buy_price_usd > 2);
assert.ok(cpmm.sell_price_usd < 2);
assert.ok(cpmm.buy_fee_bps > 0);
assert.ok(cpmm.sell_fee_bps > 0);

const clmmSdk = {
  BN: FakeBN,
  PublicKey: FakePublicKey,
  getPdaExBitmapAccount() { return { publicKey: new FakePublicKey('bitmap') }; },
  TickArrayBitmapExtensionLayout: { decode() { return { decoded: true }; } },
  swapInternal({ zeroForOne }) {
    return {
      amountCalculated: new FakeBN(zeroForOne ? 49_500_000 : 24_750_000),
      feeAmount: new FakeBN(zeroForOne ? 75_000 : 150_000)
    };
  }
};
const clmmRaydium = {
  clmm: {
    async getPoolInfoFromRpc(id) { return { poolInfo: { ...poolInfo, id } }; },
    async getSwapPoolInfo(id) {
      return {
        poolInfo: { ...poolInfo, id }, rpcData: { observationId: 'obs' }, configInfo: { tradeFeeRate: 3000 }, tickArrays: { a: 1 }
      };
    }
  },
  connection: {
    async getAccountInfo(key) { assert.equal(key.toString(), 'bitmap'); return { data: Buffer.from([1]) }; },
    async getSlot() { return 456; }
  }
};
const clmmQuote = createRaydiumSdkRpcQuotePool({
  raydium: clmmRaydium,
  sdkModule: clmmSdk,
  now: () => new Date('2026-09-05T14:31:00.000Z')
});
const clmm = await clmmQuote({
  pool_address: 'pool-clmm', pool_type: 'CLMM', token_mint: token, quote_mint: usdc,
  notional_usdc: 50, read_only: true, strategy: 'TWO_LEG_ARBITRAGE'
});
assert.equal(clmm.pool_type, 'CLMM');
assert.equal(clmm.observed_slot, 456);
assert.match(clmm.quote_source, /^RAYDIUM_CLMM_SDK_ONCHAIN_RPC$/);
assert.equal(clmm.quote_verified, true);
assert.equal(clmm.costs_verified, true);

await assert.rejects(cpmmQuote({
  pool_address: 'pool', pool_type: 'AMM V4', token_mint: token, quote_mint: usdc,
  notional_usdc: 50, read_only: true, strategy: 'TWO_LEG_ARBITRAGE'
}), /raydium_rpc_amm_v4_quote_not_verified/);
await assert.rejects(cpmmQuote({
  pool_address: 'pool', pool_type: 'CPMM', token_mint: token, quote_mint: usdc,
  notional_usdc: 50, read_only: false, strategy: 'TWO_LEG_ARBITRAGE'
}), /raydium_rpc_read_only_required/);
await assert.rejects(cpmmQuote({
  pool_address: 'pool', pool_type: 'CPMM', token_mint: token, quote_mint: usdc,
  notional_usdc: 50, read_only: true, strategy: 'DIRECTIONAL'
}), /raydium_rpc_strategy_invalid/);

assert.deepEqual(RAYDIUM_SDK_RPC_QUOTE_POOL.supported_pool_types, ['CLMM', 'CPMM']);
assert.equal(RAYDIUM_SDK_RPC_QUOTE_POOL.live_execution_authorized, false);
assert.equal(RAYDIUM_SDK_RPC_QUOTE_POOL.network_submission_authorized, false);
console.log('raydium sdk rpc quote pool regression: ok');
