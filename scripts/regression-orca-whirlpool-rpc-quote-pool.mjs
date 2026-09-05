import assert from 'node:assert/strict';
import { createOrcaWhirlpoolRpcQuotePool } from '../services/api/src/orca-whirlpool-rpc-quote-pool.mjs';

const token = 'TOKEN_MINT_TEST';
const usdc = 'USDC_MINT_TEST';
const pool = 'ORCA_POOL_TEST';
const programId = 'ORCA_PROGRAM_TEST';
const splProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const rpc = {
  getSlot() { return { send: async () => 123456n }; },
  getBlockTime(slot) {
    assert.equal(slot, 123456n);
    return { send: async () => 1788613200n };
  }
};

function sdkLoader({ tokenProgram = splProgram, quoteProgram = splProgram, pairOk = true } = {}) {
  return async () => ({
    kit: {
      address: value => value,
      createSolanaRpc: () => { throw new Error('unexpected_rpc_creation'); }
    },
    client: {
      DEFAULT_WHIRLPOOL_DEPLOYMENT: { programId },
      async fetchWhirlpool() {
        return {
          address: pool,
          programAddress: programId,
          data: {
            tokenMintA: pairOk ? token : 'OTHER_TOKEN',
            tokenMintB: usdc,
            tokenVaultA: 'vault-a',
            tokenVaultB: 'vault-b',
            tickCurrentIndex: 0,
            tickSpacing: 64,
            feeTierIndexSeed: [64, 0],
            sqrtPrice: 1n
          }
        };
      },
      async getTickArrayAddress(_pool, start) { return [`tick-${start}`]; },
      async fetchAllMaybeTickArray(_rpc, addresses) {
        return addresses.map(() => ({ exists: false }));
      },
      async getOracleAddress() { return ['oracle']; },
      async fetchOracle() { throw new Error('oracle_should_not_be_loaded'); }
    },
    core: {
      _TICK_ARRAY_SIZE: () => 88,
      getTickArrayStartTickIndex: () => 0,
      sqrtPriceToPrice: () => 2,
      swapQuoteByInputToken(inputAmount, specifiedTokenA) {
        if (specifiedTokenA) {
          assert.equal(inputAmount, 50_000_000n);
          return { tokenEstOut: 99_500_000n, tokenMinOut: 99_500_000n, tradeFee: 150_000n };
        }
        assert.equal(inputAmount, 100_000_000n);
        return { tokenEstOut: 49_500_000n, tokenMinOut: 49_500_000n, tradeFee: 300_000n };
      }
    },
    token2022: {
      async fetchAllMint() {
        return [
          { programAddress: tokenProgram, data: { decimals: 6 } },
          { programAddress: quoteProgram, data: { decimals: 6 } }
        ];
      }
    }
  });
}

const quotePool = createOrcaWhirlpoolRpcQuotePool({
  rpc,
  sdkLoader: sdkLoader(),
  usdcMint: usdc,
  slippageToleranceBps: 0
});

const result = await quotePool({
  pool_address: pool,
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
assert.match(result.quote_source, /^ORCA_WHIRLPOOLS_ONCHAIN_RPC_SLOT_123456$/);
assert.equal(result.read_only, true);
assert.equal(result.live_execution_authorized, false);
assert.equal(result.instruction_context.verified, true);
assert.equal(result.instruction_context.source_slot, 123456);
assert.equal(result.instruction_context.token_vault_a, 'vault-a');
assert.equal(result.instruction_context.token_vault_b, 'vault-b');
assert.equal(result.instruction_context.oracle, 'oracle');
assert.equal(result.instruction_context.buy.amount, '100000000');
assert.equal(result.instruction_context.buy.other_amount_threshold, '49500000');
assert.equal(result.instruction_context.buy.a_to_b, false);
assert.equal(result.instruction_context.sell.amount, '50000000');
assert.equal(result.instruction_context.sell.other_amount_threshold, '99500000');
assert.equal(result.instruction_context.sell.a_to_b, true);
assert.equal(result.instruction_context.private_key_present, false);
assert.equal(result.instruction_context.network_submission_authorized, false);

await assert.rejects(
  quotePool({ pool_address: pool, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: false, strategy: 'TWO_LEG_ARBITRAGE' }),
  /orca_rpc_read_only_required/
);
await assert.rejects(
  quotePool({ pool_address: pool, token_mint: token, quote_mint: 'OTHER_QUOTE', notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /orca_rpc_quote_mint_not_usdc/
);

const token2022QuotePool = createOrcaWhirlpoolRpcQuotePool({
  rpc,
  sdkLoader: sdkLoader({ tokenProgram: 'TokenzQdYUnsupported2022' }),
  usdcMint: usdc
});
await assert.rejects(
  token2022QuotePool({ pool_address: pool, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /orca_rpc_token2022_unsupported_fail_closed/
);

const mismatchQuotePool = createOrcaWhirlpoolRpcQuotePool({ rpc, sdkLoader: sdkLoader({ pairOk: false }), usdcMint: usdc });
await assert.rejects(
  mismatchQuotePool({ pool_address: pool, token_mint: token, quote_mint: usdc, notional_usdc: 100, read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }),
  /orca_rpc_pair_mismatch/
);

console.log('orca whirlpool rpc quote regression: ok');
