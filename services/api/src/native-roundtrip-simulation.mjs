import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRateLimitError(error) {
  return /429|too many requests|rate.?limit|connection rate limits exceeded/i.test(
    String(error?.message || error || '')
  );
}

async function rpcWithBoundedRetry(task, timeoutMs, code, { retries = 1, backoffMs = 125 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(task(), Math.max(1, timeoutMs), code);
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= retries) throw error;
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastError || new Error(code);
}

function simulationSummary(result) {
  const value = result?.value || null;
  const error = value?.err ?? null;
  const logs = Array.isArray(value?.logs) ? value.logs : [];
  return Object.freeze({
    ok: Boolean(value && error === null),
    error,
    account_state_available: error !== 'AccountNotFound',
    route_execution_rejected: error !== null && error !== 'AccountNotFound',
    units_consumed: Number.isFinite(Number(value?.unitsConsumed)) ? Number(value.unitsConsumed) : null,
    logs_observed: logs.length,
    error_log_tail: error === null ? Object.freeze([]) : Object.freeze(logs.slice(-12))
  });
}

function payerKey(prepared, label) {
  const value = prepared?.payer;
  if (!value) throw new Error(label + '_payer_required');
  return value instanceof PublicKey ? value : new PublicKey(String(value));
}

function addSetupInstructions(target, prepared) {
  const addresses = Array.isArray(prepared?.missing_ata_addresses) ? prepared.missing_ata_addresses : [];
  const instructions = Array.isArray(prepared?.pre_instructions) ? prepared.pre_instructions : [];
  const defaultRentLamports = Number(prepared?.token_account_rent_lamports || 0);
  const rentByAta = Array.isArray(prepared?.missing_ata_rent_lamports)
    ? prepared.missing_ata_rent_lamports.map(value => Math.max(0, Number(value) || 0))
    : [];
  if (addresses.length !== instructions.length) throw new Error('native_setup_instruction_mismatch');
  if (rentByAta.length && rentByAta.length !== addresses.length) throw new Error('native_setup_rent_mismatch');
  addresses.forEach((ata, index) => {
    const key = String(ata);
    const rentLamports = rentByAta.length ? rentByAta[index] : defaultRentLamports;
    if (!target.has(key)) target.set(key, { instruction: instructions[index], rent_lamports: rentLamports });
  });
}

function instructionFingerprint(instruction) {
  const keys = Array.isArray(instruction?.keys)
    ? instruction.keys.map(key => [
        key.pubkey?.toBase58?.() || String(key.pubkey || ''),
        key.isSigner === true,
        key.isWritable === true
      ])
    : [];
  return JSON.stringify([
    instruction?.programId?.toBase58?.() || String(instruction?.programId || ''),
    Buffer.from(instruction?.data || []).toString('base64'),
    keys
  ]);
}

function uniqueInstructions(groups) {
  const seen = new Set();
  const result = [];
  for (const instruction of groups.flat().filter(Boolean)) {
    const key = instructionFingerprint(instruction);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(instruction);
  }
  return result;
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function associatedTokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID
  )[0];
}

async function canonicalTokenBalance(connection, owner, mint) {
  try {
    const result = await rpcWithBoundedRetry(
      () => connection.getTokenAccountBalance(associatedTokenAddress(owner, mint), 'processed'),
      3000,
      'simulation_owner_token_balance_timeout'
    );
    return BigInt(result.value.amount);
  } catch (error) {
    // A genuinely absent token account means zero balance. Provider capacity
    // failures must not be silently rewritten as a zero-balance market fact.
    if (isRateLimitError(error)) throw error;
    return 0n;
  }
}

