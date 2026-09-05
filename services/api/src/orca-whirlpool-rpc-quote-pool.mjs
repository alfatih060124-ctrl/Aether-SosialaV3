const OFFICIAL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

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

function toNativeAmount(uiAmount, decimals, code) {
  const amount = finite(uiAmount);
  const scale = 10 ** Number(decimals);
  const native = amount === null ? NaN : Math.round(amount * scale);
  if (!(amount > 0) || !Number.isSafeInteger(native) || native <= 0) throw new Error(code);
  return BigInt(native);
}

function toUiAmount(nativeAmount, decimals) {
  const numeric = Number(nativeAmount);
  const scale = 10 ** Number(decimals);
  if (!Number.isFinite(numeric) || !Number.isFinite(scale) || scale <= 0) return null;
  return numeric / scale;
}

function exactPair(poolData, tokenMint, quoteMint) {
  const a = String(poolData?.tokenMintA || '');
  const b = String(poolData?.tokenMintB || '');
  return (a === tokenMint && b === quoteMint) || (a === quoteMint && b === tokenMint);
}

function emptyTickArray(startTickIndex, size) {
  return {
    startTickIndex,
    ticks: Array(size).fill(null).map(() => ({
      initialized: false,
      liquidityNet: 0n,
      liquidityGross: 0n,
      feeGrowthOutsideA: 0n,
      feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n]
    }))
  };
}

async function defaultSdkLoader() {
  const [kit, client, core, token2022] = await Promise.all([
    import('@solana/kit'),
    import('@orca-so/whirlpools-client'),
    import('@orca-so/whirlpools-core'),
    import('@solana-program/token-2022')
  ]);
  return { kit, client, core, token2022 };
}

async function loadTickArrays({ rpc, whirlpool, client, core, deployment }) {
  const size = core._TICK_ARRAY_SIZE();
  const currentStart = core.getTickArrayStartTickIndex(
    whirlpool.data.tickCurrentIndex,
    whirlpool.data.tickSpacing
  );
  const offset = whirlpool.data.tickSpacing * size;
  const starts = [currentStart, currentStart + offset, currentStart + offset * 2, currentStart - offset, currentStart - offset * 2];
  const addresses = await Promise.all(starts.map(start => client.getTickArrayAddress(
    whirlpool.address,
    start,
    deployment.programId
  ).then(result => result[0])));
  const fetched = await client.fetchAllMaybeTickArray(rpc, addresses);
  if (!Array.isArray(fetched) || fetched.length !== starts.length) throw new Error('orca_rpc_tick_arrays_invalid');
  const data = fetched.map((entry, index) => entry?.exists === true ? entry.data : emptyTickArray(starts[index], size));
  return Object.freeze({
    addresses: Object.freeze(addresses.map(value => String(value))),
    data: Object.freeze(data)
  });
}

async function loadOracle({ rpc, whirlpool, client, deployment }) {
  const oracleAddress = await client.getOracleAddress(whirlpool.address, deployment.programId).then(result => result[0]);
  const feeTierIndex = whirlpool.data.feeTierIndexSeed[0] + whirlpool.data.feeTierIndexSeed[1] * 256;
  if (whirlpool.data.tickSpacing === feeTierIndex) {
    return Object.freeze({ address: String(oracleAddress), data: undefined });
  }
  const oracle = await client.fetchOracle(rpc, oracleAddress);
  if (!oracle?.data) throw new Error('orca_rpc_oracle_required');
  return Object.freeze({ address: String(oracleAddress), data: oracle.data });
}

function assertClassicMint(mintAccount) {
  if (String(mintAccount?.programAddress || '') !== SPL_TOKEN_PROGRAM_ID) {
    throw new Error('orca_rpc_token2022_unsupported_fail_closed');
  }
}

