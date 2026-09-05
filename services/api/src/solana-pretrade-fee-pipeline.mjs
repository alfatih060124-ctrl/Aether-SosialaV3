import { createSolanaUnsignedMessageCompiler } from './solana-unsigned-message-compiler.mjs';
import { createSolanaPretradeNetworkFeeEstimator } from './solana-pretrade-network-fee-estimator.mjs';

export function createSolanaPretradeFeePipeline({
  loadUnsignedInstructionEvidence,
  feePayer,
  rpcEvidenceProvider,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (typeof loadUnsignedInstructionEvidence !== 'function') throw new Error('pretrade_pipeline_unsigned_instruction_loader_required');
  if (!rpcEvidenceProvider || typeof rpcEvidenceProvider !== 'object') throw new Error('pretrade_pipeline_rpc_provider_required');
  for (const name of ['getFeeForMessage', 'simulateUnsignedTransaction', 'loadPriorityFeeEvidence', 'loadCurrentSolUsdEvidence']) {
    if (typeof rpcEvidenceProvider[name] !== 'function') throw new Error(`pretrade_pipeline_rpc_${name}_required`);
  }

  const compiler = createSolanaUnsignedMessageCompiler();

  const estimator = createSolanaPretradeNetworkFeeEstimator({
    now,
    maxEvidenceAgeMs,
    loadUnsignedMessageEvidence: async context => {
      const instructionEvidence = await loadUnsignedInstructionEvidence(Object.freeze({
        ...context,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      }));
      const compiled = compiler.compile(instructionEvidence, { feePayer });
      return Object.freeze({
        ...compiled,
        verified: true,
        unsigned: true,
        signed: false,
        signer_requested: false,
        private_key_present: false,
        signature_present: false,
        network_submission_authorized: false,
        live_execution_authorized: false,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      });
    },
    getFeeForMessage: ({ message_base64, source_slot, context }) => rpcEvidenceProvider.getFeeForMessage(Object.freeze({
      message_base64,
      source_slot,
      context
    })),
    simulateUnsignedTransaction: ({ transaction_base64, source_slot, context }) => rpcEvidenceProvider.simulateUnsignedTransaction(Object.freeze({
      transaction_base64,
      source_slot,
      context
    })),
    loadPriorityFeeEvidence: context => rpcEvidenceProvider.loadPriorityFeeEvidence(Object.freeze({ ...context })),
    loadCurrentSolUsdEvidence: context => rpcEvidenceProvider.loadCurrentSolUsdEvidence(Object.freeze({ ...context }))
  });

  return Object.freeze({
    async estimate(context = {}) {
      if (context?.live_execution_authorized === true) throw new Error('pretrade_pipeline_live_boundary_violation');
      if (context?.read_only !== true) throw new Error('pretrade_pipeline_read_only_required');
      return estimator.estimate(Object.freeze({
        ...context,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      }));
    }
  });
}

export const SOLANA_PRETRADE_FEE_PIPELINE = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  compiles_unsigned_message: true,
  transaction_signing_authorized: false,
  private_key_allowed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
