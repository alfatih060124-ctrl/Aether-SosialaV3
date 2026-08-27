const REJECT = Object.freeze({ APPROVED: false });

export function evaluateRisk({
  event,
  trader,
  policy,
  portfolio = {},
  circuitBreakerActive = false,
  now = Date.now()
}) {
  const rejects = [];
  if (!event) rejects.push('MISSING_EVENT');
  if (event && event.observed_at && now - Date.parse(event.observed_at) > Number(process.env.MAX_EVENT_AGE_MS || 30000)) rejects.push('STALE_EVENT');
  if (event && Number(event.confidence) < Number(process.env.MIN_DECODER_CONFIDENCE || 0.95)) rejects.push('LOW_PARSER_CONFIDENCE');
  if (trader && trader.reputation_score != null && Number(trader.reputation_score) < Number(process.env.MIN_TRADER_REPUTATION || 0)) rejects.push('LOW_TRADER_REPUTATION');
  if (trader && trader.drawdown_bps != null && Number(trader.drawdown_bps) > Number(process.env.MAX_TRADER_DRAWDOWN_BPS || 5000)) rejects.push('EXCESSIVE_TRADER_DRAWDOWN');
  if (event && event.slippage_bps != null && Number(event.slippage_bps) > Number(process.env.MAX_SLIPPAGE_BPS || 300)) rejects.push('EXCESSIVE_SLIPPAGE');
  if (policy && Number(policy.max_position_amount_usd) < Number(policy.requested_amount_usd || 0)) rejects.push('POSITION_LIMIT_EXCEEDED');
  if (policy && Number(policy.max_copy_amount_usd) < Number(policy.requested_amount_usd || 0)) rejects.push('COPY_LIMIT_EXCEEDED');
  if (portfolio.exposure_usd != null && policy?.max_position_amount_usd != null && Number(portfolio.exposure_usd) >= Number(policy.max_position_amount_usd)) rejects.push('FOLLOWER_EXPOSURE_LIMIT');
  if (event?.token_out && process.env.DENIED_TOKENS?.split(',').map(s => s.trim()).includes(event.token_out)) rejects.push('DENIED_TOKEN');
  if (circuitBreakerActive) rejects.push('CIRCUIT_BREAKER_ACTIVE');
  if (event?.duplicate === true) rejects.push('DUPLICATE_EVENT');

  return rejects.length ? { ...REJECT, decision: 'REJECTED', reason_codes: rejects } : { APPROVED: true, decision: 'APPROVED', reason_codes: [] };
}
