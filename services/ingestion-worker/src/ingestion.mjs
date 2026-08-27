export function createIngestionProcessor({ fetchTransaction, decoderRegistry, emitTradeEvent }) {
  return async function processSignature(signature) {
    const tx = await fetchTransaction(signature);
    if (!tx) return { status: 'IGNORED', reason: 'TRANSACTION_NOT_FOUND' };

    const candidates = decoderRegistry.flatMap(decoder => {
      try { return decoder.decode(tx) || []; }
      catch { return []; }
    });

    if (candidates.length !== 1) {
      return { status: 'REJECTED', reason: candidates.length === 0 ? 'NO_DECODER_MATCH' : 'AMBIGUOUS_DECODER_MATCH' };
    }

    const event = candidates[0];
    if (!event.event_id || !event.tx_hash || !event.trader_wallet) {
      return { status: 'REJECTED', reason: 'INVALID_CANONICAL_EVENT' };
    }

    await emitTradeEvent(event);
    return { status: 'EMITTED', event_id: event.event_id };
  };
}
