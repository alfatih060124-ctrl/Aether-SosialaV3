const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const safeInt = (value, code, min = 0) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(code);
  return n;
};

function assertBoundary(request) {
  if (!request || typeof request !== 'object') throw new Error('sdk_instruction_request_required');
  if (request.read_only !== true || request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('sdk_instruction_context_invalid');
  if (request.private_key_present === true || request.signature_present === true || request.transaction_signed === true || request.signer_requested === true) {
    throw new Error('sdk_instruction_signing_boundary_violation');
  }
  if (request.network_submission_authorized === true || request.live_execution_authorized === true) {
    throw new Error('sdk_instruction_live_boundary_violation');
  }
}

function normalizeWeb3Instruction(instruction, dex) {
  if (!instruction || typeof instruction !== 'object' || !instruction.programId || !Array.isArray(instruction.keys)) {
    throw new Error(`${dex}_instruction_invalid`);
  }
  return Object.freeze({
    program_id: instruction.programId.toBase58(),
    accounts: Object.freeze(instruction.keys.map(meta => Object.freeze({
      pubkey: meta.pubkey.toBase58(),
      isSigner: Boolean(meta.isSigner),
      isWritable: Boolean(meta.isWritable)
    }))),
    data_base64: Buffer.from(instruction.data || []).toString('base64')
  });
}

function kitRole(role) {
  const n = Number(role);
  if (![0, 1, 2, 3].includes(n)) throw new Error('orca_instruction_account_role_invalid');
  return Object.freeze({ isSigner: n === 2 || n === 3, isWritable: n === 1 || n === 3 });
}

function normalizeKitInstruction(instruction) {
  if (!instruction || typeof instruction !== 'object' || !instruction.programAddress || !Array.isArray(instruction.accounts)) {
    throw new Error('orca_instruction_invalid');
  }
  return Object.freeze({
    program_id: String(instruction.programAddress),
    accounts: Object.freeze(instruction.accounts.map(meta => {
      const role = kitRole(meta.role);
      return Object.freeze({ pubkey: String(meta.address), ...role });
    })),
    data_base64: Buffer.from(instruction.data || []).toString('base64')
  });
}

function legResult({ dex, request, instruction, sourceReference }) {
  const accountKeys = [];
  const seen = new Set();
  for (const meta of instruction.accounts) {
    if (!seen.has(meta.pubkey)) {
      seen.add(meta.pubkey);
      accountKeys.push(meta.pubkey);
    }
  }
  if (!seen.has(instruction.program_id)) accountKeys.push(instruction.program_id);
  return Object.freeze({
    dex,
    side: text(request.side, 'sdk_instruction_side_required').toUpperCase(),
    pool_address: text(request.pool_address, 'sdk_instruction_pool_required'),
    token_mint: text(request.token_mint, 'sdk_instruction_token_mint_required'),
    quote_mint: text(request.quote_mint, 'sdk_instruction_quote_mint_required'),
    source_reference: sourceReference,
    source_slot: safeInt(request.source_slot, 'sdk_instruction_source_slot_required', 1),
    observed_at: text(request.observed_at, 'sdk_instruction_observed_at_required'),
    account_keys: Object.freeze(accountKeys),
    instructions: Object.freeze([instruction]),
    verified: true,
    unsigned: true,
    transaction_signed: false,
    signer_requested: false,
    private_key_present: false,
    signature_present: false,
    transaction_building_authorized: true,
    transaction_signing_authorized: false,
    network_submission_authorized: false,
    live_execution_authorized: false,
    read_only: true,
    strategy: 'TWO_LEG_ARBITRAGE'
  });
}

async function loadOrcaModules() {
  const [client, kit] = await Promise.all([import('@orca-so/whirlpools-client'), import('@solana/kit')]);
  return { client, kit };
}

async function loadRaydiumModules() {
  const [sdk, web3, bnModule] = await Promise.all([
    import('@raydium-io/raydium-sdk-v2'),
    import('@solana/web3.js'),
    import('bn.js')
  ]);
  return { sdk, PublicKey: web3.PublicKey, BN: bnModule.default || bnModule.BN || bnModule };
}

export function createOrcaSdkInstructionEvidenceBuilder({ moduleLoader = loadOrcaModules } = {}) {
  return async function build(request = {}) {
    assertBoundary(request);
    const { client, kit } = await moduleLoader();
    if (typeof client?.getSwapInstruction !== 'function' || typeof kit?.address !== 'function') throw new Error('orca_swap_instruction_sdk_required');

    const authorityAddress = kit.address(text(request.token_authority, 'orca_instruction_authority_required'));
    let signingCallbackInvoked = false;
    const markerSigner = Object.freeze({
      address: authorityAddress,
      async signTransactions() {
        signingCallbackInvoked = true;
        throw new Error('orca_instruction_signing_forbidden');
      }
    });

    const instruction = client.getSwapInstruction({
      tokenProgram: request.token_program ? kit.address(request.token_program) : undefined,
      tokenAuthority: markerSigner,
      whirlpool: kit.address(text(request.pool_address, 'orca_instruction_pool_required')),
      tokenOwnerAccountA: kit.address(text(request.token_owner_account_a, 'orca_instruction_owner_a_required')),
      tokenVaultA: kit.address(text(request.token_vault_a, 'orca_instruction_vault_a_required')),
      tokenOwnerAccountB: kit.address(text(request.token_owner_account_b, 'orca_instruction_owner_b_required')),
      tokenVaultB: kit.address(text(request.token_vault_b, 'orca_instruction_vault_b_required')),
      tickArray0: kit.address(text(request.tick_array_0, 'orca_instruction_tick0_required')),
      tickArray1: kit.address(text(request.tick_array_1, 'orca_instruction_tick1_required')),
      tickArray2: kit.address(text(request.tick_array_2, 'orca_instruction_tick2_required')),
      oracle: kit.address(text(request.oracle, 'orca_instruction_oracle_required')),
      amount: BigInt(text(request.amount, 'orca_instruction_amount_required')),
      otherAmountThreshold: BigInt(text(request.other_amount_threshold, 'orca_instruction_threshold_required')),
      sqrtPriceLimit: BigInt(text(request.sqrt_price_limit, 'orca_instruction_sqrt_limit_required')),
      amountSpecifiedIsInput: request.amount_specified_is_input === true,
      aToB: request.a_to_b === true
    });
    if (signingCallbackInvoked) throw new Error('orca_instruction_signing_callback_invoked');

    const normalized = normalizeKitInstruction(instruction);
    const authorityMeta = normalized.accounts.find(meta => meta.pubkey === String(authorityAddress));
    if (!authorityMeta?.isSigner) throw new Error('orca_instruction_authority_signer_role_required');
    return legResult({
      dex: 'ORCA',
      request,
      instruction: normalized,
      sourceReference: `ORCA_WHIRLPOOLS_CLIENT_SWAP:${normalized.program_id}:${request.source_slot}`
    });
  };
}

export function createRaydiumSdkInstructionEvidenceBuilder({ moduleLoader = loadRaydiumModules } = {}) {
  return async function build(request = {}) {
    assertBoundary(request);
    const { sdk, PublicKey, BN } = await moduleLoader();
    if (typeof PublicKey !== 'function' || typeof BN !== 'function') throw new Error('raydium_instruction_runtime_required');
    const pk = (value, code) => new PublicKey(text(value, code));
    const bn = (value, code) => new BN(text(value, code));
    const poolType = text(request.pool_type, 'raydium_instruction_pool_type_required').toUpperCase();
    let instruction;

    if (poolType === 'CPMM') {
      if (typeof sdk?.makeSwapCpmmBaseInInstruction !== 'function') throw new Error('raydium_cpmm_instruction_builder_required');
      instruction = sdk.makeSwapCpmmBaseInInstruction(
        pk(request.program_id, 'raydium_instruction_program_required'),
        pk(request.payer, 'raydium_instruction_payer_required'),
        pk(request.authority, 'raydium_instruction_authority_required'),
        pk(request.config_id, 'raydium_instruction_config_required'),
        pk(request.pool_address, 'raydium_instruction_pool_required'),
        pk(request.user_input_account, 'raydium_instruction_user_input_required'),
        pk(request.user_output_account, 'raydium_instruction_user_output_required'),
        pk(request.input_vault, 'raydium_instruction_input_vault_required'),
        pk(request.output_vault, 'raydium_instruction_output_vault_required'),
        pk(request.input_token_program, 'raydium_instruction_input_program_required'),
        pk(request.output_token_program, 'raydium_instruction_output_program_required'),
        pk(request.input_mint, 'raydium_instruction_input_mint_required'),
        pk(request.output_mint, 'raydium_instruction_output_mint_required'),
        pk(request.observation_id, 'raydium_instruction_observation_required'),
        bn(request.amount_in, 'raydium_instruction_amount_in_required'),
        bn(request.amount_out_min, 'raydium_instruction_amount_out_min_required')
      );
    } else if (poolType === 'CLMM') {
      if (typeof sdk?.ClmmInstrument?.swapV2Instruction !== 'function') throw new Error('raydium_clmm_instruction_builder_required');
      const tickArrays = Array.isArray(request.tick_arrays) ? request.tick_arrays.map(v => pk(v, 'raydium_instruction_tick_array_invalid')) : [];
      if (!tickArrays.length) throw new Error('raydium_instruction_tick_arrays_required');
      instruction = sdk.ClmmInstrument.swapV2Instruction(
        pk(request.program_id, 'raydium_instruction_program_required'),
        pk(request.payer, 'raydium_instruction_payer_required'),
        pk(request.pool_address, 'raydium_instruction_pool_required'),
        pk(request.amm_config, 'raydium_instruction_amm_config_required'),
        pk(request.user_input_account, 'raydium_instruction_user_input_required'),
        pk(request.user_output_account, 'raydium_instruction_user_output_required'),
        pk(request.input_vault, 'raydium_instruction_input_vault_required'),
        pk(request.output_vault, 'raydium_instruction_output_vault_required'),
        pk(request.input_mint, 'raydium_instruction_input_mint_required'),
        pk(request.output_mint, 'raydium_instruction_output_mint_required'),
        tickArrays,
        pk(request.observation_id, 'raydium_instruction_observation_required'),
        bn(request.amount_in, 'raydium_instruction_amount_in_required'),
        bn(request.amount_out_min, 'raydium_instruction_amount_out_min_required'),
        bn(request.sqrt_price_limit_x64 || '0', 'raydium_instruction_sqrt_limit_required'),
        true,
        request.tick_array_bitmap_extension ? pk(request.tick_array_bitmap_extension, 'raydium_instruction_bitmap_invalid') : undefined
      );
    } else {
      throw new Error('raydium_instruction_pool_type_unsupported');
    }

    const normalized = normalizeWeb3Instruction(instruction, 'raydium');
    const payer = text(request.payer, 'raydium_instruction_payer_required');
    const payerMeta = normalized.accounts.find(meta => meta.pubkey === payer);
    if (!payerMeta?.isSigner) throw new Error('raydium_instruction_payer_signer_role_required');
    return legResult({
      dex: 'RAYDIUM',
      request,
      instruction: normalized,
      sourceReference: `RAYDIUM_${poolType}_SDK_INSTRUCTION:${normalized.program_id}:${request.source_slot}`
    });
  };
}

export const ORCA_RAYDIUM_SDK_INSTRUCTION_EVIDENCE_BUILDER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  supported: Object.freeze(['ORCA_WHIRLPOOL', 'RAYDIUM_CPMM', 'RAYDIUM_CLMM']),
  builds_program_instruction_only: true,
  private_key_allowed: false,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
