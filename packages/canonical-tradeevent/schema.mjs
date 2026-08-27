export const CANONICAL_TRADE_EVENT_VERSION = '1.0';

export function validateCanonicalTradeEvent(event) {
  const required = ['event_id','chain','dex','trader_wallet','token_in','token_out','amount_in_raw','amount_out_raw','tx_hash','slot','confidence','observed_at','decoder_version'];
  const missing = required.filter((key) => event?.[key] === undefined || event?.[key] === null || event?.[key] === '');
  if (missing.length) return { valid: false, errors: missing.map((key) => `MISSING_${key.toUpperCase()}`) };
  if (event.chain !== 'solana') return { valid: false, errors: ['UNSUPPORTED_CHAIN'] };
  if (!Number.isInteger(Number(event.slot)) || Number(event.slot) < 0) return { valid: false, errors: ['INVALID_SLOT'] };
  if (!(Number(event.confidence) >= 0 && Number(event.confidence) <= 1)) return { valid: false, errors: ['INVALID_CONFIDENCE'] };
  if (!(Number(event.amount_in_raw) >= 0) || !(Number(event.amount_out_raw) >= 0)) return { valid: false, errors: ['INVALID_RAW_AMOUNT'] };
  return { valid: true, errors: [] };
}
