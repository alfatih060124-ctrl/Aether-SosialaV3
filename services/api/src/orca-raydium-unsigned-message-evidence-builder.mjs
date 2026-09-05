import crypto from 'node:crypto';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function normalizeAccountMeta(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('unsigned_message_account_meta_required');
  const pubkey = text(raw.pubkey, 'unsigned_message_account_pubkey_required');
  if (typeof raw.isSigner !== 'boolean') throw new Error('unsigned_message_account_signer_flag_required');
  if (typeof raw.isWritable !== 'boolean') throw new Error('unsigned_message_account_writable_flag_required');
  return Object.freeze({ pubkey, isSigner: raw.isSigner, isWritable: raw.isWritable });
}

function normalizeAccountMetas(values, code) {
  if (!Array.isArray(values) || !values.length) throw new Error(code);
  const metas = values.map(normalizeAccountMeta);
  const seen = new Map();
  for (const meta of metas) {
    const previous = seen.get(meta.pubkey);
    if (previous && (previous.isSigner !== meta.isSigner || previous.isWritable !== meta.isWritable)) {
      throw new Error('unsigned_message_account_privilege_conflict');
    }
    seen.set(meta.pubkey, meta);
  }
  return Object.freeze([...seen.values()]);
}

function normalizeLeg(raw, expectedDex, expectedSide) {
  if (!raw || typeof raw !== 'object') throw new Error('unsigned_message_leg_required');
  const dex = text(raw.dex, 'unsigned_message_leg_dex_required').toUpperCase();
  const side = text(raw.side, 'unsigned_message_leg_side_required').toUpperCase();
  if (dex !== expectedDex) throw new Error('unsigned_message_leg_dex_invalid');
  if (side !== expectedSide) throw new Error('unsigned_message_leg_side_invalid');
  if (raw.verified !== true) throw new Error('unsigned_message_leg_unverified');
  if (raw.transaction_building_authorized === true || raw.signer_requested === true || raw.network_submission_authorized === true || raw.private_key_present === true) {
    throw new Error('unsigned_message_leg_safety_boundary_violation');
  }
  const poolAddress = text(raw.pool_address, 'unsigned_message_leg_pool_required');
  const tokenMint = text(raw.token_mint, 'unsigned_message_leg_token_mint_required');
  const quoteMint = text(raw.quote_mint, 'unsigned_message_leg_quote_mint_required');
  const sourceReference = text(raw.source_reference, 'unsigned_message_leg_source_reference_required');
  const accountMetas = normalizeAccountMetas(raw.account_metas, 'unsigned_message_account_metas_required');
  const instructions = Array.isArray(raw.instructions) ? raw.instructions : [];
  if (!instructions.length) throw new Error('unsigned_message_instructions_required');
  const normalizedInstructions = instructions.map((instruction, index) => {
    if (!instruction || typeof instruction !== 'object') throw new Error('unsigned_message_instruction_invalid');
    const accounts = normalizeAccountMetas(instruction.accounts, 'unsigned_message_instruction_accounts_required');
    const declared = new Map(accountMetas.map(meta => [meta.pubkey, meta]));
    for (const meta of accounts) {
      const legMeta = declared.get(meta.pubkey);
      if (!legMeta) throw new Error('unsigned_message_instruction_account_undeclared');
      if (legMeta.isSigner !== meta.isSigner || legMeta.isWritable !== meta.isWritable) {
        throw new Error('unsigned_message_instruction_account_privilege_mismatch');
      }
    }
    return Object.freeze({
      index,
      program_id: text(instruction.program_id, 'unsigned_message_instruction_program_required'),
      accounts,
      data_base64: text(instruction.data_base64, 'unsigned_message_instruction_data_required')
    });
  });
  return Object.freeze({
    dex,
    side,
    pool_address: poolAddress,
    token_mint: tokenMint,
    quote_mint: quoteMint,
    source_reference: sourceReference,
    account_metas: accountMetas,
    instructions: Object.freeze(normalizedInstructions)
  });
}

function mergeAccountMetas(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const meta of group) {
      const previous = merged.get(meta.pubkey);
      if (previous && (previous.isSigner !== meta.isSigner || previous.isWritable !== meta.isWritable)) {
        throw new Error('unsigned_message_account_privilege_conflict');
      }
      merged.set(meta.pubkey, meta);
    }
  }
  return Object.freeze([...merged.values()]);
}

