const OFFICIAL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finite = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

function toNativeAmount(uiAmount, decimals, BN, code) {
  const amount = finite(uiAmount);
  const scale = 10 ** Number(decimals);
  const native = amount === null ? NaN : Math.round(amount * scale);
  if (!(amount > 0) || !Number.isSafeInteger(native) || native <= 0) throw new Error(code);
  return new BN(String(native));
}

function toUiAmount(nativeAmount, decimals) {
  const numeric = Number(nativeAmount?.toString?.() ?? nativeAmount);
  const scale = 10 ** Number(decimals);
  if (!Number.isFinite(numeric) || !Number.isFinite(scale) || scale <= 0) return null;
  return numeric / scale;
}

function minusFee(amount) {
  if (amount && typeof amount === 'object' && amount.amount !== undefined) {
    const raw = Number(amount.amount?.toString?.() ?? amount.amount);
    const fee = Number(amount.fee?.toString?.() ?? amount.fee ?? 0);
    return raw - fee;
  }
  return Number(amount?.toString?.() ?? amount);
}

function exactPair(poolInfo, tokenMint, quoteMint) {
  const a = String(poolInfo?.mintA?.address ?? poolInfo?.mintA ?? '');
  const b = String(poolInfo?.mintB?.address ?? poolInfo?.mintB ?? '');
  return (a === tokenMint && b === quoteMint) || (a === quoteMint && b === tokenMint);
}

function assertClassicMints(poolInfo) {
  const a = String(poolInfo?.mintA?.programId || '');
  const b = String(poolInfo?.mintB?.programId || '');
  if (a !== SPL_TOKEN_PROGRAM_ID || b !== SPL_TOKEN_PROGRAM_ID) {
    throw new Error('raydium_rpc_token2022_unsupported_fail_closed');
  }
}

function programKind(programId) {
  if (programId === RAYDIUM_CLMM_PROGRAM_ID) return 'CLMM';
  if (programId === RAYDIUM_CPMM_PROGRAM_ID) return 'CPMM';
  return null;
}

function feeBps(feeAmount, inputAmount, code) {
  const fee = Number(feeAmount?.toString?.() ?? feeAmount);
  const input = Number(inputAmount?.toString?.() ?? inputAmount);
  if (!Number.isFinite(fee) || fee < 0 || !(input > 0)) throw new Error(code);
  const bps = (fee / input) * 10_000;
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(code);
  return bps;
}

function impactBps(effectivePrice, spotPrice, side, code) {
  if (!(effectivePrice > 0) || !(spotPrice > 0)) throw new Error(code);
  const impact = side === 'BUY'
    ? ((effectivePrice / spotPrice) - 1) * 10_000
    : (1 - (effectivePrice / spotPrice)) * 10_000;
  if (!Number.isFinite(impact)) throw new Error(code);
  return Math.max(0, impact);
}

async function defaultSdkLoader({ rpcUrl, connection: injectedConnection } = {}) {
  const [sdk, web3, bnModule] = await Promise.all([
    import('@raydium-io/raydium-sdk-v2'),
    import('@solana/web3.js'),
    import('bn.js')
  ]);
  const BN = bnModule.default || bnModule.BN;
  const connection = injectedConnection || new web3.Connection(String(rpcUrl).trim(), 'confirmed');
  const raydium = await sdk.Raydium.load({
    connection,
    disableFeatureCheck: true,
    disableLoadToken: true
  });
  return { sdk, web3, BN, connection, raydium };
}

