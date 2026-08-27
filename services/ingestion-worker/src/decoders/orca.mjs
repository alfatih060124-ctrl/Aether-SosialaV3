import { createDecoder } from '../decoder-interface.mjs';
import { reconcileNetBalanceChanges } from '../reconciliation.mjs';

export const orcaDecoder = createDecoder({
  name: 'orca',
  version: 'versioned-adapter-v1',
  match: (tx) => tx?.metadata?.dex === 'orca' && typeof tx?.metadata?.program_id === 'string',
  decode: (tx) => {
    const trade = tx?.metadata?.trade;
    if (!trade || trade.dex_version == null) return [];
    const reconciliation = reconcileNetBalanceChanges(trade);
    if (!reconciliation.ok) return [];
    return [{
      event_id: trade.event_id,
      chain: 'solana', dex: 'orca', trader_wallet: trade.trader_wallet,
      token_in: trade.tokenIn, token_out: trade.tokenOut,
      amount_in_raw: reconciliation.amount_in_raw, amount_out_raw: reconciliation.amount_out_raw,
      amount_usd: trade.amount_usd ?? null, tx_hash: tx.signature, slot: tx.slot,
      slippage_bps: trade.slippage_bps ?? null, confidence: trade.confidence ?? 0,
      observed_at: new Date().toISOString(), decoder_version: `orca-${trade.dex_version}`
    }];
  }
});
