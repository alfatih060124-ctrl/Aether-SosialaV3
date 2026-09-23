import { address, createNoopSigner, createSolanaRpc } from '@solana/kit';
import { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  fetchAllMaybeTickArray,
  fetchAllWhirlpoolWithFilter,
  fetchMaybeOracle,
  fetchWhirlpool,
  getOracleAddress,
  getSwapInstruction,
  getSwapV2Instruction,
  getTickArrayAddress,
  whirlpoolTokenMintAFilter,
  whirlpoolTokenMintBFilter
} from '@orca-so/whirlpools-client';
import {
  getSqrtPriceSlippageBounds,
  getTickArrayStartTickIndex,
  swapQuoteByInputToken,
  swapQuoteByOutputToken
} from '@orca-so/whirlpools-core';
import {
  getAccountLenForMint,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint
} from '@solana/spl-token';

const DEFAULT_POOL_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_QUOTE_TIMEOUT_MS = 300;
const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 300;
const MAX_EXECUTION_SNAPSHOT_AGE_MS = 3000;
const TICK_ARRAY_SIZE = 88;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

function createAssociatedTokenAccountIdempotentInstruction(payer, owner, mint, ata, tokenProgram = TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  });
}

function toWeb3Instruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(String(ix.programAddress)),
    keys: (ix.accounts || []).map(meta => ({
      pubkey: new PublicKey(String(meta.address)),
      isSigner: Number(meta.role) >= 2,
      isWritable: Number(meta.role) === 1 || Number(meta.role) === 3
    })),
    data: Buffer.from(ix.data || [])
  });
}

