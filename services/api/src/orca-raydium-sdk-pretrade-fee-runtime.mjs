import {
  createOrcaSdkInstructionEvidenceBuilder,
  createRaydiumSdkInstructionEvidenceBuilder
} from './orca-raydium-sdk-instruction-evidence-builder.mjs';
import { createOrcaRaydiumUnsignedMessageEvidenceBuilder } from './orca-raydium-unsigned-message-evidence-builder.mjs';
import { createSolanaPretradeFeePipeline } from './solana-pretrade-fee-pipeline.mjs';

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

export function createOrcaRaydiumSdkPretradeFeeRuntime({
  resolveLegRequest,
  loadRecentBlockhash,
  feePayer,
  rpcEvidenceProvider,
  orcaInstructionBuilder,
  raydiumInstructionBuilder,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (typeof resolveLegRequest !== 'function') throw new Error('sdk_pretrade_leg_request_resolver_required');
  if (typeof loadRecentBlockhash !== 'function') throw new Error('sdk_pretrade_blockhash_loader_required');

  const buildOrca = orcaInstructionBuilder || createOrcaSdkInstructionEvidenceBuilder();
  const buildRaydium = raydiumInstructionBuilder || createRaydiumSdkInstructionEvidenceBuilder();
  if (typeof buildOrca !== 'function' || typeof buildRaydium !== 'function') throw new Error('sdk_pretrade_instruction_builders_required');

  const buildLeg = side => async opportunity => {
    if (opportunity?.read_only !== true) throw new Error('sdk_pretrade_read_only_required');
    if (opportunity?.live_execution_authorized === true || opportunity?.private_key_present === true || opportunity?.signature_present === true) {
      throw new Error('sdk_pretrade_live_boundary_violation');
    }
    const dex = text(opportunity?.[`${side.toLowerCase()}_dex`], `sdk_pretrade_${side.toLowerCase()}_dex_required`).toUpperCase();
    if (!['ORCA', 'RAYDIUM'].includes(dex)) throw new Error('sdk_pretrade_dex_unsupported');

    const resolved = await resolveLegRequest(Object.freeze({
      opportunity,
      side,
      dex,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE'
    }));
    if (!resolved || typeof resolved !== 'object') throw new Error('sdk_pretrade_leg_request_required');

    const request = Object.freeze({
      ...resolved,
      side,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE',
      private_key_present: false,
      signature_present: false,
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
    return dex === 'ORCA' ? buildOrca(request) : buildRaydium(request);
  };

  const unsignedEvidenceBuilder = createOrcaRaydiumUnsignedMessageEvidenceBuilder({
    buildBuyLeg: buildLeg('BUY'),
    buildSellLeg: buildLeg('SELL'),
    loadRecentBlockhash,
    now
  });

  const pretradeFeePipeline = createSolanaPretradeFeePipeline({
    loadUnsignedInstructionEvidence: context => unsignedEvidenceBuilder.build(Object.freeze({
      ...context,
      read_only: true,
      strategy: 'TWO_LEG_ARBITRAGE',
      live_execution_authorized: false
    })),
    feePayer,
    rpcEvidenceProvider,
    now,
    maxEvidenceAgeMs
  });

  return Object.freeze({
    async estimate(opportunity = {}) {
      if (opportunity?.read_only !== true) throw new Error('sdk_pretrade_read_only_required');
      if (opportunity?.live_execution_authorized === true) throw new Error('sdk_pretrade_live_boundary_violation');
      return pretradeFeePipeline.estimate(Object.freeze({
        ...opportunity,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE',
        live_execution_authorized: false
      }));
    }
  });
}

export const ORCA_RAYDIUM_SDK_PRETRADE_FEE_RUNTIME = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  resolves_leg_accounts_explicitly: true,
  builds_program_instructions: true,
  compiles_unsigned_transaction: true,
  simulates_unsigned_transaction: true,
  private_key_allowed: false,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
