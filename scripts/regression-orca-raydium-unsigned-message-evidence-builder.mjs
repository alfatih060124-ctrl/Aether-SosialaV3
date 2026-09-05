import assert from 'node:assert/strict';
import { createOrcaRaydiumUnsignedMessageEvidenceBuilder } from '../services/api/src/orca-raydium-unsigned-message-evidence-builder.mjs';

const opportunity = Object.freeze({
  strategy: 'TWO_LEG_ARBITRAGE',
  read_only: true,
  live_execution_authorized: false,
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  token_mint: 'TokenMint1111111111111111111111111111111111',
  quote_mint: 'QuoteMint1111111111111111111111111111111111'
});

const leg = (dex, side, pool, source) => Object.freeze({
  dex,
  side,
  pool_address: pool,
  token_mint: opportunity.token_mint,
  quote_mint: opportunity.quote_mint,
  source_reference: source,
  verified: true,
  transaction_building_authorized: false,
  signer_requested: false,
  network_submission_authorized: false,
  account_keys: [`${dex}-program`, `${dex}-pool`, 'shared-user-token-account'],
  instructions: [{ program_id: `${dex}-program`, accounts: [`${dex}-pool`, 'shared-user-token-account'], data_base64: 'AQID' }]
});

const builder = createOrcaRaydiumUnsignedMessageEvidenceBuilder({
  buildBuyLeg: async () => leg('ORCA', 'BUY', 'OrcaPool', 'ORCA:slot:100'),
  buildSellLeg: async () => leg('RAYDIUM', 'SELL', 'RaydiumPool', 'RAYDIUM:slot:100'),
  loadRecentBlockhash: async () => ({ verified: true, blockhash: 'RecentBlockhash111111111111111111111111111111', slot: 100 }),
  now: () => Date.parse('2026-09-05T16:50:00.000Z')
});

const evidence = await builder.build(opportunity);
assert.equal(evidence.verified, true);
assert.equal(evidence.unsigned, true);
assert.equal(evidence.transaction_signed, false);
assert.equal(evidence.signer_requested, false);
assert.equal(evidence.private_key_present, false);
assert.equal(evidence.network_submission_authorized, false);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(evidence.source_slot, 100);
assert.equal(evidence.account_keys.length, 5);
assert.equal(evidence.instructions.length, 2);
assert.match(evidence.message_hash, /^[a-f0-9]{64}$/);
assert.equal(evidence.source_reference, `UNSIGNED_TWO_LEG_MESSAGE:${evidence.message_hash}`);

await assert.rejects(() => builder.build({ ...opportunity, buy_dex: 'ORCA', sell_dex: 'ORCA' }), /unsigned_message_cross_dex_required/);

const unsafe = createOrcaRaydiumUnsignedMessageEvidenceBuilder({
  buildBuyLeg: async () => ({ ...leg('ORCA', 'BUY', 'OrcaPool', 'ORCA:slot:100'), signer_requested: true }),
  buildSellLeg: async () => leg('RAYDIUM', 'SELL', 'RaydiumPool', 'RAYDIUM:slot:100'),
  loadRecentBlockhash: async () => ({ verified: true, blockhash: 'RecentBlockhash111111111111111111111111111111', slot: 100 })
});
await assert.rejects(() => unsafe.build(opportunity), /unsigned_message_leg_safety_boundary_violation/);

const mismatch = createOrcaRaydiumUnsignedMessageEvidenceBuilder({
  buildBuyLeg: async () => leg('ORCA', 'BUY', 'OrcaPool', 'ORCA:slot:100'),
  buildSellLeg: async () => ({ ...leg('RAYDIUM', 'SELL', 'RaydiumPool', 'RAYDIUM:slot:100'), token_mint: 'DifferentMint11111111111111111111111111111111' }),
  loadRecentBlockhash: async () => ({ verified: true, blockhash: 'RecentBlockhash111111111111111111111111111111', slot: 100 })
});
await assert.rejects(() => mismatch.build(opportunity), /unsigned_message_pair_mismatch/);

console.log('orca raydium unsigned message evidence builder regression ok');
