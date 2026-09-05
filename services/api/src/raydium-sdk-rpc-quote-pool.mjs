const finite = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const POOL_TYPES = Object.freeze({
  CLMM: 'CLMM',
  CPMM: 'CPMM',
  AMM: 'AMM'
});

function normalizePoolType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized.includes('CLMM') || normalized.includes('CONCENTRATED')) return POOL_TYPES.CLMM;
  if (normalized.includes('CPMM') || normalized.includes('CONSTANT')) return POOL_TYPES.CPMM;
  if (normalized === 'AMM' || normalized.includes('STANDARD') || normalized.includes('AMM V4')) return POOL_TYPES.AMM;
  throw new Error('raydium_rpc_pool_type_unsupported');
}

function rawAmount(human, decimals, code) {
  const amount = finite(human);
  const d = Number(decimals);
  if (!(amount > 0) || !Number.isInteger(d) || d < 0 || d > 18) throw new Error(code);
  const scaled = amount * (10 ** d);
  if (!Number.isSafeInteger(Math.round(scaled)) || scaled <= 0) throw new Error(code);
  return BigInt(Math.round(scaled));
}

function humanAmount(raw, decimals, code) {
  let value;
  try { value = BigInt(String(raw)); } catch { throw new Error(code); }
  const d = Number(decimals);
  if (value <= 0n || !Number.isInteger(d) || d < 0 || d > 18) throw new Error(code);
  return Number(value) / (10 ** d);
}

function bpsFromFraction(numeratorRaw, denominatorRaw, code) {
  let numerator;
  let denominator;
  try {
    numerator = BigInt(String(numeratorRaw));
    denominator = BigInt(String(denominatorRaw));
  } catch {
    throw new Error(code);
  }
  if (numerator < 0n || denominator <= 0n) throw new Error(code);
  const scaled = Number((numerator * 1_000_000n) / denominator) / 100;
  if (!Number.isFinite(scaled) || scaled < 0 || scaled > 10_000) throw new Error(code);
  return scaled;
}

function impactBps({ referencePrice, effectivePrice, side }) {
  const reference = finite(referencePrice);
  const effective = finite(effectivePrice);
  if (!(reference > 0) || !(effective > 0)) throw new Error('raydium_rpc_reference_price_required');
  const ratio = side === 'BUY'
    ? Math.max(0, effective / reference - 1)
    : Math.max(0, 1 - effective / reference);
  const bps = ratio * 10_000;
  if (!Number.isFinite(bps) || bps > 10_000) throw new Error('raydium_rpc_price_impact_invalid');
  return bps;
}

function validatePair(poolInfo, tokenMint, quoteMint) {
  const mintA = String(poolInfo?.mintA?.address || poolInfo?.mintA || '').trim();
  const mintB = String(poolInfo?.mintB?.address || poolInfo?.mintB || '').trim();
  if (!mintA || !mintB) throw new Error('raydium_rpc_pool_mints_required');
  if (!((mintA === tokenMint && mintB === quoteMint) || (mintA === quoteMint && mintB === tokenMint))) {
    throw new Error('raydium_rpc_pair_mismatch');
  }
  return { mintA, mintB };
}

function decimalsFor(poolInfo, mint) {
  if (String(poolInfo?.mintA?.address || poolInfo?.mintA || '') === mint) return Number(poolInfo?.mintA?.decimals);
  if (String(poolInfo?.mintB?.address || poolInfo?.mintB || '') === mint) return Number(poolInfo?.mintB?.decimals);
  return NaN;
}

function referenceTokenPrice(poolInfo, tokenMint, quoteMint) {
  const price = finite(poolInfo?.price);
  if (!(price > 0)) throw new Error('raydium_rpc_reference_price_required');
  const mintA = String(poolInfo?.mintA?.address || poolInfo?.mintA || '').trim();
  const mintB = String(poolInfo?.mintB?.address || poolInfo?.mintB || '').trim();
  if (mintA === tokenMint && mintB === quoteMint) return price;
  if (mintA === quoteMint && mintB === tokenMint) return 1 / price;
  throw new Error('raydium_rpc_pair_mismatch');
}

async function loadDefaultSdk() {
  const sdk = await import('@raydium-io/raydium-sdk-v2');
  return sdk;
}

