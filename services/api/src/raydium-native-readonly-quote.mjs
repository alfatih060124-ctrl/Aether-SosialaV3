import { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  Raydium,
  PoolUtils,
  TxVersion,
  ClmmInstrument,
  MIN_SQRT_PRICE_X64_ADD_ONE,
  MAX_SQRT_PRICE_X64_SUB_ONE,
  makeSwapFixedInInstruction,
  makeSwapCpmmBaseInInstruction
} from '@raydium-io/raydium-sdk-v2';

const DEFAULT_TIMEOUT_MS = 900;
const MAX_EXECUTION_SNAPSHOT_AGE_MS = 3000;
const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_AMM_STABLE_PROGRAM = '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
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

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalMint(value) {
  const raw = value?.address ?? value?.mint ?? value;
  try { return new PublicKey(String(raw || '')).toBase58(); }
  catch { return null; }
}

function assertPoolMintPair(poolInfo, inputMint, outputMint, code = 'raydium_pool_mint_pair_mismatch') {
  const mintA = canonicalMint(poolInfo?.mintA);
  const mintB = canonicalMint(poolInfo?.mintB);
  const input = canonicalMint(inputMint);
  const output = canonicalMint(outputMint);
  const valid = Boolean(
    mintA && mintB && input && output && input !== output &&
    ((input === mintA && output === mintB) || (input === mintB && output === mintA))
  );
  if (!valid) throw new Error(code);
  return Object.freeze({ mintA, mintB });
}

