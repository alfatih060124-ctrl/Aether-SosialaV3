import crypto from 'node:crypto';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function normalizeLeg(raw, expectedDex, expectedSide) {
  if (!raw || typeof raw !== 'object') throw new Error('unsigned_message_leg_required');
  const dex = text(raw.dex, 'unsigned_message_leg_dex_required').toUpperCase();
  const side = text(raw.side, 'unsigned_message_leg_side_required').toUpperCase();
  if (dex !== expectedDex) throw new Error('unsigned_message_leg_dex_invalid');
  if (side !== expectedSide) throw new Error('unsigned_message_leg_side_invalid');
  if (raw.verified !== true) throw new Error('unsigned_message_leg_unverified');
  if (raw.transaction_building_authorized === true || raw.signer_requested === true || raw.network_submission_authorized === true) {
    throw new Error('unsigned_message_leg_safety_boundary_violation');
  }
  const poolAddress = text(raw.pool_address, 'unsigned_message_leg_pool_required');
  const tokenMint = text(raw.token_mint, 'unsigned_message_leg_token_mint_required');
  const quoteMint = text(raw.quote_mint, 'unsigned_message_leg_quote_mint_required');
  const sourceReference = text(raw.source_reference, 'unsigned_message_leg_source_reference_required');
  const accountKeys = Array.isArray(raw.account_keys) ? raw.account_keys.map(value => text(value, 'unsigned_message_account_key_invalid')) : [];
  if (!accountKeys.length) throw new Error('unsigned_message_account_keys_required');
  const instructions = Array.isArray(raw.instructions) ? raw.instructions : [];
  if (!instructions.length) throw new Error('unsigned_message_instructions_required');
  const normalizedInstructions = instructions.map((instruction, index) => {
    if (!instruction || typeof instruction !== 'object') throw new Error('unsigned_message_instruction_invalid');
    return Object.freeze({
      index,
      program_id: text(instruction.program_id, 'unsigned_message_instruction_program_required'),
      accounts: Array.isArray(instruction.accounts) ? instruction.accounts.map(value => text(value, 'unsigned_message_instruction_account_invalid')) : [],
      data_base64: text(instruction.data_base64, 'unsigned_message_instruction_data_required')
    });
  });
  return Object.freeze({ dex, side, pool_address: poolAddress, token_mint: tokenMint, quote_mint: quoteMint, source_reference: sourceReference, account_keys: Object.freeze(accountKeys), instructions: Object.freeze(normalizedInstructions) });
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
      if (opportunity?.live_execution_authorized === true) throw new Error('unsigned_message_live_boundary_violation');
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
      const accountKeys = [...new Set([...buy.account_keys, ...sell.account_keys])];
      const payload = {
        version: 1,
        strategy: 'TWO_LEG_ARBITRAGE',
        buy_dex: buy.dex,
        sell_dex: sell.dex,
        token_mint: buy.token_mint,
        quote_mint: buy.quote_mint,
        recent_blockhash: blockhash,
        source_slot: slot,
        account_keys: accountKeys,
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
        account_keys: Object.freeze(accountKeys),
        instructions: Object.freeze(payload.instructions),
        buy_leg: buy,
        sell_leg: sell,
        transaction_signed: false,
        signer_requested: false,
        private_key_present: false,
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
  private_key_allowed: false,
  signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