export function createRaydiumRpcQuotePool({
  rpcUrl,
  connection: injectedConnection,
  sdkLoader = defaultSdkLoader,
  usdcMint = OFFICIAL_USDC_MINT,
  slippageToleranceBps = 0
} = {}) {
  if (typeof sdkLoader !== 'function') throw new Error('raydium_rpc_sdk_loader_required');
  const configuredUsdcMint = text(usdcMint, 'raydium_rpc_usdc_mint_required');
  const configuredSlippage = finite(slippageToleranceBps);
  if (configuredSlippage === null || configuredSlippage < 0 || configuredSlippage > 10_000) {
    throw new Error('raydium_rpc_slippage_bps_invalid');
  }
  if (!injectedConnection && !String(rpcUrl || '').trim() && sdkLoader === defaultSdkLoader) {
    throw new Error('raydium_rpc_url_required');
  }

  let runtimePromise;
  async function runtime() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve(sdkLoader({ rpcUrl, connection: injectedConnection })).then(modules => {
        const { sdk, web3, BN, connection, raydium } = modules || {};
        if (!sdk || !web3 || !BN || !connection || !raydium) throw new Error('raydium_rpc_sdk_modules_required');
        if (typeof connection.getSlot !== 'function' || typeof connection.getBlockTime !== 'function') {
          throw new Error('raydium_rpc_connection_invalid');
        }
        return { sdk, web3, BN, connection, raydium };
      });
    }
    return runtimePromise;
  }

  return async function quotePool(request = {}) {
    const poolAddress = text(request.pool_address, 'raydium_rpc_pool_address_required');
    const programId = text(request.program_id, 'raydium_rpc_program_id_required');
    const tokenMint = text(request.token_mint, 'raydium_rpc_token_mint_required');
    const quoteMint = text(request.quote_mint, 'raydium_rpc_quote_mint_required');
    if (request.read_only !== true) throw new Error('raydium_rpc_read_only_required');
    if (request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('raydium_rpc_strategy_invalid');
    if (tokenMint === quoteMint) throw new Error('raydium_rpc_distinct_mints_required');
    if (quoteMint !== configuredUsdcMint) throw new Error('raydium_rpc_quote_mint_not_usdc');
    const kind = programKind(programId);
    if (!kind) throw new Error('raydium_rpc_program_unsupported');
    const notionalUsdc = finite(request.notional_usdc);
    if (!(notionalUsdc > 0)) throw new Error('raydium_rpc_notional_usdc_required');

    const { sdk, web3, BN, connection, raydium } = await runtime();
    const PublicKey = web3.PublicKey;
    const slot = Number(await connection.getSlot('confirmed'));
    if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('raydium_rpc_slot_invalid');
    const blockTime = Number(await connection.getBlockTime(slot));
    if (!Number.isFinite(blockTime) || blockTime <= 0) throw new Error('raydium_rpc_block_time_required');
    const blockTimestamp = Math.floor(blockTime);
    const epochInfo = typeof raydium.fetchEpochInfo === 'function' ? await raydium.fetchEpochInfo() : undefined;
    if (!epochInfo) throw new Error('raydium_rpc_epoch_info_required');

    let poolInfo;
    let actualProgramId;
    let quoteExactIn;

    if (kind === 'CLMM') {
      if (typeof raydium.clmm?.getPoolInfoFromRpc !== 'function' || typeof sdk.PoolUtils?.computeAmountOut !== 'function') {
        throw new Error('raydium_rpc_clmm_sdk_required');
      }
      const state = await raydium.clmm.getPoolInfoFromRpc(poolAddress);
      poolInfo = state?.poolInfo;
      actualProgramId = String(state?.rpcPoolInfo?.programId?.toBase58?.() ?? state?.rpcPoolInfo?.programId ?? poolInfo?.programId ?? '');
      if (!poolInfo || !state?.computePoolInfo || !state?.tickData?.[poolAddress]) {
        throw new Error('raydium_rpc_clmm_state_required');
      }
      quoteExactIn = (inputMint, amountIn) => sdk.PoolUtils.computeAmountOut({
        poolInfo: state.computePoolInfo,
        tickarrayBitmapExtension: state.computePoolInfo.exBitmapInfo,
        tickArrayCache: state.tickData[poolAddress],
        baseMint: new PublicKey(inputMint),
        epochInfo,
        amountIn,
        slippage: configuredSlippage / 10_000,
        blockTimestamp,
        catchLiquidityInsufficient: true
      });
    } else {
      if (typeof raydium.cpmm?.getPoolInfoFromRpc !== 'function' || typeof raydium.cpmm?.computeSwapAmount !== 'function') {
        throw new Error('raydium_rpc_cpmm_sdk_required');
      }
      const state = await raydium.cpmm.getPoolInfoFromRpc(poolAddress);
      poolInfo = state?.poolInfo;
      actualProgramId = String(state?.rpcData?.programId?.toBase58?.() ?? state?.rpcData?.programId ?? poolInfo?.programId ?? '');
      if (!poolInfo || !state?.computePoolInfo) throw new Error('raydium_rpc_cpmm_state_required');
      quoteExactIn = (inputMint, amountIn) => {
        const outputMint = inputMint === String(poolInfo.mintA.address) ? poolInfo.mintB.address : poolInfo.mintA.address;
        return raydium.cpmm.computeSwapAmount({
          pool: state.computePoolInfo,
          amountIn,
          outputMint: new PublicKey(outputMint),
          slippage: configuredSlippage / 10_000,
          swapBaseIn: true
        });
      };
    }

    if (actualProgramId !== programId) throw new Error('raydium_rpc_program_mismatch');
    if (!exactPair(poolInfo, tokenMint, quoteMint)) throw new Error('raydium_rpc_pair_mismatch');
    assertClassicMints(poolInfo);

    const tokenDecimals = Number(poolInfo.mintA.address === tokenMint ? poolInfo.mintA.decimals : poolInfo.mintB.decimals);
    const quoteDecimals = Number(poolInfo.mintA.address === quoteMint ? poolInfo.mintA.decimals : poolInfo.mintB.decimals);
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) throw new Error('raydium_rpc_token_decimals_invalid');
    if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) throw new Error('raydium_rpc_quote_decimals_invalid');

    const rawSpot = finite(poolInfo.price ?? poolInfo.poolPrice?.toString?.() ?? poolInfo.poolPrice);
    if (!(rawSpot > 0)) throw new Error('raydium_rpc_spot_price_invalid');
    const tokenIsA = String(poolInfo.mintA.address) === tokenMint;
    const spotPriceUsd = tokenIsA ? rawSpot : 1 / rawSpot;
    if (!(spotPriceUsd > 0)) throw new Error('raydium_rpc_spot_price_invalid');

    const buyInput = toNativeAmount(notionalUsdc, quoteDecimals, BN, 'raydium_rpc_buy_notional_invalid');
    const buyQuote = await quoteExactIn(quoteMint, buyInput);
    const buyOutNative = kind === 'CLMM' ? minusFee(buyQuote?.amountOut) : Number(buyQuote?.amountOut?.toString?.() ?? buyQuote?.amountOut);
    const boughtTokenUi = toUiAmount(buyOutNative, tokenDecimals);
    if (!(boughtTokenUi > 0)) throw new Error('raydium_rpc_buy_quote_invalid');
    const buyPriceUsd = notionalUsdc / boughtTokenUi;

    const tokenNotionalUi = notionalUsdc / spotPriceUsd;
    const sellInput = toNativeAmount(tokenNotionalUi, tokenDecimals, BN, 'raydium_rpc_sell_notional_invalid');
    const sellQuote = await quoteExactIn(tokenMint, sellInput);
    const sellOutNative = kind === 'CLMM' ? minusFee(sellQuote?.amountOut) : Number(sellQuote?.amountOut?.toString?.() ?? sellQuote?.amountOut);
    const soldTokenUi = toUiAmount(sellInput, tokenDecimals);
    const quoteOutUi = toUiAmount(sellOutNative, quoteDecimals);
    if (!(soldTokenUi > 0) || !(quoteOutUi > 0)) throw new Error('raydium_rpc_sell_quote_invalid');
    const sellPriceUsd = quoteOutUi / soldTokenUi;

    const buyFee = buyQuote?.fee ?? buyQuote?.swapResult?.tradeFee;
    const sellFee = sellQuote?.fee ?? sellQuote?.swapResult?.tradeFee;

    return Object.freeze({
      buy_price_usd: buyPriceUsd,
      sell_price_usd: sellPriceUsd,
      buy_fee_bps: feeBps(buyFee, buyInput, 'raydium_rpc_buy_fee_invalid'),
      sell_fee_bps: feeBps(sellFee, sellInput, 'raydium_rpc_sell_fee_invalid'),
      buy_price_impact_bps: impactBps(buyPriceUsd, spotPriceUsd, 'BUY', 'raydium_rpc_buy_impact_invalid'),
      sell_price_impact_bps: impactBps(sellPriceUsd, spotPriceUsd, 'SELL', 'raydium_rpc_sell_impact_invalid'),
      liquidity_usd: null,
      quote_source: `RAYDIUM_ONCHAIN_RPC_${kind}_SLOT_${slot}`,
      quote_verified: true,
      costs_verified: true,
      observed_at: new Date(blockTime * 1000).toISOString(),
      observed_slot: slot,
      pool_type: kind,
      program_id: programId,
      read_only: true,
      live_execution_authorized: false
    });
  };
}

export const RAYDIUM_RPC_QUOTE_DEFAULTS = Object.freeze({
  usdc_mint: OFFICIAL_USDC_MINT,
  spl_token_program_id: SPL_TOKEN_PROGRAM_ID,
  clmm_program_id: RAYDIUM_CLMM_PROGRAM_ID,
  cpmm_program_id: RAYDIUM_CPMM_PROGRAM_ID,
  read_only: true,
  live_execution_authorized: false
});