export function createRaydiumNativeReadonlyQuoteService({
  rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  poolSnapshotTtlMs = 200
} = {}) {
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const connection = new Connection(rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });
  const poolSnapshots = new Map();
  const clmmSnapshots = new Map();
  const cpmmSnapshots = new Map();
  const poolKinds = new Map();
  const ownerScopes = new Map();
  let epochCache = null;
  const snapshotTtlMs = Math.max(25, Math.min(2900, Number(poolSnapshotTtlMs) || 200));

  async function detectPoolKind(poolAddress) {
    const key = String(poolAddress);
    const cached = poolKinds.get(key);
    if (cached) return cached;
    const info = await withTimeout(
      connection.getAccountInfo(new PublicKey(key), 'processed'),
      timeoutMs,
      'raydium_native_pool_owner_timeout'
    );
    if (!info) throw new Error('raydium_native_pool_not_found');
    const owner = info.owner.toBase58();
    const kind = owner === RAYDIUM_CLMM_PROGRAM
      ? 'CLMM'
      : owner === RAYDIUM_CPMM_PROGRAM
        ? 'CPMM'
        : [RAYDIUM_AMM_V4_PROGRAM, RAYDIUM_AMM_STABLE_PROGRAM].includes(owner)
          ? 'AMM_V4_V5'
          : 'UNSUPPORTED';
    poolKinds.set(key, kind);
    return kind;
  }

  async function epochInfo(scope) {
    const now = Date.now();
    if (epochCache && now - epochCache.observed_at_ms < 30_000) return epochCache.value;
    const value = await withTimeout(scope.fetchEpochInfo(), timeoutMs, 'raydium_epoch_info_timeout');
    epochCache = { value, observed_at_ms: Date.now() };
    return value;
  }

  async function loadClmmPool(poolAddress, { force = false } = {}) {
    const key = String(poolAddress);
    const now = Date.now();
    const cached = clmmSnapshots.get(key);
    const cachedAgeMs = cached ? now - cached.observed_at_ms : null;
    if (!force && cached && cachedAgeMs <= snapshotTtlMs) {
      return { ...cached, snapshot_age_ms: cachedAgeMs, cache_hit: true, refresh_error: null };
    }
    const scope = await raydium();
    try {
      const [loaded, epoch] = await Promise.all([
        withTimeout(scope.clmm.getPoolInfoFromRpc(key), Math.max(timeoutMs, 1200), 'raydium_clmm_pool_timeout'),
        epochInfo(scope)
      ]);
      const entry = { loaded, epoch, observed_at_ms: Date.now() };
      clmmSnapshots.set(key, entry);
      return { ...entry, snapshot_age_ms: 0, cache_hit: false, refresh_error: null };
    } catch (error) {
      if (!force && cached && cachedAgeMs !== null && cachedAgeMs <= MAX_EXECUTION_SNAPSHOT_AGE_MS) {
        return {
          ...cached,
          snapshot_age_ms: cachedAgeMs,
          cache_hit: true,
          refresh_error: String(error?.message || error)
        };
      }
      throw error;
    }
  }

  async function loadCpmmPool(poolAddress, { force = false } = {}) {
    const key = String(poolAddress);
    const now = Date.now();
    const cached = cpmmSnapshots.get(key);
    const cachedAgeMs = cached ? now - cached.observed_at_ms : null;
    if (!force && cached && cachedAgeMs <= snapshotTtlMs) {
      return { ...cached, snapshot_age_ms: cachedAgeMs, cache_hit: true, refresh_error: null };
    }
    const scope = await raydium();
    try {
      const loaded = await withTimeout(
        scope.cpmm.getPoolInfoFromRpc(key),
        Math.max(timeoutMs, 1200),
        'raydium_cpmm_pool_timeout'
      );
      const entry = { loaded, observed_at_ms: Date.now() };
      cpmmSnapshots.set(key, entry);
      return { ...entry, snapshot_age_ms: 0, cache_hit: false, refresh_error: null };
    } catch (error) {
      if (!force && cached && cachedAgeMs !== null && cachedAgeMs <= MAX_EXECUTION_SNAPSHOT_AGE_MS) {
        return {
          ...cached,
          snapshot_age_ms: cachedAgeMs,
          cache_hit: true,
          refresh_error: String(error?.message || error)
        };
      }
      throw error;
    }
  }

  async function ownerScope(publicKey) {
    const owner = publicKey instanceof PublicKey ? publicKey : new PublicKey(String(publicKey));
    const key = owner.toBase58();
    let pending = ownerScopes.get(key);
    if (!pending) {
      pending = (async () => {
        const scope = await Raydium.load({
          connection,
          owner,
          disableFeatureCheck: true,
          disableLoadToken: true,
          blockhashCommitment: 'processed'
        });
        await scope.account.fetchWalletTokenAccounts({ forceUpdate: true, commitment: 'processed' });
        return scope;
      })();
      ownerScopes.set(key, pending);
    }
    return pending;
  }
  async function loadPool(poolAddress, { force = false } = {}) {
    const key = String(poolAddress);
    const now = Date.now();
    const cached = poolSnapshots.get(key);
    const cachedAgeMs = cached ? now - cached.observed_at_ms : null;
    if (!force && cached && cachedAgeMs <= snapshotTtlMs) {
      return { ...cached, snapshot_age_ms: cachedAgeMs, cache_hit: true, refresh_error: null };
    }
    const scope = await raydium();
    try {
      const loaded = await withTimeout(
        scope.liquidity.getPoolInfoFromRpc({ poolId: key }),
        timeoutMs,
        'raydium_native_pool_timeout'
      );
      const entry = { loaded, observed_at_ms: Date.now() };
      poolSnapshots.set(key, entry);
      return { ...entry, snapshot_age_ms: 0, cache_hit: false, refresh_error: null };
    } catch (error) {
      if (!force && cached && cachedAgeMs !== null && cachedAgeMs <= MAX_EXECUTION_SNAPSHOT_AGE_MS) {
        return {
          ...cached,
          snapshot_age_ms: cachedAgeMs,
          cache_hit: true,
          refresh_error: String(error?.message || error)
        };
      }
      throw error;
    }
  }

  let raydiumPromise = null;
  async function raydium() {
    if (!raydiumPromise) {
      raydiumPromise = Raydium.load({
        connection,
        disableFeatureCheck: true,
        disableLoadToken: true,
        blockhashCommitment: 'processed'
      });
    }
    return raydiumPromise;
  }

  async function quoteLegacy({ poolAddress, inputMint, outputMint, amount, slippageBps }) {
    const started = Date.now();
    const scope = await raydium();
    const snapshot = await loadPool(poolAddress);
    const loaded = snapshot.loaded;
    assertPoolMintPair(loaded.poolInfo, inputMint, outputMint, 'raydium_amm_mint_pair_mismatch');
    const amountIn = new BN(String(amount));
    const result = scope.liquidity.computeAmountOut({
      poolInfo: loaded.poolInfo,
      amountIn,
      mintIn: new PublicKey(String(inputMint)),
      mintOut: new PublicKey(String(outputMint)),
      slippage: Math.max(0, Number(slippageBps) || 0) / 10_000
    });
    const latencyMs = Date.now() - started;
    if (latencyMs > timeoutMs) throw new Error('raydium_native_quote_timeout');
    const priceImpactPct = finite(result.priceImpact?.toString());
    return {
      provider: 'RAYDIUM_NATIVE',
      pool_type: 'AMM_V4_V5',
      pool_address: String(poolAddress),
      pool_pair_verified: true,
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      inputAmount: String(amountIn),
      outputAmount: result.amountOut.toString(),
      minimumOutputAmount: result.minAmountOut.toString(),
      tradeFeeAmount: result.fee.toString(),
      priceImpactPct: priceImpactPct === null ? null : priceImpactPct / 100,
      currentPrice: result.currentPrice?.toString?.() ?? null,
      executionPrice: result.executionPrice?.toString?.() ?? null,
      latency_ms: latencyMs,
      pool_snapshot_age_ms: snapshot.snapshot_age_ms,
      pool_snapshot_cache_hit: snapshot.cache_hit,
      pool_snapshot_refresh_error: snapshot.refresh_error || null,
      transaction_built: false,
      exact_transaction_fee_ready: false,
      costs_verified: false,
      native_build_context: Object.freeze({
        kind: 'RAYDIUM_AMM_V4_V5_SWAP',
        pool_address: String(poolAddress),
        input_mint: String(inputMint),
        output_mint: String(outputMint),
        input_amount: String(amountIn),
        minimum_output_amount: result.minAmountOut.toString()
      })
    };
  }

  async function quoteClmm({ poolAddress, inputMint, outputMint, amount, slippageBps }) {
    const started = Date.now();
    const snapshot = await loadClmmPool(poolAddress);
    const loaded = snapshot.loaded;
    assertPoolMintPair(loaded.poolInfo, inputMint, outputMint, 'raydium_clmm_mint_pair_mismatch');
    const amountIn = new BN(String(amount));
    const ticks = loaded.tickData?.[String(poolAddress)] || loaded.tickData;
    const result = PoolUtils.computeAmountOut({
      poolInfo: loaded.computePoolInfo,
      tickArrayCache: ticks,
      baseMint: new PublicKey(String(inputMint)),
      epochInfo: snapshot.epoch,
      amountIn,
      slippage: Math.max(0, Number(slippageBps) || 0) / 10_000,
      catchLiquidityInsufficient: true
    });
    const latencyMs = Date.now() - started;
    if (latencyMs > timeoutMs) throw new Error('raydium_native_quote_timeout');
    const amountOut = result?.amountOut?.amount?.toString?.();
    const minAmountOut = result?.minAmountOut?.amount?.toString?.();
    if (!amountOut || !minAmountOut) throw new Error('raydium_clmm_quote_amount_unavailable');
    const impactPercent = finite(result?.priceImpact?.toFixed?.(12));
    return {
      provider: 'RAYDIUM_NATIVE',
      pool_type: 'CLMM',
      pool_address: String(poolAddress),
      pool_pair_verified: true,
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      inputAmount: String(amountIn),
      outputAmount: amountOut,
      minimumOutputAmount: minAmountOut,
      tradeFeeAmount: result?.fee?.toString?.() ?? null,
      priceImpactPct: impactPercent === null ? null : impactPercent / 100,
      latency_ms: latencyMs,
      pool_snapshot_age_ms: snapshot.snapshot_age_ms,
      pool_snapshot_cache_hit: snapshot.cache_hit,
      pool_snapshot_refresh_error: snapshot.refresh_error || null,
      transaction_built: false,
      exact_transaction_fee_ready: false,
      costs_verified: false,
      native_build_context: Object.freeze({
        kind: 'RAYDIUM_CLMM_SWAP',
        pool_address: String(poolAddress),
        input_mint: String(inputMint),
        output_mint: String(outputMint),
        input_amount: String(amountIn),
        minimum_output_amount: minAmountOut,
        observation_id: String(loaded.poolKeys.observationId),
        remaining_accounts: Object.freeze((result.remainingAccounts || []).map(value => String(value)))
      })
    };
  }

  async function quoteCpmm({ poolAddress, inputMint, outputMint, amount, slippageBps }) {
    const started = Date.now();
    const scope = await raydium();
    const snapshot = await loadCpmmPool(poolAddress);
    const loaded = snapshot.loaded;
    assertPoolMintPair(loaded.poolInfo, inputMint, outputMint, 'raydium_cpmm_mint_pair_mismatch');
    const amountIn = new BN(String(amount));
    const slippage = Math.max(0, Number(slippageBps) || 0) / 10_000;
    const result = scope.cpmm.computeSwapAmount({
      pool: loaded.computePoolInfo,
      amountIn,
      outputMint: new PublicKey(String(outputMint)),
      slippage,
      swapBaseIn: true
    });
    const latencyMs = Date.now() - started;
    if (latencyMs > timeoutMs) throw new Error('raydium_native_quote_timeout');
    const amountOut = result?.amountOut?.toString?.();
    const minAmountOut = result?.minAmountOut?.toString?.();
    if (!amountOut || !minAmountOut) throw new Error('raydium_cpmm_quote_amount_unavailable');
    const impact = finite(result?.priceImpact?.toString?.());
    return {
      provider: 'RAYDIUM_NATIVE',
      pool_type: 'CPMM',
      pool_address: String(poolAddress),
      pool_pair_verified: true,
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      inputAmount: String(amountIn),
      outputAmount: amountOut,
      minimumOutputAmount: minAmountOut,
      tradeFeeAmount: result?.fee?.toString?.() ?? null,
      priceImpactPct: impact,
      executionPrice: result?.executionPrice?.toString?.() ?? null,
      latency_ms: latencyMs,
      pool_snapshot_age_ms: snapshot.snapshot_age_ms,
      pool_snapshot_cache_hit: snapshot.cache_hit,
      pool_snapshot_refresh_error: snapshot.refresh_error || null,
      transaction_built: false,
      exact_transaction_fee_ready: false,
      costs_verified: false,
      native_build_context: Object.freeze({
        kind: 'RAYDIUM_CPMM_SWAP',
        pool_address: String(poolAddress),
        input_mint: String(inputMint),
        output_mint: String(outputMint),
        input_amount: String(amountIn),
        output_amount: amountOut,
        minimum_output_amount: minAmountOut,
        slippage
      })
    };
  }

  async function quote({ inputMint, outputMint, amount, slippageBps = 50, poolAddress = null }) {
    if (!poolAddress) throw new Error('raydium_native_pool_required');
    const n = BigInt(String(amount));
    if (n <= 0n) throw new Error('raydium_native_amount_required');
    const kind = await detectPoolKind(poolAddress);
    if (kind === 'CLMM') {
      return quoteClmm({
        poolAddress,
        inputMint,
        outputMint,
        amount: String(n),
        slippageBps
      });
    }
    if (kind === 'CPMM') {
      return quoteCpmm({
        poolAddress,
        inputMint,
        outputMint,
        amount: String(n),
        slippageBps
      });
    }
    if (kind !== 'AMM_V4_V5') throw new Error('raydium_native_pool_kind_unsupported');
    return quoteLegacy({
      poolAddress,
      inputMint,
      outputMint,
      amount: String(n),
      slippageBps
    });
  }
  async function prepareUnsignedLeg(quoteResult, { simulationPublicKey = process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '' } = {}) {
    const ctx = quoteResult?.native_build_context;
    if (!ctx || !['RAYDIUM_AMM_V4_V5_SWAP','RAYDIUM_CLMM_SWAP','RAYDIUM_CPMM_SWAP'].includes(ctx.kind)) {
      throw new Error('raydium_native_build_context_required');
    }
    const payerRaw = String(simulationPublicKey || '').trim();
    if (!payerRaw) throw new Error('shadow_simulation_public_key_required');
    const payer = new PublicKey(payerRaw);

    if (ctx.kind === 'RAYDIUM_CPMM_SWAP') {
      const [snapshot, tokenAccountRentLamports] = await Promise.all([
        loadCpmmPool(ctx.pool_address),
        connection.getMinimumBalanceForRentExemption(165, 'processed')
      ]);
      const loaded = snapshot.loaded;
      const mintA = new PublicKey(loaded.poolInfo.mintA.address);
      const mintB = new PublicKey(loaded.poolInfo.mintB.address);
      const tokenProgramA = new PublicKey(String(loaded.poolInfo.mintA.programId || TOKEN_PROGRAM_ID));
      const tokenProgramB = new PublicKey(String(loaded.poolInfo.mintB.programId || TOKEN_PROGRAM_ID));
      // Exact setup-cost accounting is currently based on the canonical 165-byte
      // SPL token account. Keep CPMM Token-2022 build fail-closed until extension-
      // aware account rent is included in the exact cost ledger.
      if (!tokenProgramA.equals(TOKEN_PROGRAM_ID) || !tokenProgramB.equals(TOKEN_PROGRAM_ID)) {
        throw new Error('raydium_cpmm_token2022_native_builder_not_supported');
      }
      const inputMint = new PublicKey(ctx.input_mint);
      const outputMint = new PublicKey(ctx.output_mint);
      const inputIsA = inputMint.equals(mintA);
      const validPair = (inputIsA && outputMint.equals(mintB)) ||
        (inputMint.equals(mintB) && outputMint.equals(mintA));
      if (!validPair) throw new Error('raydium_cpmm_mint_pair_mismatch');

      const inputProgram = inputIsA ? tokenProgramA : tokenProgramB;
      const outputProgram = inputIsA ? tokenProgramB : tokenProgramA;
      const tokenAccountIn = associatedTokenAddress(payer, inputMint, inputProgram);
      const tokenAccountOut = associatedTokenAddress(payer, outputMint, outputProgram);
      const [inputAtaInfo, outputAtaInfo] = await Promise.all([
        connection.getAccountInfo(tokenAccountIn, 'processed'),
        connection.getAccountInfo(tokenAccountOut, 'processed')
      ]);
      const preInstructions = [];
      const missingAtas = [];
      if (!inputAtaInfo) {
        missingAtas.push(tokenAccountIn.toBase58());
        preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(
          payer, payer, inputMint, tokenAccountIn, inputProgram
        ));
      }
      if (!outputAtaInfo) {
        missingAtas.push(tokenAccountOut.toBase58());
        preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(
          payer, payer, outputMint, tokenAccountOut, outputProgram
        ));
      }

      const inputVault = new PublicKey(loaded.poolKeys.vault[inputIsA ? 'A' : 'B']);
      const outputVault = new PublicKey(loaded.poolKeys.vault[inputIsA ? 'B' : 'A']);
      const instruction = makeSwapCpmmBaseInInstruction(
        new PublicKey(loaded.poolInfo.programId),
        payer,
        new PublicKey(loaded.poolKeys.authority),
        new PublicKey(loaded.poolKeys.config.id),
        new PublicKey(loaded.poolInfo.id),
        tokenAccountIn,
        tokenAccountOut,
        inputVault,
        outputVault,
        inputProgram,
        outputProgram,
        inputMint,
        outputMint,
        new PublicKey(loaded.poolKeys.observationId),
        new BN(ctx.input_amount),
        new BN(ctx.minimum_output_amount)
      );
      return Object.freeze({
        payer,
        pre_instructions: Object.freeze([...preInstructions]),
        swap_instruction: instruction,
        swap_instructions: Object.freeze([instruction]),
        instructions: Object.freeze([...preInstructions, instruction]),
        missing_ata_addresses: Object.freeze(missingAtas),
        token_account_rent_lamports: Number(tokenAccountRentLamports || 0),
        source: 'RAYDIUM_CPMM_NATIVE_INSTRUCTION_SET'
      });
    }

    if (ctx.kind === 'RAYDIUM_CLMM_SWAP') {
      const [snapshot, tokenAccountRentLamports] = await Promise.all([
        loadClmmPool(ctx.pool_address),
        connection.getMinimumBalanceForRentExemption(165, 'processed')
      ]);
      const loaded = snapshot.loaded;
      const mintA = new PublicKey(loaded.poolInfo.mintA.address);
      const mintB = new PublicKey(loaded.poolInfo.mintB.address);
      assertPoolMintPair(loaded.poolInfo, ctx.input_mint, ctx.output_mint, 'raydium_clmm_mint_pair_mismatch');
      const tokenProgramA = String(loaded.poolInfo.mintA.programId || TOKEN_PROGRAM_ID);
      const tokenProgramB = String(loaded.poolInfo.mintB.programId || TOKEN_PROGRAM_ID);
      const hasToken2022 = tokenProgramA !== TOKEN_PROGRAM_ID.toBase58() || tokenProgramB !== TOKEN_PROGRAM_ID.toBase58();
      if (hasToken2022) {
        const scope = await ownerScope(payer);
        const built = await scope.clmm.swap({
          poolInfo: loaded.poolInfo,
          poolKeys: loaded.poolKeys,
          inputMint: ctx.input_mint,
          amountIn: new BN(ctx.input_amount),
          amountOutMin: new BN(ctx.minimum_output_amount),
          observationId: new PublicKey(ctx.observation_id),
          ownerInfo: { useSOLBalance: false, feePayer: payer },
          remainingAccounts: (ctx.remaining_accounts || []).map(value => new PublicKey(value)),
          associatedOnly: true,
          checkCreateATAOwner: true,
          txVersion: TxVersion.LEGACY,
          feePayer: payer
        });
        const instructions = Array.isArray(built?.transaction?.instructions) ? built.transaction.instructions : [];
        if (!instructions.length) throw new Error('raydium_clmm_token2022_instruction_build_failed');
        const preInstructions = instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
        const swapInstructions = instructions.filter(ix => !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
        if (!swapInstructions.length) throw new Error('raydium_clmm_token2022_swap_instruction_missing');
        const missingAtas = preInstructions
          .map(ix => ix.keys?.[1]?.pubkey?.toBase58?.())
          .filter(Boolean);
        return Object.freeze({
          payer,
          pre_instructions: Object.freeze([...preInstructions]),
          swap_instruction: swapInstructions[0],
          swap_instructions: Object.freeze([...swapInstructions]),
          instructions: Object.freeze([...instructions]),
          missing_ata_addresses: Object.freeze(missingAtas),
          token_account_rent_lamports: Number(tokenAccountRentLamports || 0),
          source: 'RAYDIUM_CLMM_TOKEN2022_NATIVE_INSTRUCTION_SET'
        });
      }
      const tokenAccountA = associatedTokenAddress(payer, mintA);
      const tokenAccountB = associatedTokenAddress(payer, mintB);
      const [tokenAInfo, tokenBInfo] = await Promise.all([
        connection.getAccountInfo(tokenAccountA, 'processed'),
        connection.getAccountInfo(tokenAccountB, 'processed')
      ]);
      const preInstructions = [];
      const missingAtas = [];
      if (!tokenAInfo) {
        missingAtas.push(tokenAccountA.toBase58());
        preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, payer, mintA, tokenAccountA));
      }
      if (!tokenBInfo) {
        missingAtas.push(tokenAccountB.toBase58());
        preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, payer, mintB, tokenAccountB));
      }
      const inputMint = new PublicKey(ctx.input_mint);
      const sqrtPriceLimitX64 = inputMint.equals(mintA)
        ? MIN_SQRT_PRICE_X64_ADD_ONE
        : MAX_SQRT_PRICE_X64_SUB_ONE;
      const swapInfo = ClmmInstrument.makeSwapBaseInInstructions({
        poolInfo: loaded.poolInfo,
        poolKeys: loaded.poolKeys,
        observationId: new PublicKey(ctx.observation_id),
        ownerInfo: {
          wallet: payer,
          tokenAccountA,
          tokenAccountB
        },
        inputMint,
        amountIn: new BN(ctx.input_amount),
        amountOutMin: new BN(ctx.minimum_output_amount),
        sqrtPriceLimitX64,
        remainingAccounts: (ctx.remaining_accounts || []).map(value => new PublicKey(value))
      });
      const swapInstructions = Array.isArray(swapInfo?.instructions) ? swapInfo.instructions : [];
      if (!swapInstructions.length) throw new Error('raydium_clmm_swap_instruction_missing');
      return Object.freeze({
        payer,
        pre_instructions: Object.freeze([...preInstructions]),
        swap_instruction: swapInstructions[0],
        swap_instructions: Object.freeze([...swapInstructions]),
        instructions: Object.freeze([...preInstructions, ...swapInstructions]),
        missing_ata_addresses: Object.freeze(missingAtas),
        token_account_rent_lamports: Number(tokenAccountRentLamports || 0),
        source: 'RAYDIUM_CLMM_NATIVE_INSTRUCTION_SET'
      });
    }

    const snapshot = await loadPool(ctx.pool_address);
    const loaded = snapshot.loaded;
    assertPoolMintPair(loaded.poolInfo, ctx.input_mint, ctx.output_mint, 'raydium_amm_mint_pair_mismatch');
    const inputMint = new PublicKey(ctx.input_mint);
    const outputMint = new PublicKey(ctx.output_mint);
    const [inputMintInfo, outputMintInfo, tokenAccountRentLamports] = await Promise.all([
      connection.getAccountInfo(inputMint, 'processed'),
      connection.getAccountInfo(outputMint, 'processed'),
      connection.getMinimumBalanceForRentExemption(165, 'processed')
    ]);
    if (!inputMintInfo || !outputMintInfo) throw new Error('raydium_mint_account_unavailable');
    if (!inputMintInfo.owner.equals(TOKEN_PROGRAM_ID) || !outputMintInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('raydium_token2022_native_builder_not_supported');
    const tokenAccountIn = associatedTokenAddress(payer, inputMint);
    const tokenAccountOut = associatedTokenAddress(payer, outputMint);
    const [inputAtaInfo, outputAtaInfo] = await Promise.all([
      connection.getAccountInfo(tokenAccountIn, 'processed'),
      connection.getAccountInfo(tokenAccountOut, 'processed')
    ]);
    const missingAtas = [];
    const preInstructions = [];
    if (!inputAtaInfo) { missingAtas.push(tokenAccountIn.toBase58()); preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, payer, inputMint, tokenAccountIn)); }
    if (!outputAtaInfo) { missingAtas.push(tokenAccountOut.toBase58()); preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, payer, outputMint, tokenAccountOut)); }
    const modelDataPubKey = loaded.poolKeys?.modelDataAccount ? new PublicKey(String(loaded.poolKeys.modelDataAccount)) : undefined;
    const instruction = makeSwapFixedInInstruction({
      poolKeys: loaded.poolKeys,
      userKeys: { tokenAccountIn, tokenAccountOut, owner: payer },
      amountIn: new BN(ctx.input_amount),
      minAmountOut: new BN(ctx.minimum_output_amount),
      ...(modelDataPubKey ? { modelDataPubKey } : {})
    }, Number(loaded.poolInfo?.version || 4));
    return Object.freeze({
      payer,
      pre_instructions: Object.freeze([...preInstructions]),
      swap_instruction: instruction,
      swap_instructions: Object.freeze([instruction]),
      instructions: Object.freeze([...preInstructions, instruction]),
      missing_ata_addresses: Object.freeze(missingAtas),
      token_account_rent_lamports: Number(tokenAccountRentLamports || 0),
      source: 'RAYDIUM_NATIVE_INSTRUCTION_SET'
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
    const value = simulated?.value || null;
    const simOk = Boolean(value && value.err === null);
    const simError = value?.err ?? null;
    return Object.freeze({
      transaction_built: true,
      exact_fee_lamports: exactFee,
      exact_transaction_fee_ready: exactFee !== null,
      simulation_attempted: true,
      simulation_ok: simOk,
      simulation_error: simError,
      simulation_account_state_available: simError !== 'AccountNotFound',
      simulation_route_execution_rejected: !simOk && simError !== 'AccountNotFound',
      units_consumed: Number.isFinite(Number(value?.unitsConsumed)) ? Number(value.unitsConsumed) : null,
      logs_observed: Array.isArray(value?.logs) ? value.logs.length : 0,
      ata_creations_required: prepared.missing_ata_addresses.length,
      rent_lamports_required: prepared.missing_ata_addresses.length * prepared.token_account_rent_lamports,
      source: 'RAYDIUM_NATIVE_BUILD+SOLANA_RPC',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  async function warm() {
    const started = Date.now();
    await withTimeout(raydium(), timeoutMs, 'raydium_native_init_timeout');
    return { ok: true, latency_ms: Date.now() - started };
  }
  async function warmPool({ poolAddress }) {
    if (!poolAddress) throw new Error('raydium_native_pool_required');
    const started = Date.now();
    const kind = await detectPoolKind(poolAddress);
    if (kind === 'CLMM') {
      const snapshot = await loadClmmPool(poolAddress, { force: true });
      return { ok: true, pool_type: 'CLMM', pool_address: String(poolAddress), latency_ms: Date.now() - started, observed_at_ms: snapshot.observed_at_ms };
    }
    if (kind === 'CPMM') {
      const snapshot = await loadCpmmPool(poolAddress, { force: true });
      return { ok: true, pool_type: 'CPMM', pool_address: String(poolAddress), latency_ms: Date.now() - started, observed_at_ms: snapshot.observed_at_ms };
    }
    if (kind !== 'AMM_V4_V5') throw new Error('raydium_native_pool_kind_unsupported');
    const snapshot = await loadPool(poolAddress, { force: true });
    return { ok: true, pool_type: 'AMM_V4_V5', pool_address: String(poolAddress), latency_ms: Date.now() - started, observed_at_ms: snapshot.observed_at_ms };
  }

  return {
    quote,
    observeUnsigned,
    prepareUnsignedLeg,
    warm,
    warmPool,
    safety: Object.freeze({
      read_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    })
  };
}