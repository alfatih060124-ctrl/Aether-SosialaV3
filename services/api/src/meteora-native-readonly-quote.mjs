import { createRequire } from 'node:module';
import { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';

const require = createRequire(import.meta.url);
const DLMM = require('@meteora-ag/dlmm');
const { getAccountLenForMint, unpackMint } = require('@solana/spl-token');

const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_STATE_TTL_MS = 250;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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

export function createMeteoraNativeReadonlyQuoteService({
  rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stateTtlMs = DEFAULT_STATE_TTL_MS
} = {}) {
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const connection = new Connection(rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });
  const pools = new Map();
  const binArraySnapshots = new Map();
  const budgetMs = Math.max(250, Math.min(2500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const ttlMs = Math.max(25, Math.min(2500, Number(stateTtlMs) || DEFAULT_STATE_TTL_MS));

  async function loadPool(poolAddress, { forceRefresh = false } = {}) {
    const key = String(poolAddress || '').trim();
    if (!key) throw new Error('meteora_native_pool_required');
    let row = pools.get(key) || null;
    if (!row) {
      const instance = await withTimeout(
        DLMM.create(connection, new PublicKey(key), { skipSolWrappingOperation: true }),
        Math.max(budgetMs, 1500),
        'meteora_native_pool_create_timeout'
      );
      row = { instance, refreshed_at_ms: Date.now() };
      pools.set(key, row);
      return { ...row, state_age_ms: 0, cache_hit: false };
    }
    const age = Date.now() - row.refreshed_at_ms;
    if (forceRefresh || age > ttlMs) {
      await withTimeout(row.instance.refetchStates(), budgetMs, 'meteora_native_state_refresh_timeout');
      row.refreshed_at_ms = Date.now();
      return { ...row, state_age_ms: 0, cache_hit: false };
    }
    return { ...row, state_age_ms: age, cache_hit: true };
  }

  function binSnapshotKey(poolAddress, swapForY) {
    return String(poolAddress) + ':' + (swapForY ? 'X_TO_Y' : 'Y_TO_X');
  }

  async function loadBinArrays(poolAddress, pool, swapForY, { forceRefresh = false } = {}) {
    const key = binSnapshotKey(poolAddress, swapForY);
    const now = Date.now();
    const cached = binArraySnapshots.get(key);
    if (!forceRefresh && cached && now - cached.observed_at_ms <= ttlMs) {
      return {
        bin_arrays: cached.bin_arrays,
        observed_at_ms: cached.observed_at_ms,
        state_age_ms: now - cached.observed_at_ms,
        cache_hit: true
      };
    }
    const binArrays = await withTimeout(
      pool.getBinArrayForSwap(swapForY),
      Math.max(budgetMs, 1500),
      'meteora_native_bin_array_timeout'
    );
    if (!Array.isArray(binArrays) || !binArrays.length) throw new Error('meteora_native_bin_array_unavailable');
    const record = {
      bin_arrays: Object.freeze([...binArrays]),
      observed_at_ms: Date.now()
    };
    binArraySnapshots.set(key, record);
    return {
      bin_arrays: record.bin_arrays,
      observed_at_ms: record.observed_at_ms,
      state_age_ms: 0,
      cache_hit: false
    };
  }

  function resolveSwapDirection(pool, inputMint, outputMint) {
    const input = inputMint instanceof PublicKey ? inputMint : new PublicKey(String(inputMint));
    const output = outputMint instanceof PublicKey ? outputMint : new PublicKey(String(outputMint));
    const tokenX = pool.tokenX.publicKey;
    const tokenY = pool.tokenY.publicKey;
    const xToY = input.equals(tokenX) && output.equals(tokenY);
    const yToX = input.equals(tokenY) && output.equals(tokenX);
    if (!xToY && !yToX) throw new Error('meteora_native_pool_pair_mismatch');
    return { input, output, swapForY: xToY };
  }

  async function warmSnapshot({ inputMint, outputMint, poolAddress }) {
    const started = Date.now();
    const loaded = await loadPool(poolAddress, { forceRefresh: true });
    const direction = resolveSwapDirection(loaded.instance, inputMint, outputMint);
    const bins = await loadBinArrays(poolAddress, loaded.instance, direction.swapForY, { forceRefresh: true });
    return Object.freeze({
      ok: true,
      provider: 'METEORA_NATIVE',
      pool_address: String(poolAddress),
      input_mint: direction.input.toBase58(),
      output_mint: direction.output.toBase58(),
      swap_for_y: direction.swapForY,
      latency_ms: Date.now() - started,
      observed_at_ms: Math.min(loaded.refreshed_at_ms, bins.observed_at_ms),
      bin_arrays_loaded: bins.bin_arrays.length
    });
  }

  async function warmPool({ poolAddress }) {
    const started = Date.now();
    const loaded = await loadPool(poolAddress, { forceRefresh: true });
    return Object.freeze({
      ok: true,
      provider: 'METEORA_NATIVE',
      pool_address: String(poolAddress),
      latency_ms: Date.now() - started,
      observed_at_ms: loaded.refreshed_at_ms
    });
  }

  async function quote({ inputMint, outputMint, amount, slippageBps = 50, poolAddress }) {
    const started = Date.now();
    const loaded = await loadPool(poolAddress);
    const pool = loaded.instance;
    const direction = resolveSwapDirection(pool, inputMint, outputMint);
    const input = direction.input;
    const output = direction.output;

    const amountIn = new BN(String(amount));
    if (amountIn.lte(new BN(0))) throw new Error('meteora_native_amount_required');
    const bins = await loadBinArrays(poolAddress, pool, direction.swapForY);
    const binArrays = bins.bin_arrays;

    const result = pool.swapQuote(
      amountIn,
      direction.swapForY,
      new BN(Math.max(1, Math.trunc(Number(slippageBps) || 50))),
      binArrays
    );
    const latencyMs = Date.now() - started;
    if (latencyMs > budgetMs) throw new Error('meteora_native_quote_timeout');
    const impactPercent = finite(result.priceImpact?.toString?.());

    return Object.freeze({
      provider: 'METEORA_NATIVE',
      pool_type: 'DLMM',
      pool_address: String(pool.pubkey),
      pool_pair_verified: true,
      inputMint: input.toBase58(),
      outputMint: output.toBase58(),
      inputAmount: String(result.consumedInAmount?.toString?.() || amountIn.toString()),
      outputAmount: result.outAmount.toString(),
      minimumOutputAmount: result.minOutAmount.toString(),
      tradeFeeAmount: result.fee.toString(),
      protocolFeeAmount: result.protocolFee.toString(),
      priceImpactPct: impactPercent === null ? null : impactPercent / 100,
      latency_ms: latencyMs,
      pool_state_age_ms: Math.max(loaded.state_age_ms, bins.state_age_ms),
      pool_state_cache_hit: loaded.cache_hit,
      bin_array_cache_hit: bins.cache_hit,
      bin_arrays_loaded: binArrays.length,
      transaction_built: false,
      exact_transaction_fee_ready: false,
      costs_verified: false,
      native_build_context: Object.freeze({
        kind: 'METEORA_DLMM_SWAP',
        pool_address: String(pool.pubkey),
        input_mint: input.toBase58(),
        output_mint: output.toBase58(),
        input_amount: amountIn.toString(),
        minimum_output_amount: result.minOutAmount.toString(),
        bin_arrays_pubkey: Object.freeze(result.binArraysPubkey.map(value => String(value)))
      })
    });
  }

  async function prepareUnsignedLeg(quoteResult, { simulationPublicKey = process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '' } = {}) {
    const ctx = quoteResult?.native_build_context;
    if (!ctx || ctx.kind !== 'METEORA_DLMM_SWAP') throw new Error('meteora_native_build_context_required');
    const payerRaw = String(simulationPublicKey || '').trim();
    if (!payerRaw) throw new Error('shadow_simulation_public_key_required');
    const payer = new PublicKey(payerRaw);
    const loaded = await loadPool(ctx.pool_address);
    const pool = loaded.instance;
    const inputMint = new PublicKey(ctx.input_mint);
    const outputMint = new PublicKey(ctx.output_mint);
    const [inputMintInfo, outputMintInfo] = await Promise.all([
      connection.getAccountInfo(inputMint, 'processed'),
      connection.getAccountInfo(outputMint, 'processed')
    ]);
    if (!inputMintInfo || !outputMintInfo) throw new Error('meteora_mint_account_unavailable');
    const inputTokenProgram = inputMintInfo.owner;
    const outputTokenProgram = outputMintInfo.owner;
    const inputMintState = unpackMint(inputMint, inputMintInfo, inputTokenProgram);
    const outputMintState = unpackMint(outputMint, outputMintInfo, outputTokenProgram);
    const [inputTokenAccountRentLamports, outputTokenAccountRentLamports] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(getAccountLenForMint(inputMintState), 'processed'),
      connection.getMinimumBalanceForRentExemption(getAccountLenForMint(outputMintState), 'processed')
    ]);
    const inputAta = associatedTokenAddress(payer, inputMint, inputTokenProgram);
    const outputAta = associatedTokenAddress(payer, outputMint, outputTokenProgram);
    const [inputAtaInfo, outputAtaInfo] = await Promise.all([
      connection.getAccountInfo(inputAta, 'processed'),
      connection.getAccountInfo(outputAta, 'processed')
    ]);
    const setupByAta = new Map();
    const setupRentByAta = new Map();
    if (!inputAtaInfo) {
      setupByAta.set(
        inputAta.toBase58(),
        createAssociatedTokenAccountIdempotentInstruction(payer, payer, inputMint, inputAta, inputTokenProgram)
      );
      setupRentByAta.set(inputAta.toBase58(), Number(inputTokenAccountRentLamports || 0));
    }
    if (!outputAtaInfo) {
      setupByAta.set(
        outputAta.toBase58(),
        createAssociatedTokenAccountIdempotentInstruction(payer, payer, outputMint, outputAta, outputTokenProgram)
      );
      setupRentByAta.set(outputAta.toBase58(), Number(outputTokenAccountRentLamports || 0));
    }
    const binArrays = (ctx.bin_arrays_pubkey || []).map(value => ({
      isSigner: false,
      isWritable: true,
      pubkey: new PublicKey(value)
    }));
    if (!binArrays.length) throw new Error('meteora_native_bin_array_required');
    const hook = pool.getPotentialToken2022IxDataAndAccounts(0);
    const swapInstruction = await pool.program.methods
      .swap2(new BN(ctx.input_amount), new BN(ctx.minimum_output_amount), { slices: hook.slices })
      .accountsPartial({
        lbPair: pool.pubkey,
        reserveX: pool.lbPair.reserveX,
        reserveY: pool.lbPair.reserveY,
        tokenXMint: pool.lbPair.tokenXMint,
        tokenYMint: pool.lbPair.tokenYMint,
        tokenXProgram: pool.tokenX.owner,
        tokenYProgram: pool.tokenY.owner,
        user: payer,
        userTokenIn: inputAta,
        userTokenOut: outputAta,
        binArrayBitmapExtension: pool.binArrayBitmapExtension ? pool.binArrayBitmapExtension.publicKey : null,
        oracle: pool.lbPair.oracle,
        hostFeeIn: null,
        memoProgram: MEMO_PROGRAM_ID
      })
      .remainingAccounts(hook.accounts || [])
      .remainingAccounts(binArrays)
      .instruction();
    const missingAtas = [...setupByAta.keys()];
    const missingAtaRentLamports = missingAtas.map(ata => Number(setupRentByAta.get(ata) || 0));
    const preInstructions = [...setupByAta.values()];
    const swapInstructions = [swapInstruction];
    return Object.freeze({
      payer,
      pre_instructions: Object.freeze([...preInstructions]),
      swap_instruction: swapInstructions[0],
      swap_instructions: Object.freeze([...swapInstructions]),
      instructions: Object.freeze([...preInstructions, ...swapInstructions]),
      missing_ata_addresses: Object.freeze(missingAtas),
      missing_ata_rent_lamports: Object.freeze(missingAtaRentLamports),
      token_account_rent_lamports: missingAtaRentLamports.length
        ? Math.max(...missingAtaRentLamports)
        : 0,
      source: 'METEORA_DLMM_NATIVE_INSTRUCTION_SET'
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
      source: 'METEORA_NATIVE_BUILD+SOLANA_RPC',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  return Object.freeze({
    quote,
    warmPool,
    warmSnapshot,
    prepareUnsignedLeg,
    observeUnsigned,
    safety: Object.freeze({
      read_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    })
  });
}