function hashEvidence(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createOrcaRaydiumUnsignedMessageEvidenceBuilder({ buildBuyLeg, buildSellLeg, loadRecentBlockhash, now = () => Date.now() } = {}) {
  if (typeof buildBuyLeg !== 'function') throw new Error('unsigned_message_buy_leg_builder_required');
  if (typeof buildSellLeg !== 'function') throw new Error('unsigned_message_sell_leg_builder_required');
  if (typeof loadRecentBlockhash !== 'function') throw new Error('unsigned_message_blockhash_loader_required');

  return Object.freeze({
    async build(opportunity = {}) {
      if (opportunity?.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('unsigned_message_strategy_invalid');
      if (opportunity?.read_only !== true) throw new Error('unsigned_message_read_only_required');
      if (opportunity?.live_execution_authorized === true || opportunity?.private_key_present === true || opportunity?.signature_present === true) {
        throw new Error('unsigned_message_live_boundary_violation');
      }
      const buyDex = text(opportunity.buy_dex, 'unsigned_message_buy_dex_required').toUpperCase();
      const sellDex = text(opportunity.sell_dex, 'unsigned_message_sell_dex_required').toUpperCase();
      if (!['ORCA', 'RAYDIUM'].includes(buyDex) || !['ORCA', 'RAYDIUM'].includes(sellDex) || buyDex === sellDex) {
        throw new Error('unsigned_message_cross_dex_required');
      }

      const [buyRaw, sellRaw, blockhashRaw] = await Promise.all([
        buildBuyLeg(Object.freeze({ ...opportunity, read_only: true, unsigned_only: true })),
        buildSellLeg(Object.freeze({ ...opportunity, read_only: true, unsigned_only: true })),
        loadRecentBlockhash(Object.freeze({ read_only: true, strategy: 'TWO_LEG_ARBITRAGE' }))
      ]);
      const buy = normalizeLeg(buyRaw, buyDex, 'BUY');
      const sell = normalizeLeg(sellRaw, sellDex, 'SELL');
      if (buy.token_mint !== sell.token_mint || buy.quote_mint !== sell.quote_mint) throw new Error('unsigned_message_pair_mismatch');
      if (!blockhashRaw || typeof blockhashRaw !== 'object' || blockhashRaw.verified !== true) throw new Error('unsigned_message_blockhash_unverified');
      const blockhash = text(blockhashRaw.blockhash, 'unsigned_message_blockhash_required');
      const slot = Number(blockhashRaw.slot);
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('unsigned_message_blockhash_slot_required');
      const observedAt = new Date(now()).toISOString();
      const accountMetas = mergeAccountMetas(buy.account_metas, sell.account_metas);
      const payload = {
        version: 2,
        strategy: 'TWO_LEG_ARBITRAGE',
        buy_dex: buy.dex,
        sell_dex: sell.dex,
        token_mint: buy.token_mint,
        quote_mint: buy.quote_mint,
        recent_blockhash: blockhash,
        source_slot: slot,
        account_metas: accountMetas,
        instructions: [...buy.instructions, ...sell.instructions],
        leg_sources: [buy.source_reference, sell.source_reference]
      };
      const messageHash = hashEvidence(payload);
      return Object.freeze({
        verified: true,
        unsigned: true,
        message_hash: messageHash,
        source_reference: `UNSIGNED_TWO_LEG_MESSAGE:${messageHash}`,
        observed_at: observedAt,
        source_slot: slot,
        recent_blockhash: blockhash,
        account_metas: accountMetas,
        account_keys: Object.freeze(accountMetas.map(meta => meta.pubkey)),
        instructions: Object.freeze(payload.instructions),
        buy_leg: buy,
        sell_leg: sell,
        transaction_signed: false,
        signer_requested: false,
        private_key_present: false,
        signature_present: false,
        transaction_building_authorized: false,
        network_submission_authorized: false,
        live_execution_authorized: false,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      });
    }
  });
}

export const ORCA_RAYDIUM_UNSIGNED_MESSAGE_EVIDENCE_BUILDER = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  unsigned_only: true,
  account_meta_contract: 'pubkey+isSigner+isWritable',
  private_key_allowed: false,
  signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