export function createRaydiumSdkRpcQuotePool({
  raydium,
  sdkModule,
  now = () => new Date(),
  getSlot
} = {}) {
  if (!raydium || typeof raydium !== 'object') throw new Error('raydium_sdk_instance_required');

  return async function quotePool(request = {}) {
    const poolAddress = text(request.pool_address, 'raydium_rpc_pool_address_required');
    const tokenMint = text(request.token_mint, 'raydium_rpc_token_mint_required');
    const quoteMint = text(request.quote_mint, 'raydium_rpc_quote_mint_required');
    if (tokenMint === quoteMint) throw new Error('raydium_rpc_distinct_mints_required');
    if (request.read_only !== true) throw new Error('raydium_rpc_read_only_required');
    if (request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('raydium_rpc_strategy_invalid');
    const notionalUsdc = finite(request.notional_usdc);
    if (!(notionalUsdc > 0)) throw new Error('raydium_rpc_notional_required');

    const poolType = normalizePoolType(request.pool_type);
    if (poolType === POOL_TYPES.AMM) {
      throw new Error('raydium_rpc_amm_v4_quote_not_verified');
    }

    const sdk = sdkModule || await loadDefaultSdk();
    const BN = sdk.BN || sdk.default?.BN;
    if (typeof BN !== 'function') throw new Error('raydium_sdk_bn_required');

    let poolInfo;
    let quoteExactIn;

    if (poolType === POOL_TYPES.CPMM) {
      if (typeof raydium.cpmm?.getPoolInfoFromRpc !== 'function') throw new Error('raydium_cpmm_rpc_loader_required');
      const data = await raydium.cpmm.getPoolInfoFromRpc(poolAddress);
      poolInfo = data?.poolInfo;
      const rpcData = data?.rpcData;
      if (!poolInfo || !rpcData) throw new Error('raydium_cpmm_rpc_state_required');
      if (!sdk.CurveCalculator || !sdk.FeeOn) throw new Error('raydium_cpmm_math_required');
      quoteExactIn = async (inputMint, inputRaw) => {
        const baseIn = String(poolInfo.mintA.address) === inputMint;
        const result = sdk.CurveCalculator.swapBaseInput(
          new BN(inputRaw.toString()),
          baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
          baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
          rpcData.configInfo?.tradeFeeRate,
          rpcData.configInfo?.creatorFeeRate,
          rpcData.configInfo?.protocolFeeRate,
          rpcData.configInfo?.fundFeeRate,
          rpcData.feeOn === sdk.FeeOn.BothToken || rpcData.feeOn === sdk.FeeOn.OnlyTokenB
        );
        if (!result?.outputAmount || result?.tradeFee === undefined) throw new Error('raydium_cpmm_quote_invalid');
        return { outputRaw: result.outputAmount.toString(), feeRaw: result.tradeFee.toString(), inputRaw: result.inputAmount?.toString?.() || inputRaw.toString() };
      };
    } else {
      if (typeof raydium.clmm?.getSwapPoolInfo !== 'function') throw new Error('raydium_clmm_rpc_loader_required');
      if (typeof sdk.swapInternal !== 'function') throw new Error('raydium_clmm_math_required');
      quoteExactIn = async (inputMint, inputRaw) => {
        const initial = await raydium.clmm.getPoolInfoFromRpc(poolAddress);
        poolInfo = initial?.poolInfo;
        if (!poolInfo) throw new Error('raydium_clmm_rpc_state_required');
        const zeroForOne = String(poolInfo.mintA.address) === inputMint;
        const swapData = await raydium.clmm.getSwapPoolInfo(poolAddress, zeroForOne);
        poolInfo = swapData?.poolInfo;
        if (!poolInfo || !swapData.rpcData || !swapData.configInfo || !swapData.tickArrays) throw new Error('raydium_clmm_swap_state_required');
        if (typeof raydium.connection?.getAccountInfo !== 'function' || typeof sdk.getPdaExBitmapAccount !== 'function' || !sdk.TickArrayBitmapExtensionLayout) {
          throw new Error('raydium_clmm_bitmap_loader_required');
        }
        const PublicKey = sdk.PublicKey;
        if (typeof PublicKey !== 'function') throw new Error('raydium_sdk_public_key_required');
        const bitmapKey = sdk.getPdaExBitmapAccount(new PublicKey(poolInfo.programId), new PublicKey(poolInfo.id)).publicKey;
        const bitmapAccount = await raydium.connection.getAccountInfo(bitmapKey);
        if (!bitmapAccount?.data) throw new Error('raydium_clmm_bitmap_required');
        const simulation = sdk.swapInternal({
          programId: new PublicKey(poolInfo.programId),
          poolId: new PublicKey(poolInfo.id),
          poolInfo: swapData.rpcData,
          tickArrays: swapData.tickArrays,
          configInfo: swapData.configInfo,
          tickarrayBitmapExtension: sdk.TickArrayBitmapExtensionLayout.decode(bitmapAccount.data),
          amountSpecified: new BN(inputRaw.toString()),
          sqrtPriceLimitX64: new BN(0),
          zeroForOne,
          isBaseInput: true,
          blockTimestamp: Math.floor(now().getTime() / 1000),
          includeExtraTickArrays: true
        });
        const outputRaw = simulation?.amountCalculated?.toString?.();
        const feeRaw = simulation?.feeAmount?.toString?.() ?? simulation?.tradeFee?.toString?.();
        if (!outputRaw || feeRaw === undefined) throw new Error('raydium_clmm_quote_fee_unverified');
        return { outputRaw, feeRaw, inputRaw: inputRaw.toString() };
      };
    }

    if (poolType === POOL_TYPES.CPMM) validatePair(poolInfo, tokenMint, quoteMint);

    const quoteDecimals = poolType === POOL_TYPES.CPMM ? decimalsFor(poolInfo, quoteMint) : null;
    const tokenDecimals = poolType === POOL_TYPES.CPMM ? decimalsFor(poolInfo, tokenMint) : null;
    const ensurePool = async () => {
      if (!poolInfo) {
        const data = await raydium.clmm.getPoolInfoFromRpc(poolAddress);
        poolInfo = data?.poolInfo;
      }
      validatePair(poolInfo, tokenMint, quoteMint);
      return {
        qd: Number.isInteger(quoteDecimals) ? quoteDecimals : decimalsFor(poolInfo, quoteMint),
        td: Number.isInteger(tokenDecimals) ? tokenDecimals : decimalsFor(poolInfo, tokenMint)
      };
    };

    const { qd, td } = await ensurePool();
    const quoteInputRaw = rawAmount(notionalUsdc, qd, 'raydium_rpc_quote_input_invalid');
    const buy = await quoteExactIn(quoteMint, quoteInputRaw);
    const tokenOut = humanAmount(buy.outputRaw, td, 'raydium_rpc_buy_output_invalid');
    const buyPrice = notionalUsdc / tokenOut;

    const referencePrice = referenceTokenPrice(poolInfo, tokenMint, quoteMint);
    const tokenSellHuman = notionalUsdc / referencePrice;
    const tokenSellRaw = rawAmount(tokenSellHuman, td, 'raydium_rpc_sell_input_invalid');
    const sell = await quoteExactIn(tokenMint, tokenSellRaw);
    const quoteOut = humanAmount(sell.outputRaw, qd, 'raydium_rpc_sell_output_invalid');
    const sellPrice = quoteOut / tokenSellHuman;

    const observed = now();
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) throw new Error('raydium_rpc_observed_at_invalid');
    const slot = typeof getSlot === 'function' ? await getSlot() : await raydium.connection?.getSlot?.();
    if (!Number.isInteger(Number(slot)) || Number(slot) < 0) throw new Error('raydium_rpc_observed_slot_required');

    return Object.freeze({
      buy_price_usd: buyPrice,
      sell_price_usd: sellPrice,
      buy_fee_bps: bpsFromFraction(buy.feeRaw, buy.inputRaw, 'raydium_rpc_buy_fee_invalid'),
      sell_fee_bps: bpsFromFraction(sell.feeRaw, sell.inputRaw, 'raydium_rpc_sell_fee_invalid'),
      buy_price_impact_bps: impactBps({ referencePrice, effectivePrice: buyPrice, side: 'BUY' }),
      sell_price_impact_bps: impactBps({ referencePrice, effectivePrice: sellPrice, side: 'SELL' }),
      quote_source: `RAYDIUM_${poolType}_SDK_ONCHAIN_RPC`,
      quote_verified: true,
      costs_verified: true,
      observed_at: observed.toISOString(),
      observed_slot: Number(slot),
      pool_type: poolType
    });
  };
}

export const RAYDIUM_SDK_RPC_QUOTE_POOL = Object.freeze({
  supported_pool_types: Object.freeze(['CLMM', 'CPMM']),
  fail_closed_pool_types: Object.freeze(['AMM_V4']),
  read_only: true,
  strategy: 'TWO_LEG_ARBITRAGE',
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