function feeBps(quote, inputAmount, code) {
  const fee = Number(quote?.tradeFee);
  const input = Number(inputAmount);
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

function minOut(quote, code) {
  const value = quote?.tokenMinOut;
  if (value === null || value === undefined) throw new Error(code);
  try {
    const amount = BigInt(String(value));
    if (amount <= 0n) throw new Error(code);
    return amount.toString();
  } catch {
    throw new Error(code);
  }
}

export function createOrcaWhirlpoolRpcQuotePool({
  rpcUrl,
  rpc: injectedRpc,
  sdkLoader = defaultSdkLoader,
  usdcMint = OFFICIAL_USDC_MINT,
  slippageToleranceBps = 0
} = {}) {
  if (typeof sdkLoader !== 'function') throw new Error('orca_rpc_sdk_loader_required');
  const configuredUsdcMint = text(usdcMint, 'orca_rpc_usdc_mint_required');
  const configuredSlippage = finite(slippageToleranceBps);
  if (configuredSlippage === null || configuredSlippage < 0 || configuredSlippage > 10_000) throw new Error('orca_rpc_slippage_bps_invalid');
  if (!injectedRpc && !String(rpcUrl || '').trim()) throw new Error('orca_rpc_url_required');

  let runtimePromise;
  async function runtime() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve(sdkLoader()).then(modules => {
        const { kit, client, core, token2022 } = modules || {};
        if (!kit || !client || !core || !token2022) throw new Error('orca_rpc_sdk_modules_required');
        const rpc = injectedRpc || kit.createSolanaRpc(String(rpcUrl).trim());
        return { rpc, kit, client, core, token2022 };
      });
    }
    return runtimePromise;
  }

  return async function quotePool(request = {}) {
    const poolAddress = text(request.pool_address, 'orca_rpc_pool_address_required');
    const tokenMint = text(request.token_mint, 'orca_rpc_token_mint_required');
    const quoteMint = text(request.quote_mint, 'orca_rpc_quote_mint_required');
    if (request.read_only !== true) throw new Error('orca_rpc_read_only_required');
    if (request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('orca_rpc_strategy_invalid');
    if (tokenMint === quoteMint) throw new Error('orca_rpc_distinct_mints_required');
    if (quoteMint !== configuredUsdcMint) throw new Error('orca_rpc_quote_mint_not_usdc');
    const notionalUsdc = finite(request.notional_usdc);
    if (!(notionalUsdc > 0)) throw new Error('orca_rpc_notional_usdc_required');

    const { rpc, kit, client, core, token2022 } = await runtime();
    const address = kit.address;
    const deployment = client.DEFAULT_WHIRLPOOL_DEPLOYMENT;
    if (!deployment?.programId) throw new Error('orca_rpc_deployment_required');

    const whirlpool = await client.fetchWhirlpool(rpc, address(poolAddress));
    if (!whirlpool?.data) throw new Error('orca_rpc_whirlpool_required');
    if (String(whirlpool.programAddress || '') !== String(deployment.programId)) throw new Error('orca_rpc_program_mismatch');
    if (!exactPair(whirlpool.data, tokenMint, quoteMint)) throw new Error('orca_rpc_pair_mismatch');
    const tokenVaultA = text(whirlpool.data.tokenVaultA, 'orca_rpc_token_vault_a_required');
    const tokenVaultB = text(whirlpool.data.tokenVaultB, 'orca_rpc_token_vault_b_required');

    const mintAccounts = await token2022.fetchAllMint(rpc, [address(tokenMint), address(quoteMint)]);
    if (!Array.isArray(mintAccounts) || mintAccounts.length !== 2 || !mintAccounts.every(account => account?.data)) {
      throw new Error('orca_rpc_mint_accounts_required');
    }
    const [tokenAccount, quoteAccount] = mintAccounts;
    assertClassicMint(tokenAccount);
    assertClassicMint(quoteAccount);
    const tokenDecimals = Number(tokenAccount.data.decimals);
    const quoteDecimals = Number(quoteAccount.data.decimals);
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) throw new Error('orca_rpc_token_decimals_invalid');
    if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) throw new Error('orca_rpc_quote_decimals_invalid');

    const tickArrays = await loadTickArrays({ rpc, whirlpool, client, core, deployment });
    const oracle = await loadOracle({ rpc, whirlpool, client, deployment });
    const slotRaw = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const slot = Number(slotRaw);
    if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('orca_rpc_slot_invalid');
    const blockTimeRaw = await rpc.getBlockTime(BigInt(slot)).send();
    const blockTime = Number(blockTimeRaw);
    if (!Number.isFinite(blockTime) || blockTime <= 0) throw new Error('orca_rpc_block_time_required');
    const timestamp = BigInt(Math.floor(blockTime));

    const tokenIsA = String(whirlpool.data.tokenMintA) === tokenMint;
    const quoteIsA = String(whirlpool.data.tokenMintA) === quoteMint;
    const rawSpot = Number(core.sqrtPriceToPrice(whirlpool.data.sqrtPrice,
      tokenIsA ? tokenDecimals : quoteDecimals,
      tokenIsA ? quoteDecimals : tokenDecimals));
    if (!(rawSpot > 0)) throw new Error('orca_rpc_spot_price_invalid');
    const spotPriceUsd = tokenIsA ? rawSpot : 1 / rawSpot;
    if (!(spotPriceUsd > 0)) throw new Error('orca_rpc_spot_price_invalid');

    const quoteInput = toNativeAmount(notionalUsdc, quoteDecimals, 'orca_rpc_buy_notional_invalid');
    const buyQuote = core.swapQuoteByInputToken(
      quoteInput,
      quoteIsA,
      configuredSlippage,
      whirlpool.data,
      oracle.data,
      tickArrays.data,
      timestamp
    );
    const boughtTokenUi = toUiAmount(buyQuote?.tokenEstOut, tokenDecimals);
    if (!(boughtTokenUi > 0)) throw new Error('orca_rpc_buy_quote_invalid');
    const buyPriceUsd = notionalUsdc / boughtTokenUi;

    const tokenNotionalUi = notionalUsdc / spotPriceUsd;
    const tokenInput = toNativeAmount(tokenNotionalUi, tokenDecimals, 'orca_rpc_sell_notional_invalid');
    const sellQuote = core.swapQuoteByInputToken(
      tokenInput,
      tokenIsA,
      configuredSlippage,
      whirlpool.data,
      oracle.data,
      tickArrays.data,
      timestamp
    );
    const soldTokenUi = toUiAmount(tokenInput, tokenDecimals);
    const quoteOutUi = toUiAmount(sellQuote?.tokenEstOut, quoteDecimals);
    if (!(soldTokenUi > 0) || !(quoteOutUi > 0)) throw new Error('orca_rpc_sell_quote_invalid');
    const sellPriceUsd = quoteOutUi / soldTokenUi;
    const observedAt = new Date(blockTime * 1000).toISOString();
    const tick0 = text(tickArrays.addresses[0], 'orca_rpc_tick_array_0_required');
    const tick1 = text(tickArrays.addresses[1], 'orca_rpc_tick_array_1_required');
    const tick2 = text(tickArrays.addresses[2], 'orca_rpc_tick_array_2_required');

    const instructionContext = Object.freeze({
      verified: true,
      source: 'ORCA_WHIRLPOOLS_ONCHAIN_RPC',
      source_slot: slot,
      observed_at: observedAt,
      program_id: String(deployment.programId),
      token_program: SPL_TOKEN_PROGRAM_ID,
      token_vault_a: tokenVaultA,
      token_vault_b: tokenVaultB,
      oracle: oracle.address,
      buy: Object.freeze({
        tick_array_0: tick0,
        tick_array_1: tick1,
        tick_array_2: tick2,
        amount: quoteInput.toString(),
        other_amount_threshold: minOut(buyQuote, 'orca_rpc_buy_min_out_required'),
        sqrt_price_limit: '0',
        amount_specified_is_input: true,
        a_to_b: quoteIsA
      }),
      sell: Object.freeze({
        tick_array_0: tick0,
        tick_array_1: tick1,
        tick_array_2: tick2,
        amount: tokenInput.toString(),
        other_amount_threshold: minOut(sellQuote, 'orca_rpc_sell_min_out_required'),
        sqrt_price_limit: '0',
        amount_specified_is_input: true,
        a_to_b: tokenIsA
      }),
      read_only: true,
      private_key_present: false,
      signature_present: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });

    return Object.freeze({
      buy_price_usd: buyPriceUsd,
      sell_price_usd: sellPriceUsd,
      buy_fee_bps: feeBps(buyQuote, quoteInput, 'orca_rpc_buy_fee_invalid'),
      sell_fee_bps: feeBps(sellQuote, tokenInput, 'orca_rpc_sell_fee_invalid'),
      buy_price_impact_bps: impactBps(buyPriceUsd, spotPriceUsd, 'BUY', 'orca_rpc_buy_impact_invalid'),
      sell_price_impact_bps: impactBps(sellPriceUsd, spotPriceUsd, 'SELL', 'orca_rpc_sell_impact_invalid'),
      liquidity_usd: null,
      quote_source: `ORCA_WHIRLPOOLS_ONCHAIN_RPC_SLOT_${slot}`,
      quote_verified: true,
      costs_verified: true,
      observed_at: observedAt,
      observed_slot: slot,
      instruction_context: instructionContext,
      read_only: true,
      live_execution_authorized: false
    });
  };
}

export const ORCA_WHIRLPOOL_RPC_QUOTE_DEFAULTS = Object.freeze({
  usdc_mint: OFFICIAL_USDC_MINT,
  spl_token_program_id: SPL_TOKEN_PROGRAM_ID,
  read_only: true,
  live_execution_authorized: false
});