export async function resolveReadonlySimulationPublicKey({
  rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim(),
  preferredPublicKey = String(process.env.AETHER_SHADOW_SIMULATION_PUBLIC_KEY || '').trim(),
  inputMint,
  minimumInputAmount,
  signatureLimit = 8
} = {}) {
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const mint = new PublicKey(String(inputMint || ''));
  const minimum = BigInt(String(minimumInputAmount || '0'));
  if (minimum <= 0n) throw new Error('simulation_minimum_input_required');
  const connection = new Connection(rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });

  async function eligible(owner) {
    try {
      // This resolver runs before the hot decision clock. Keep its RPC reads
      // serial so validating one public simulation owner does not create a
      // three-request burst against the provider.
      const accountInfo = await rpcWithBoundedRetry(
        () => connection.getAccountInfo(owner, 'processed'),
        3000,
        'simulation_owner_account_timeout'
      );
      const validFeePayer = Boolean(
        accountInfo &&
        accountInfo.owner.equals(SystemProgram.programId) &&
        accountInfo.executable === false
      );
      if (!validFeePayer) return false;
      const lamports = await rpcWithBoundedRetry(
        () => connection.getBalance(owner, 'processed'),
        3000,
        'simulation_owner_balance_timeout'
      );
      if (lamports < 5_000_000) return false;
      const tokenBalance = await canonicalTokenBalance(connection, owner, mint);
      return tokenBalance >= minimum;
    } catch {
      return false;
    }
  }

  if (preferredPublicKey) {
    try {
      const owner = new PublicKey(preferredPublicKey);
      if (await eligible(owner)) {
        return Object.freeze({ public_key: owner.toBase58(), source: 'CONFIGURED_PUBLIC_KEY', address_exposed: false });
      }
    } catch {}
  }

  const signatures = await connection.getSignaturesForAddress(
    mint,
    { limit: Math.max(1, Math.min(12, Number(signatureLimit) || 8)) },
    'confirmed'
  );
  const owners = [];
  for (const signature of signatures) {
    let tx = null;
    try {
      tx = await connection.getParsedTransaction(signature.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
    } catch {}
    for (const row of tx?.meta?.preTokenBalances || []) {
      if (String(row?.mint || '') !== mint.toBase58()) continue;
      const amount = BigInt(String(row?.uiTokenAmount?.amount || '0'));
      const ownerString = String(row?.owner || '').trim();
      if (amount < minimum || !ownerString) continue;
      try {
        const owner = new PublicKey(ownerString);
        if (!owners.some(item => item.equals(owner))) owners.push(owner);
      } catch {}
    }
    if (owners.length >= 4) break;
    await new Promise(resolve => setTimeout(resolve, 180));
  }

  for (const owner of owners) {
    if (await eligible(owner)) {
      return Object.freeze({ public_key: owner.toBase58(), source: 'PUBLIC_CHAIN_RECENT_TOKEN_OWNER', address_exposed: false });
    }
  }
  throw new Error('readonly_simulation_owner_unavailable');
}