function normalizeSimulation(value) {
  const v = value?.value || null;
  return {
    ok: Boolean(v && v.err === null),
    error: v?.err ?? null,
    units_consumed: Number.isFinite(Number(v?.unitsConsumed)) ? Number(v.unitsConsumed) : null,
    logs_observed: Array.isArray(v?.logs) ? v.logs.length : 0
  };
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function whirlpoolFacade(data) {
  return {
    feeTierIndexSeed: data.feeTierIndexSeed,
    tickSpacing: data.tickSpacing,
    feeRate: data.feeRate,
    protocolFeeRate: data.protocolFeeRate,
    liquidity: data.liquidity,
    sqrtPrice: data.sqrtPrice,
    tickCurrentIndex: data.tickCurrentIndex,
    feeGrowthGlobalA: data.feeGrowthGlobalA,
    feeGrowthGlobalB: data.feeGrowthGlobalB,
    rewardLastUpdatedTimestamp: data.rewardLastUpdatedTimestamp,
    rewardInfos: data.rewardInfos.map(item => ({
      emissionsPerSecondX64: item.emissionsPerSecondX64,
      growthGlobalX64: item.growthGlobalX64
    }))
  };
}

function priceImpactFraction({ amountIn, amountOut, inputIsA, sqrtPrice }) {
  const input = Number(amountIn);
  const output = Number(amountOut);
  const sqrt = Number(sqrtPrice) / (2 ** 64);
  if (![input, output, sqrt].every(Number.isFinite) || input <= 0 || output <= 0 || sqrt <= 0) return null;
  const rawSpotOutPerIn = inputIsA ? (sqrt * sqrt) : (1 / (sqrt * sqrt));
  const effectiveOutPerIn = output / input;
  if (!Number.isFinite(rawSpotOutPerIn) || rawSpotOutPerIn <= 0) return null;
  return Math.max(0, 1 - (effectiveOutPerIn / rawSpotOutPerIn));
}

export function createOrcaReadonlyQuoteService({
  rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim(),
  timeoutMs = DEFAULT_QUOTE_TIMEOUT_MS,
  poolCacheTtlMs = DEFAULT_POOL_CACHE_TTL_MS,
  snapshotCacheTtlMs = DEFAULT_SNAPSHOT_CACHE_TTL_MS
} = {}) {
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const rpc = createSolanaRpc(rpcUrl);
  const connection = new Connection(rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });
  const poolCache = new Map();
  const quoteSnapshotCache = new Map();

  function rememberPool(inputMint, outputMint, poolAddress) {
    poolCache.set(pairKey(inputMint, outputMint), {
      pool_address: String(poolAddress),
      cached_at: Date.now()
    });
  }

  function cachedPool(inputMint, outputMint) {
    const key = pairKey(inputMint, outputMint);
    const row = poolCache.get(key);
    if (!row) return null;
    if (Date.now() - row.cached_at > poolCacheTtlMs) {
      poolCache.delete(key);
      return null;
    }
    return row.pool_address;
  }

  async function validatePool(poolAddress, inputMint, outputMint, budgetMs) {
    const pool = await withTimeout(
      fetchWhirlpool(rpc, address(String(poolAddress))),
      budgetMs,
      'orca_pool_fetch_timeout'
    );

    const mintA = String(pool.data.tokenMintA);
    const mintB = String(pool.data.tokenMintB);
    const input = String(inputMint);
    const output = String(outputMint);
    const matches = (mintA === input && mintB === output) || (mintA === output && mintB === input);
    if (!matches) throw new Error('orca_pool_pair_mismatch');
    rememberPool(input, output, pool.address);
    return pool;
  }

  function snapshotKey(poolAddress, inputMint) {
    return String(poolAddress) + ':' + String(inputMint);
  }

  function cachedQuoteSnapshot(poolAddress, inputMint, { allowExpired = false } = {}) {
    const row = quoteSnapshotCache.get(snapshotKey(poolAddress, inputMint));
    if (!row) return null;
    const ageMs = Date.now() - row.observed_at_ms;
    if (ageMs > MAX_EXECUTION_SNAPSHOT_AGE_MS) return null;
    const ttl = Math.max(1, Number(snapshotCacheTtlMs) || DEFAULT_SNAPSHOT_CACHE_TTL_MS);
    if (!allowExpired && ageMs > ttl) return null;
    return { ...row, state_age_ms: ageMs, snapshot_expired: ageMs > ttl };
  }

  async function fetchQuoteSnapshot({ poolAddress, inputMint, outputMint, budgetMs }) {
    const started = Date.now();
    const input = String(inputMint);
    const output = String(outputMint);
    const poolStarted = Date.now();
    const pool = await validatePool(poolAddress, input, output, Math.max(1, budgetMs));
    const poolLatencyMs = Date.now() - poolStarted;
    const inputIsA = String(pool.data.tokenMintA) === input;
    if (!inputIsA && String(pool.data.tokenMintB) !== input) throw new Error('orca_input_mint_mismatch');

    const currentStart = getTickArrayStartTickIndex(pool.data.tickCurrentIndex, pool.data.tickSpacing);
    const step = pool.data.tickSpacing * TICK_ARRAY_SIZE;
    const direction = inputIsA ? -1 : 1;
    const starts = [currentStart, currentStart + direction * step, currentStart + direction * step * 2];
    const tickAddresses = [];
    for (const startTickIndex of starts) {
      const [tickAddress] = await getTickArrayAddress(pool.address, startTickIndex);
      tickAddresses.push(tickAddress);
    }

    const [oracleAddress] = await getOracleAddress(pool.address);
    const remaining = Math.max(1, budgetMs - (Date.now() - started));
    const tickStarted = Date.now();
    let oracleFetchError = null;
    const [maybeTickArrays, maybeOracle] = await Promise.all([
      withTimeout(
        fetchAllMaybeTickArray(rpc, tickAddresses),
        remaining,
        'orca_tick_array_timeout'
      ),
      withTimeout(
        fetchMaybeOracle(rpc, oracleAddress),
        remaining,
        'orca_oracle_timeout'
      ).catch(error => {
        // The oracle account is optional for non-adaptive Whirlpool pools. A
        // transient oracle RPC timeout must not discard an otherwise executable
        // pool. Adaptive-fee pools still fail closed later if quote math truly
        // requires oracle state.
        oracleFetchError = String(error?.message || error);
        return null;
      })
    ]);
    const tickLatencyMs = Date.now() - tickStarted;
    const tickArrays = maybeTickArrays
      .filter(account => account && account.exists !== false && account.data)
      .map(account => ({ startTickIndex: account.data.startTickIndex, ticks: account.data.ticks }));
    if (!tickArrays.length) throw new Error('orca_tick_arrays_unavailable');

    const snapshot = {
      pool,
      inputIsA,
      tickAddresses,
      tickArrays,
      oracleAddress,
      oracle: maybeOracle && maybeOracle.exists !== false && maybeOracle.data ? maybeOracle.data : null,
      pool_latency_ms: poolLatencyMs,
      tick_array_latency_ms: tickLatencyMs,
      observed_at_ms: Date.now()
    };
    quoteSnapshotCache.set(snapshotKey(pool.address, input), snapshot);
    return { ...snapshot, state_age_ms: 0 };
  }

  async function warmPair({ inputMint, outputMint, poolAddress = null, timeoutMs: warmTimeoutMs = 8000 }) {
    const started = Date.now();
    const input = address(String(inputMint));
    const output = address(String(outputMint));
    if (poolAddress) {
      const pool = await validatePool(poolAddress, input, output, warmTimeoutMs);
      return {
        provider: 'ORCA',
        pool_address: String(pool.address),
        discovery_latency_ms: Date.now() - started,
        source: 'POOL_HINT'
      };
    }

    const [forward, reverse] = await withTimeout(
      Promise.all([
        fetchAllWhirlpoolWithFilter(rpc, [
          whirlpoolTokenMintAFilter(input),
          whirlpoolTokenMintBFilter(output)
        ]),
        fetchAllWhirlpoolWithFilter(rpc, [
          whirlpoolTokenMintAFilter(output),
          whirlpoolTokenMintBFilter(input)
        ])
      ]),

      warmTimeoutMs,
      'orca_pool_discovery_timeout'
    );
    const pools = [...forward, ...reverse];
    if (!pools.length) throw new Error('orca_pool_not_found');
    pools.sort((a, b) => {
      if (a.data.liquidity === b.data.liquidity) return 0;
      return a.data.liquidity > b.data.liquidity ? -1 : 1;
    });
    const best = pools[0];
    rememberPool(input, output, best.address);
    return {
      provider: 'ORCA',
      pool_address: String(best.address),
      discovery_latency_ms: Date.now() - started,
      source: 'RPC_DISCOVERY',
      liquidity: String(best.data.liquidity)
    };
  }

  async function warmSnapshot({ inputMint, outputMint, poolAddress = null, timeoutMs: warmTimeoutMs = 8000 }) {
    const started = Date.now();
    const input = String(address(String(inputMint)));
    const output = String(address(String(outputMint)));
    let chosenPool = poolAddress ? String(poolAddress) : cachedPool(input, output);
    if (!chosenPool) {
      const warmed = await warmPair({ inputMint: input, outputMint: output, timeoutMs: warmTimeoutMs });
      chosenPool = warmed.pool_address;
    }
    const snapshot = await fetchQuoteSnapshot({
      poolAddress: chosenPool,
      inputMint: input,
      outputMint: output,
      budgetMs: warmTimeoutMs
    });
    return Object.freeze({
      ok: true,
      provider: 'ORCA',
      pool_address: String(snapshot.pool.address),
      latency_ms: Date.now() - started,
      observed_at_ms: snapshot.observed_at_ms,
      tick_arrays_loaded: snapshot.tickArrays.length
    });
  }

  async function quote({ inputMint, outputMint, amount, slippageBps = 50, poolAddress = null }) {
    const started = Date.now();
    const budget = Math.max(1, Math.min(2500, Number(timeoutMs) || DEFAULT_QUOTE_TIMEOUT_MS));
    const input = String(address(String(inputMint)));
    const output = String(address(String(outputMint)));
    const amountIn = BigInt(String(amount));
    if (amountIn <= 0n) throw new Error('orca_amount_required');

    const chosenPool = poolAddress ? String(poolAddress) : cachedPool(input, output);
    if (!chosenPool) throw new Error('orca_pool_cache_cold');

    let snapshot = cachedQuoteSnapshot(chosenPool, input);
    let snapshotCacheHit = Boolean(snapshot);
    let snapshotRefreshError = null;
    if (!snapshot) {
      const staleFallback = cachedQuoteSnapshot(chosenPool, input, { allowExpired: true });
      try {
        snapshot = await fetchQuoteSnapshot({
          poolAddress: chosenPool,
          inputMint: input,
          outputMint: output,
          budgetMs: Math.max(1, budget - (Date.now() - started))
        });
      } catch (error) {
        snapshotRefreshError = String(error?.message || error);
        if (!staleFallback || staleFallback.state_age_ms > MAX_EXECUTION_SNAPSHOT_AGE_MS) throw error;
        snapshot = staleFallback;
        snapshotCacheHit = true;
      }
    }

    const { pool, inputIsA, tickAddresses, tickArrays, oracleAddress, oracle } = snapshot;
    let result;
    try {
      result = swapQuoteByInputToken(
        amountIn,
        inputIsA,
        Math.max(1, Math.trunc(Number(slippageBps) || 50)),
        whirlpoolFacade(pool.data),
        oracle,
        tickArrays,
        BigInt(Math.floor(Date.now() / 1000))
      );
    } catch (error) {
      throw new Error('orca_quote_unavailable:' + String(error && error.message ? error.message : error));
    }

    const latencyMs = Date.now() - started;
    if (latencyMs > budget) throw new Error('orca_quote_timeout');
    const priceImpactPct = priceImpactFraction({
      amountIn,
      amountOut: result.tokenEstOut,
      inputIsA,
      sqrtPrice: pool.data.sqrtPrice
    });
    const sqrtBounds = getSqrtPriceSlippageBounds(pool.data.sqrtPrice, Math.max(1, Math.trunc(Number(slippageBps) || 50)));

    return {
      provider: 'ORCA',
      pool_address: String(pool.address),
      pool_pair_verified: true,
      inputMint: input,
      outputMint: output,
      inputAmount: String(result.tokenIn),
      outputAmount: String(result.tokenEstOut),
      minimumOutputAmount: String(result.tokenMinOut),
      tradeFeeAmount: String(result.tradeFee),
      tradeFeeRateMin: result.tradeFeeRateMin,
      tradeFeeRateMax: result.tradeFeeRateMax,
      priceImpactPct,
      latency_ms: latencyMs,
      pool_latency_ms: snapshotCacheHit ? 0 : snapshot.pool_latency_ms,
      tick_array_latency_ms: snapshotCacheHit ? 0 : snapshot.tick_array_latency_ms,
      tick_arrays_loaded: tickArrays.length,
      cache_hit: !poolAddress,
      snapshot_cache_hit: snapshotCacheHit,
      snapshot_refresh_error: snapshotRefreshError,
      pool_state_age_ms: snapshotCacheHit ? snapshot.state_age_ms : 0,
      native_build_context: Object.freeze({
        kind: 'ORCA_WHIRLPOOL_SWAP_V1',
        pool_address: String(pool.address),
        token_mint_a: String(pool.data.tokenMintA),
        token_mint_b: String(pool.data.tokenMintB),
        token_vault_a: String(pool.data.tokenVaultA),
        token_vault_b: String(pool.data.tokenVaultB),
        tick_array_0: String(tickAddresses[0]),
        tick_array_1: String(tickAddresses[1]),
        tick_array_2: String(tickAddresses[2]),
        oracle: String(oracleAddress),
        amount: String(result.tokenIn),
        other_amount_threshold: String(result.tokenMinOut),
        sqrt_price_limit: String(inputIsA ? sqrtBounds.minSqrtPrice : sqrtBounds.maxSqrtPrice),
        a_to_b: inputIsA,
        amount_specified_is_input: true
      })
    };
  }

  async function quoteExactOutput({ inputMint, outputMint, outputAmount, slippageBps = 50, poolAddress = null }) {
    const started = Date.now();
    const budget = Math.max(1, Math.min(2500, Number(timeoutMs) || DEFAULT_QUOTE_TIMEOUT_MS));
    const input = String(address(String(inputMint)));
    const output = String(address(String(outputMint)));
    const amountOut = BigInt(String(outputAmount));
    if (amountOut <= 0n) throw new Error('orca_output_amount_required');

    const chosenPool = poolAddress ? String(poolAddress) : cachedPool(input, output);
    if (!chosenPool) throw new Error('orca_pool_cache_cold');

    let snapshot = cachedQuoteSnapshot(chosenPool, input);
    let snapshotCacheHit = Boolean(snapshot);
    let snapshotRefreshError = null;
    if (!snapshot) {
      const staleFallback = cachedQuoteSnapshot(chosenPool, input, { allowExpired: true });
      try {
        snapshot = await fetchQuoteSnapshot({
          poolAddress: chosenPool,
          inputMint: input,
          outputMint: output,
          budgetMs: Math.max(1, budget - (Date.now() - started))
        });
      } catch (error) {
        snapshotRefreshError = String(error?.message || error);
        if (!staleFallback || staleFallback.state_age_ms > MAX_EXECUTION_SNAPSHOT_AGE_MS) throw error;
        snapshot = staleFallback;
        snapshotCacheHit = true;
      }
    }

    const { pool, inputIsA, tickAddresses, tickArrays, oracleAddress, oracle } = snapshot;
    let result;
    try {
      result = swapQuoteByOutputToken(
        amountOut,
        !inputIsA,
        Math.max(1, Math.trunc(Number(slippageBps) || 50)),
        whirlpoolFacade(pool.data),
        oracle,
        tickArrays,
        BigInt(Math.floor(Date.now() / 1000))
      );
    } catch (error) {
      throw new Error('orca_exact_out_quote_unavailable:' + String(error && error.message ? error.message : error));
    }

    const latencyMs = Date.now() - started;
    if (latencyMs > budget) throw new Error('orca_quote_timeout');
    const priceImpactPct = priceImpactFraction({
      amountIn: result.tokenEstIn,
      amountOut: result.tokenOut,
      inputIsA,
      sqrtPrice: pool.data.sqrtPrice
    });
    const sqrtBounds = getSqrtPriceSlippageBounds(
      pool.data.sqrtPrice,
      Math.max(1, Math.trunc(Number(slippageBps) || 50))
    );

    return {
      provider: 'ORCA',
      quote_mode: 'EXACT_OUT',
      pool_address: String(pool.address),
      pool_pair_verified: true,
      inputMint: input,
      outputMint: output,
      inputAmount: String(result.tokenEstIn),
      maximumInputAmount: String(result.tokenMaxIn),
      outputAmount: String(result.tokenOut),
      minimumOutputAmount: String(result.tokenOut),
      tradeFeeAmount: String(result.tradeFee),
      tradeFeeRateMin: result.tradeFeeRateMin,
      tradeFeeRateMax: result.tradeFeeRateMax,
      priceImpactPct,
      latency_ms: latencyMs,
      pool_latency_ms: snapshotCacheHit ? 0 : snapshot.pool_latency_ms,
      tick_array_latency_ms: snapshotCacheHit ? 0 : snapshot.tick_array_latency_ms,
      tick_arrays_loaded: tickArrays.length,
      cache_hit: !poolAddress,
      snapshot_cache_hit: snapshotCacheHit,
      snapshot_refresh_error: snapshotRefreshError,
      pool_state_age_ms: snapshotCacheHit ? snapshot.state_age_ms : 0,
      native_build_context: Object.freeze({
        kind: 'ORCA_WHIRLPOOL_SWAP_V1',
        pool_address: String(pool.address),
        token_mint_a: String(pool.data.tokenMintA),
        token_mint_b: String(pool.data.tokenMintB),
        token_vault_a: String(pool.data.tokenVaultA),
        token_vault_b: String(pool.data.tokenVaultB),
        tick_array_0: String(tickAddresses[0]),
        tick_array_1: String(tickAddresses[1]),
        tick_array_2: String(tickAddresses[2]),
        oracle: String(oracleAddress),
        amount: String(result.tokenOut),
        other_amount_threshold: String(result.tokenMaxIn),
        sqrt_price_limit: String(inputIsA ? sqrtBounds.minSqrtPrice : sqrtBounds.maxSqrtPrice),
        a_to_b: inputIsA,
        amount_specified_is_input: false
      })
    };
  }

  async function prepareUnsignedLeg(quoteResult, { simulationPublicKey = process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '' } = {}) {
    const ctx = quoteResult?.native_build_context;
    if (!ctx || ctx.kind !== 'ORCA_WHIRLPOOL_SWAP_V1') throw new Error('orca_native_build_context_required');
    const payerRaw = String(simulationPublicKey || '').trim();
    if (!payerRaw) throw new Error('shadow_simulation_public_key_required');
    const payer = new PublicKey(payerRaw);
    const mintA = new PublicKey(ctx.token_mint_a);
    const mintB = new PublicKey(ctx.token_mint_b);
    const [mintAInfo, mintBInfo] = await Promise.all([
      connection.getAccountInfo(mintA, 'processed'),
      connection.getAccountInfo(mintB, 'processed')
    ]);
    if (!mintAInfo || !mintBInfo) throw new Error('orca_mint_account_unavailable');

    const tokenProgramA = mintAInfo.owner;
    const tokenProgramB = mintBInfo.owner;
    const supportedPrograms = new Set([
      TOKEN_PROGRAM_ID.toBase58(),
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    ]);
    if (!supportedPrograms.has(tokenProgramA.toBase58()) || !supportedPrograms.has(tokenProgramB.toBase58())) {
      throw new Error('orca_token_program_unsupported');
    }

    const mintAState = unpackMint(mintA, mintAInfo, tokenProgramA);
    const mintBState = unpackMint(mintB, mintBInfo, tokenProgramB);
    const transferHookA = getTransferHook(mintAState);
    const transferHookB = getTransferHook(mintBState);
    if (transferHookA || transferHookB) throw new Error('orca_token2022_transfer_hook_requires_remaining_accounts');
    const transferFeeA = getTransferFeeConfig(mintAState);
    const transferFeeB = getTransferFeeConfig(mintBState);
    if (transferFeeA || transferFeeB) throw new Error('orca_token2022_transfer_fee_quote_not_verified');

    const [rentA, rentB] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(getAccountLenForMint(mintAState), 'processed'),
      connection.getMinimumBalanceForRentExemption(getAccountLenForMint(mintBState), 'processed')
    ]);
    const tokenOwnerAccountA = associatedTokenAddress(payer, mintA, tokenProgramA);
    const tokenOwnerAccountB = associatedTokenAddress(payer, mintB, tokenProgramB);
    const [ataAInfo, ataBInfo] = await Promise.all([
      connection.getAccountInfo(tokenOwnerAccountA, 'processed'),
      connection.getAccountInfo(tokenOwnerAccountB, 'processed')
    ]);
    const missingAtas = [];
    const missingAtaRentLamports = [];
    const preInstructions = [];
    if (!ataAInfo) {
      missingAtas.push(tokenOwnerAccountA.toBase58());
      missingAtaRentLamports.push(Number(rentA || 0));
      preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(
        payer, payer, mintA, tokenOwnerAccountA, tokenProgramA
      ));
    }
    if (!ataBInfo) {
      missingAtas.push(tokenOwnerAccountB.toBase58());
      missingAtaRentLamports.push(Number(rentB || 0));
      preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(
        payer, payer, mintB, tokenOwnerAccountB, tokenProgramB
      ));
    }

    const needsV2 = !tokenProgramA.equals(TOKEN_PROGRAM_ID) || !tokenProgramB.equals(TOKEN_PROGRAM_ID);
    const common = {
      tokenAuthority: createNoopSigner(address(payer.toBase58())),
      whirlpool: address(ctx.pool_address),
      tokenOwnerAccountA: address(tokenOwnerAccountA.toBase58()),
      tokenVaultA: address(ctx.token_vault_a),
      tokenOwnerAccountB: address(tokenOwnerAccountB.toBase58()),
      tokenVaultB: address(ctx.token_vault_b),
      tickArray0: address(ctx.tick_array_0),
      tickArray1: address(ctx.tick_array_1),
      tickArray2: address(ctx.tick_array_2),
      oracle: address(ctx.oracle),
      amount: BigInt(ctx.amount),
      otherAmountThreshold: BigInt(ctx.other_amount_threshold),
      sqrtPriceLimit: BigInt(ctx.sqrt_price_limit),
      amountSpecifiedIsInput: ctx.amount_specified_is_input !== false,
      aToB: ctx.a_to_b === true
    };
    const ix = needsV2
      ? getSwapV2Instruction({
          tokenProgramA: address(tokenProgramA.toBase58()),
          tokenProgramB: address(tokenProgramB.toBase58()),
          tokenMintA: address(mintA.toBase58()),
          tokenMintB: address(mintB.toBase58()),
          ...common,
          remainingAccountsInfo: null
        })
      : getSwapInstruction(common);
    const swapInstruction = toWeb3Instruction(ix);
    return Object.freeze({
      payer,
      pre_instructions: Object.freeze([...preInstructions]),
      swap_instruction: swapInstruction,
      swap_instructions: Object.freeze([swapInstruction]),
      instructions: Object.freeze([...preInstructions, swapInstruction]),
      missing_ata_addresses: Object.freeze(missingAtas),
      missing_ata_rent_lamports: Object.freeze(missingAtaRentLamports),
      token_account_rent_lamports: missingAtaRentLamports.length
        ? Math.max(...missingAtaRentLamports)
        : 0,
      swap_version: needsV2 ? 'V2' : 'V1',
      source: needsV2 ? 'ORCA_TOKEN2022_SWAP_V2_INSTRUCTION_SET' : 'ORCA_NATIVE_INSTRUCTION_SET'
    });
  }

  async function observeUnsigned(quoteResult, options = {}) {
    const prepared = await prepareUnsignedLeg(quoteResult, options);
    const latest = await connection.getLatestBlockhash('processed');
    const message = new TransactionMessage({
      payerKey: prepared.payer,
      recentBlockhash: latest.blockhash,
      instructions: prepared.instructions
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const [fee, simulated] = await Promise.all([
      connection.getFeeForMessage(message, 'processed'),
      connection.simulateTransaction(transaction, { commitment: 'processed', sigVerify: false, replaceRecentBlockhash: true })
    ]);
    const rawFee = fee?.value;
    const exactFee = rawFee !== null && rawFee !== undefined && Number.isSafeInteger(Number(rawFee)) && Number(rawFee) >= 0 ? Number(rawFee) : null;
    const sim = normalizeSimulation(simulated);
    return Object.freeze({
      transaction_built: true,
      exact_fee_lamports: exactFee,
      exact_transaction_fee_ready: exactFee !== null,
      simulation_attempted: true,
      simulation_ok: sim.ok,
      simulation_error: sim.error,
      simulation_account_state_available: sim.error !== 'AccountNotFound',
      simulation_route_execution_rejected: !sim.ok && sim.error !== 'AccountNotFound',
      units_consumed: sim.units_consumed,
      logs_observed: sim.logs_observed,
      ata_creations_required: prepared.missing_ata_addresses.length,
      rent_lamports_required: Array.isArray(prepared.missing_ata_rent_lamports)
        ? prepared.missing_ata_rent_lamports.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
        : prepared.missing_ata_addresses.length * prepared.token_account_rent_lamports,
      swap_version: prepared.swap_version || 'V1',
      source: prepared.swap_version === 'V2' ? 'ORCA_TOKEN2022_SWAP_V2_BUILD+SOLANA_RPC' : 'ORCA_NATIVE_BUILD+SOLANA_RPC',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  return {
    quote,
    quoteExactOutput,
    warmPair,
    warmSnapshot,
    observeUnsigned,
    prepareUnsignedLeg,
    safety: {
      read_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    }
  };
}