export function createNativeRoundtripSimulationService({
  rpcUrl = String(process.env.SOLANA_RPC_URL || '').trim(),
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!rpcUrl) throw new Error('solana_rpc_url_required');
  const connection = new Connection(rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true });
  const budget = Math.max(500, Math.min(10_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const cachedSimulationOwners = new Map();
  const lookupTableCache = new Map();

  async function loadLookupTables(preparedRows) {
    const addresses = [...new Set(preparedRows.flatMap(prepared =>
      Array.isArray(prepared?.address_lookup_table_addresses)
        ? prepared.address_lookup_table_addresses.map(String).filter(Boolean)
        : []
    ))];
    const tables = [];
    for (const address of addresses) {
      let table = lookupTableCache.get(address) || null;
      if (!table) {
        const response = await rpcWithBoundedRetry(
          () => connection.getAddressLookupTable(new PublicKey(address), { commitment: 'processed' }),
          budget,
          'native_roundtrip_lookup_table_timeout'
        );
        table = response?.value || null;
        if (!table) throw new Error('native_roundtrip_lookup_table_missing');
        lookupTableCache.set(address, table);
      }
      tables.push(table);
    }
    return tables;
  }

  async function warmSimulationOwner({ inputMint, minimumInputAmount }) {
    const mintKey = String(inputMint || '');
    const requested = BigInt(String(minimumInputAmount || '0'));
    if (!mintKey) throw new Error('simulation_input_mint_required');
    if (requested <= 0n) throw new Error('simulation_minimum_input_required');
    const cached = cachedSimulationOwners.get(mintKey) || null;
    if (cached && BigInt(cached.minimum_input_amount) >= requested) {
      return Object.freeze({
        source: cached.source,
        address_exposed: false,
        cache_hit: true
      });
    }
    const resolved = await resolveReadonlySimulationPublicKey({
      rpcUrl,
      inputMint: mintKey,
      minimumInputAmount: requested.toString()
    });
    const row = Object.freeze({
      public_key: resolved.public_key,
      source: resolved.source,
      input_mint: mintKey,
      minimum_input_amount: requested.toString()
    });
    cachedSimulationOwners.set(mintKey, row);
    return Object.freeze({
      source: resolved.source,
      address_exposed: false,
      cache_hit: false
    });
  }

  async function observePreparedRoundTrip({ buyPrepared, sellPrepared }) {
    const observedStartedAt = Date.now();
    const buyPayer = payerKey(buyPrepared, 'buy');
    const sellPayer = payerKey(sellPrepared, 'sell');
    if (!buyPayer.equals(sellPayer)) throw new Error('native_roundtrip_payer_mismatch');
    const buySwapInstructions = Array.isArray(buyPrepared?.swap_instructions) && buyPrepared.swap_instructions.length
      ? buyPrepared.swap_instructions
      : buyPrepared?.swap_instruction ? [buyPrepared.swap_instruction] : [];
    const sellSwapInstructions = Array.isArray(sellPrepared?.swap_instructions) && sellPrepared.swap_instructions.length
      ? sellPrepared.swap_instructions
      : sellPrepared?.swap_instruction ? [sellPrepared.swap_instruction] : [];
    if (!buySwapInstructions.length || !sellSwapInstructions.length) throw new Error('native_roundtrip_swap_instruction_required');

    const setup = new Map();
    addSetupInstructions(setup, buyPrepared);
    addSetupInstructions(setup, sellPrepared);
    const setupInstructions = [...setup.values()].map(item => item.instruction);
    const exactAccountSetupLamports = [...setup.values()].reduce(
      (sum, item) => sum + Math.max(0, Number(item.rent_lamports) || 0),
      0
    );
    const additionalPreInstructions = uniqueInstructions([
      Array.isArray(buyPrepared?.additional_pre_instructions) ? buyPrepared.additional_pre_instructions : [],
      Array.isArray(sellPrepared?.additional_pre_instructions) ? sellPrepared.additional_pre_instructions : []
    ]);
    const postInstructions = uniqueInstructions([
      Array.isArray(buyPrepared?.post_instructions) ? buyPrepared.post_instructions : [],
      Array.isArray(sellPrepared?.post_instructions) ? sellPrepared.post_instructions : []
    ]);
    const computeBudget = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const instructions = [
      computeBudget,
      ...additionalPreInstructions,
      ...setupInstructions,
      ...buySwapInstructions,
      ...sellSwapInstructions,
      ...postInstructions
    ];
    const lookupTables = await loadLookupTables([buyPrepared, sellPrepared]);

    const remainingBudgetMs = () => Math.max(1, budget - (Date.now() - observedStartedAt));
    const blockhashStartedAt = Date.now();
    const latest = await rpcWithBoundedRetry(
      () => connection.getLatestBlockhash('processed'),
      remainingBudgetMs(),
      'native_roundtrip_blockhash_timeout'
    );
    const blockhash_latency_ms = Date.now() - blockhashStartedAt;
    const message = new TransactionMessage({
      payerKey: buyPayer,
      recentBlockhash: latest.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(message);

    const rpcEvidenceStartedAt = Date.now();
    // Fee lookup + simulation used to fire as a burst. Under provider pressure
    // that doubled the chance of a 429 exactly at the qualification gate.
    // Keep them serial and allow one short, bounded retry on an explicit
    // rate-limit response while remaining inside the simulation budget.
    let fee = await rpcWithBoundedRetry(
      () => connection.getFeeForMessage(message, 'processed'),
      remainingBudgetMs(),
      'native_roundtrip_fee_timeout'
    );
    const simulated = await rpcWithBoundedRetry(
      () => connection.simulateTransaction(transaction, {
        commitment: 'processed',
        sigVerify: false,
        replaceRecentBlockhash: true
      }),
      remainingBudgetMs(),
      'native_roundtrip_simulation_timeout'
    );
    if (fee?.value === null || fee?.value === undefined) {
      await sleep(Math.min(100, Math.max(0, remainingBudgetMs() - 1)));
      fee = await rpcWithBoundedRetry(
        () => connection.getFeeForMessage(message, 'confirmed'),
        remainingBudgetMs(),
        'native_roundtrip_fee_retry_timeout'
      );
    }
    const rpc_evidence_latency_ms = Date.now() - rpcEvidenceStartedAt;

    const rawFeeLamports = fee?.value;
    const lamports = rawFeeLamports === null || rawFeeLamports === undefined ? NaN : Number(rawFeeLamports);
    const exactFeeLamports = Number.isSafeInteger(lamports) && lamports >= 0 ? lamports : null;
    const sim = simulationSummary(simulated);
    return Object.freeze({
      transaction_built: true,
      atomic_two_leg_transaction: true,
      atomic_two_leg: true,
      instruction_count: instructions.length,
      setup_instruction_count: setupInstructions.length,
      additional_pre_instruction_count: additionalPreInstructions.length,
      post_instruction_count: postInstructions.length,
      lookup_table_count: lookupTables.length,
      exact_fee_lamports: exactFeeLamports,
      exact_roundtrip_fee_lamports: exactFeeLamports,
      exact_account_setup_lamports: exactAccountSetupLamports,
      rent_lamports_required: exactAccountSetupLamports,
      exact_transaction_fee_ready: exactFeeLamports !== null,
      simulation_attempted: true,
      simulation_ok: sim.ok,
      roundtrip_simulation_ok: sim.ok,
      simulation_error: sim.error,
      simulation_account_state_available: sim.account_state_available,
      simulation_state_limited: !sim.account_state_available,
      simulation_route_execution_rejected: sim.route_execution_rejected,
      units_consumed: sim.units_consumed,
      logs_observed: sim.logs_observed,
      simulation_error_log_tail: sim.error_log_tail,
      blockhash_latency_ms,
      rpc_evidence_latency_ms,
      build_simulation_latency_ms: Date.now() - observedStartedAt,
      source: 'NATIVE_ATOMIC_TWO_LEG_BUILD+SOLANA_RPC',
      read_only: true,
      mode: 'SHADOW',
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  }

  async function observe({ buyService, buyQuote, sellService, sellQuote }) {
    const observeStartedAt = Date.now();
    if (!buyService?.prepareUnsignedLeg || !sellService?.prepareUnsignedLeg) {
      throw new Error('native_roundtrip_prepare_service_required');
    }
    const inputMint = String(buyQuote?.inputMint || buyQuote?.input_mint || '');
    const inputAmount = String(buyQuote?.inputAmount || buyQuote?.inAmount || buyQuote?.in_amount || '');
    if (!inputMint || !/^\d+$/.test(inputAmount) || BigInt(inputAmount) <= 0n) {
      throw new Error('native_roundtrip_input_evidence_required');
    }
    const ownerStartedAt = Date.now();
    await warmSimulationOwner({ inputMint, minimumInputAmount: inputAmount });
    const simulation_owner_latency_ms = Date.now() - ownerStartedAt;
    const cachedSimulationOwner = cachedSimulationOwners.get(inputMint);
    if (!cachedSimulationOwner) throw new Error('readonly_simulation_owner_unavailable');
    const simulationPublicKey = cachedSimulationOwner.public_key;
    const prepareStartedAt = Date.now();
    const [buyPrepared, sellPrepared] = await Promise.all([
      buyService.prepareUnsignedLeg(buyQuote, { simulationPublicKey }),
      sellService.prepareUnsignedLeg(sellQuote, { simulationPublicKey })
    ]);
    const prepare_latency_ms = Date.now() - prepareStartedAt;
    const result = await observePreparedRoundTrip({ buyPrepared, sellPrepared });
    return Object.freeze({
      ...result,
      simulation_owner_source: cachedSimulationOwner.source,
      simulation_owner_address_exposed: false,
      simulation_owner_latency_ms,
      prepare_latency_ms,
      total_observe_latency_ms: Date.now() - observeStartedAt
    });
  }

  return Object.freeze({
    observe,
    observePreparedRoundTrip,
    warmSimulationOwner,
    safety: Object.freeze({
      read_only: true,
      atomic_build_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    })
  });
}

export const createNativeRoundTripSimulationService = createNativeRoundtripSimulationService;